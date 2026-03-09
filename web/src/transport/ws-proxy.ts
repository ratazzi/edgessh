import type { TransportProvider, Connection, ServerConfig } from "./types";
import initWasm, { SshClient } from "zerossh-wasm";

let wasmReady: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm().then(
      () => {},
      (err) => {
        wasmReady = null;
        throw err;
      },
    );
  }
  return wasmReady;
}

export class WsProxyProvider implements TransportProvider {
  readonly mode = "tcp-stream" as const;

  async connect(config: ServerConfig): Promise<Connection> {
    await ensureWasm();

    const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${location.host}/proxy?host=${encodeURIComponent(config.host)}&port=${encodeURIComponent(String(config.port))}`;

    // Buffer data arriving before onData callback is registered
    let dataCallback: ((data: Uint8Array) => void) | null = null;
    const buffer: Uint8Array[] = [];

    const onData = (data: Uint8Array) => {
      if (dataCallback) {
        dataCallback(data);
      } else {
        buffer.push(data);
      }
    };

    const client = await SshClient.connect(
      wsUrl,
      config.username,
      config.authType,
      config.credential,
      config.passphrase,
      config.cols,
      config.rows,
      onData,
    );

    const connection: Connection = {
      send(data: Uint8Array): void {
        client.send_data(data).catch((err: unknown) => {
          console.error("[zerossh] send_data error:", err);
        });
      },

      onData(cb: (data: Uint8Array) => void): void {
        dataCallback = cb;
        for (const chunk of buffer) {
          cb(chunk);
        }
        buffer.length = 0;
      },

      async close(): Promise<void> {
        try {
          await Promise.race([
            client.disconnect(),
            new Promise((r) => setTimeout(r, 2000)),
          ]);
        } catch {
          // ignore disconnect errors
        }
        client.free();
      },

      resize(cols: number, rows: number): void {
        client.resize(cols, rows).catch((err: unknown) => {
          console.error("[zerossh] resize error:", err);
        });
      },

      isConnected(): boolean {
        return client.is_connected();
      },
    };

    return connection;
  }
}
