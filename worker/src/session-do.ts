import { DurableObject } from "cloudflare:workers";
import { connect } from "cloudflare:sockets";
import { isPrivateIP } from "./proxy";
import type { Env, SshErrorCode } from "./types";

import { initSync, SshSession, SshSessionBuilder, SshTransportFeeder, set_expected_host_key, take_accepted_host_key } from "zerossh-do";
// @ts-ignore — wasm binary import (Cloudflare Workers specific)
import wasmModule from "zerossh-do/zerossh_do_bg.wasm";

// Initialize WASM synchronously at module load time
initSync({ module: wasmModule });

function errorResponse(code: SshErrorCode, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function classifySshError(err: unknown): { code: SshErrorCode; message: string } {
  const msg = String(err);
  if (msg.includes("Authentication rejected") || msg.includes("Auth failed")) {
    return { code: "auth_failed", message: msg };
  }
  if (msg.includes("host_key_mismatch")) {
    return { code: "host_key_mismatch", message: msg };
  }
  if (msg.includes("Connection refused") || msg.includes("connection refused")) {
    return { code: "connection_refused", message: msg };
  }
  if (msg.includes("timed out") || msg.includes("Timed out")) {
    return { code: "timeout", message: msg };
  }
  return { code: "unknown", message: msg };
}

interface ConnectRequest {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  credential: string;
  passphrase: string;
  cols: number;
  rows: number;
  userId: string;
  sessionId: string;
  expectedHostKey?: string;
}

const CONNECT_TIMEOUT_MS = 20_000;

export class SshSessionDO extends DurableObject<Env> {
  private session: SshSession | null = null;
  private tcpSocket: Socket | null = null;
  private clients: Set<WebSocket> = new Set();
  private terminalBuffer: Uint8Array[] = [];
  private bufferSize = 0;
  private maxBuffer = 100 * 1024;
  private sessionMeta: {
    userId: string;
    host: string;
    port: number;
    username: string;
    sessionId: string;
  } | null = null;
  private idleTimeout = 30 * 60 * 1000; // 30 min

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/connect" && request.method === "POST") {
      return this.handleConnect(request);
    }
    if (url.pathname === "/ws") {
      return this.handleWebSocket(request);
    }
    if (url.pathname === "/status") {
      return Response.json({ connected: this.session?.is_connected() ?? false });
    }
    if (request.method === "DELETE") {
      await this.terminate();
      return new Response("OK");
    }
    return new Response("Not found", { status: 404 });
  }

  private async handleConnect(request: Request): Promise<Response> {
    const body = (await request.json()) as ConnectRequest;
    console.log(`[do] handleConnect: ${body.username}@${body.host}:${body.port}`);

    if (isPrivateIP(body.host)) {
      return errorResponse("private_ip_denied", "Connection to private IP denied", 403);
    }

    if (!body.port || body.port < 1 || body.port > 65535) {
      return errorResponse("invalid_port", "Invalid port", 400);
    }

    // Open TCP connection
    let tcpSocket: Socket;
    try {
      tcpSocket = connect({ hostname: body.host, port: body.port });
    } catch (e) {
      const { code, message } = classifySshError(e);
      return errorResponse(code, `TCP connect failed: ${message}`, 502);
    }
    this.tcpSocket = tcpSocket;

    // TCP writer for the WASM on_write callback
    const tcpWriter = tcpSocket.writable.getWriter();

    const onWrite = (data: Uint8Array) => {
      tcpWriter.write(data).catch((err: unknown) => {
        console.error("[do] TCP write error:", err);
      });
    };

    const onData = (data: Uint8Array) => {
      this.bufferOutput(data);
      for (const ws of this.clients) {
        try {
          ws.send(data);
        } catch {
          // Client may have disconnected
        }
      }
    };

    // Phase 1: create builder + feeder (separate objects to avoid borrow conflict)
    console.log("[do] creating SshSessionBuilder");
    const builder = new SshSessionBuilder(onWrite, onData);
    const feeder = builder.create_feeder();

    // Phase 2: start TCP→WASM pump with feeder BEFORE handshake
    console.log("[do] starting TCP pump");
    this.pumpTcpToWasm(tcpSocket, feeder);

    // Set expected host key for TOFU verification
    set_expected_host_key(body.expectedHostKey ?? "");

    // Phase 3: SSH handshake with timeout (feeder is independent, no borrow conflict)
    console.log("[do] starting SSH handshake");
    try {
      this.session = await Promise.race([
        builder.connect(
          body.username,
          body.authType,
          body.credential,
          body.passphrase,
          body.cols,
          body.rows,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Connection timed out")), CONNECT_TIMEOUT_MS),
        ),
      ]);
    } catch (e) {
      console.error("[do] SSH connect failed:", e);
      tcpSocket.close();
      this.tcpSocket = null;
      const { code, message } = classifySshError(e);
      return errorResponse(code, message, 502);
    }
    const hostKey = take_accepted_host_key() ?? undefined;
    console.log("[do] SSH connected successfully");

    this.sessionMeta = {
      userId: body.userId,
      host: body.host,
      port: body.port,
      username: body.username,
      sessionId: body.sessionId,
    };
    await this.ctx.storage.put("meta", this.sessionMeta);

    // Set idle alarm (no WS clients yet)
    await this.ctx.storage.setAlarm(Date.now() + this.idleTimeout);

    return Response.json({ ok: true, hostKey });
  }

  private handleWebSocket(_request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    this.clients.add(server);

    // Replay buffered terminal output to the new client
    if (this.terminalBuffer.length > 0) {
      for (const chunk of this.terminalBuffer) {
        try {
          server.send(chunk);
        } catch {
          // ignore
        }
      }
    }

    // Cancel idle alarm since we have a client
    this.ctx.storage.deleteAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (!this.session) return;

    if (message instanceof ArrayBuffer) {
      // Binary: terminal input
      try {
        await this.session.send_data(new Uint8Array(message));
      } catch (e) {
        console.error("[do] send_data error:", e);
      }
    } else if (typeof message === "string") {
      // Text: JSON control message
      try {
        const msg = JSON.parse(message);
        if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
          await this.session.resize(msg.cols, msg.rows);
        }
      } catch (e) {
        console.error("[do] control message error:", e);
      }
    }
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      // Set idle timeout alarm
      await this.ctx.storage.setAlarm(Date.now() + this.idleTimeout);
    }
  }

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      await this.ctx.storage.setAlarm(Date.now() + this.idleTimeout);
    }
  }

  async alarm(): Promise<void> {
    if (this.clients.size === 0) {
      console.log("[do] idle timeout, terminating session");
      await this.terminate();
    }
  }

  private pumpTcpToWasm(tcpSocket: Socket, feeder: SshTransportFeeder): void {
    const pump = async () => {
      try {
        const reader = tcpSocket.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feeder.push_data(value);
        }
      } catch (e) {
        console.error("[do] TCP read error:", e);
      } finally {
        // TCP closed — notify all WS clients and clean up
        const closeMsg = JSON.stringify({ type: "disconnected" });
        for (const ws of this.clients) {
          try {
            ws.send(closeMsg);
            ws.close(1000, "SSH session ended");
          } catch {
            // ignore
          }
        }
        this.clients.clear();
        this.cleanup();
      }
    };
    // Run the pump as a background task in the DO context
    this.ctx.waitUntil(pump());
  }

  private async terminate(): Promise<void> {
    // Disconnect SSH
    if (this.session) {
      try {
        await this.session.disconnect();
      } catch {
        // ignore
      }
      this.session.free();
      this.session = null;
    }

    // Close TCP
    if (this.tcpSocket) {
      try {
        this.tcpSocket.close();
      } catch {
        // ignore
      }
      this.tcpSocket = null;
    }

    // Close all WS clients
    for (const ws of this.clients) {
      try {
        ws.close(1000, "Session terminated");
      } catch {
        // ignore
      }
    }
    this.clients.clear();

    // Restore meta from storage if lost (e.g. after DO eviction)
    if (!this.sessionMeta) {
      this.sessionMeta = (await this.ctx.storage.get("meta")) ?? null;
    }

    // Clean up KV session record (needed for alarm-triggered cleanup)
    if (this.sessionMeta) {
      try {
        const key = `sessions:${this.sessionMeta.userId}`;
        const raw = await this.env.ZEROSSH_KV.get(key);
        if (raw) {
          const sessions = JSON.parse(raw) as { id: string }[];
          const updated = sessions.filter((s) => s.id !== this.sessionMeta!.sessionId);
          await this.env.ZEROSSH_KV.put(key, JSON.stringify(updated));
        }
      } catch (e) {
        console.error("[do] KV cleanup error:", e);
      }
    }

    await this.ctx.storage.deleteAll();
    this.terminalBuffer = [];
    this.bufferSize = 0;
  }

  private cleanup(): void {
    if (this.session) {
      try {
        this.session.free();
      } catch {
        // ignore
      }
      this.session = null;
    }
    if (this.tcpSocket) {
      try {
        this.tcpSocket.close();
      } catch {
        // ignore
      }
      this.tcpSocket = null;
    }
    this.terminalBuffer = [];
    this.bufferSize = 0;
  }

  private bufferOutput(data: Uint8Array): void {
    this.terminalBuffer.push(new Uint8Array(data));
    this.bufferSize += data.byteLength;

    // Evict oldest chunks when over budget
    while (this.bufferSize > this.maxBuffer && this.terminalBuffer.length > 1) {
      const evicted = this.terminalBuffer.shift()!;
      this.bufferSize -= evicted.byteLength;
    }
  }
}
