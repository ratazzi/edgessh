import type { TransportProvider, Connection, ServerConfig } from "./types";

export type SshErrorCode =
  | "connection_refused"
  | "auth_failed"
  | "host_key_mismatch"
  | "timeout"
  | "private_ip_denied"
  | "invalid_port"
  | "unknown";

export class SshConnectionError extends Error {
  readonly code: SshErrorCode;

  constructor(code: SshErrorCode, message: string) {
    super(message);
    this.name = "SshConnectionError";
    this.code = code;
  }
}

export interface DoConnection extends Connection {
  sessionId: string;
  hostKeyUnknown?: boolean;
  hostKey?: string;
}

export class DoSessionProvider implements TransportProvider {
  readonly mode = "terminal-session" as const;

  async connect(config: ServerConfig): Promise<DoConnection> {
    // 1. Create session via API
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { code: "unknown", message: res.statusText } }));
      const err = (body as { error?: { code?: SshErrorCode; message?: string } }).error;
      throw new SshConnectionError(
        err?.code ?? "unknown",
        err?.message ?? `Session create failed: ${res.status}`,
      );
    }

    const data = (await res.json()) as { sessionId: string; hostKeyUnknown?: boolean; hostKey?: string };

    // 2. Connect WebSocket to the session
    const conn = await this.connectWs(data.sessionId);
    conn.hostKeyUnknown = data.hostKeyUnknown;
    conn.hostKey = data.hostKey;
    return conn;
  }

  async reconnect(sessionId: string): Promise<DoConnection> {
    return this.connectWs(sessionId);
  }

  private connectWs(sessionId: string): Promise<DoConnection> {
    return new Promise((resolve, reject) => {
      const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${wsProto}//${location.host}/api/sessions/${sessionId}/ws`;
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      let dataCallback: ((data: Uint8Array) => void) | null = null;
      const buffer: Uint8Array[] = [];
      let connected = false;

      ws.addEventListener("message", (event: MessageEvent) => {
        if (event.data instanceof ArrayBuffer) {
          const chunk = new Uint8Array(event.data);
          if (dataCallback) {
            dataCallback(chunk);
          } else {
            buffer.push(chunk);
          }
        } else if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "disconnected") {
              connected = false;
            }
          } catch {
            // ignore
          }
        }
      });

      ws.addEventListener("close", () => {
        connected = false;
      });

      const connection: DoConnection = {
        sessionId,

        send(data: Uint8Array): void {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        },

        onData(cb: (data: Uint8Array) => void): void {
          dataCallback = cb;
          for (const chunk of buffer) {
            cb(chunk);
          }
          buffer.length = 0;
        },

        async close(): Promise<void> {
          ws.close();
        },

        resize(cols: number, rows: number): void {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        },

        isConnected(): boolean {
          return connected && ws.readyState === WebSocket.OPEN;
        },
      };

      ws.addEventListener("open", () => {
        connected = true;
        resolve(connection);
      });

      ws.addEventListener("error", () => {
        if (!connected) {
          reject(new Error("WebSocket connection failed"));
        }
        connected = false;
      });
    });
  }

  async acceptHostKey(sessionId: string, host: string, port: number, hostKey: string): Promise<void> {
    await fetch(`/api/sessions/${sessionId}/accept-host-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, port, hostKey }),
    });
  }

  async terminate(sessionId: string): Promise<void> {
    await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
  }

  async listSessions(): Promise<SessionInfo[]> {
    const res = await fetch("/api/sessions");
    if (!res.ok) return [];
    const { sessions } = (await res.json()) as { sessions: SessionInfo[] };
    return sessions;
  }
}

export interface SessionInfo {
  id: string;
  host: string;
  port: number;
  username: string;
  createdAt: number;
}
