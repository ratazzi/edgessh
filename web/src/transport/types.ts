export interface ServerConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  credential: string;
  passphrase: string;
  cols: number;
  rows: number;
  acceptNewHostKey?: boolean;
}

export interface Connection {
  send(data: Uint8Array): void;
  onData(cb: (data: Uint8Array) => void): void;
  close(): Promise<void>;
  resize?(cols: number, rows: number): void;
  isConnected?(): boolean;
}

export interface TransportProvider {
  readonly mode: "tcp-stream" | "terminal-session";
  connect(config: ServerConfig): Promise<Connection>;
}
