import { connect } from "cloudflare:sockets";
import type { Context } from "hono";
import type { AppType } from "./types";

export function isPrivateIP(hostname: string): boolean {
  // IPv6 loopback and unique local
  if (hostname === "::1" || hostname.toLowerCase().startsWith("fc") || hostname.toLowerCase().startsWith("fd")) {
    return true;
  }

  // IPv4
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = parseInt(parts[0]);
    const b = parseInt(parts[1]);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
  }

  if (hostname === "localhost") return true;

  return false;
}

export async function handleProxy(c: Context<AppType>): Promise<Response> {
  const upgradeHeader = c.req.header("Upgrade");
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const host = c.req.query("host");
  const portStr = c.req.query("port");

  if (!host || !portStr) {
    return c.text("Missing host or port query parameter", 400);
  }

  const port = parseInt(portStr, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    return c.text("Invalid port", 400);
  }

  if (isPrivateIP(host)) {
    return c.text("Connection to private IP denied", 403);
  }

  console.log(`[proxy] connecting to ${host}:${port}`);

  const [client, server] = Object.values(new WebSocketPair());

  server.accept();

  let tcpSocket: Socket;
  try {
    tcpSocket = connect({ hostname: host, port });
  } catch (e) {
    console.error(`[proxy] TCP connect failed:`, e);
    server.close(1011, "Failed to connect to target");
    return new Response(null, { status: 101, webSocket: client });
  }

  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  const tcpToWs = async () => {
    try {
      const reader = tcpSocket.readable.getReader();
      let bytes = 0;
      let lastRead = Date.now();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          const idleMs = Date.now() - lastRead;
          console.log(`[proxy] TCP read done at ${elapsed()}, total ${bytes} bytes, idle ${idleMs}ms before close`);
          break;
        }
        lastRead = Date.now();
        bytes += value.byteLength;
        server.send(value);
      }
    } catch (e) {
      console.error(`[proxy] TCP read error at ${elapsed()}:`, e);
    } finally {
      server.close(1000, "TCP connection closed");
    }
  };

  const writer = tcpSocket.writable.getWriter();

  server.addEventListener("message", async (event: MessageEvent) => {
    try {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        await writer.write(new Uint8Array(data));
      } else if (typeof data === "string") {
        console.log(`[proxy] received text frame (${data.length} chars), converting to binary`);
        await writer.write(new TextEncoder().encode(data));
      }
    } catch (e) {
      console.error(`[proxy] TCP write error at ${elapsed()}:`, e);
      server.close(1011, "TCP write error");
    }
  });

  server.addEventListener("close", async (event) => {
    console.log(`[proxy] WS closed: code=${event.code} reason=${event.reason}`);
    try {
      await writer.close();
    } catch {
      // already closed
    }
    tcpSocket.close();
  });

  server.addEventListener("error", (event) => {
    console.error(`[proxy] WS error:`, event);
    try {
      writer.close();
    } catch {
      // ignore
    }
    tcpSocket.close();
  });

  c.executionCtx.waitUntil(tcpToWs());

  return new Response(null, { status: 101, webSocket: client });
}
