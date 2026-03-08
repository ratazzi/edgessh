// Private IP validation: deny connections to internal networks
function isPrivateIP(hostname: string): boolean {
  // IPv6 loopback and unique local
  if (hostname === "::1" || hostname.toLowerCase().startsWith("fc") || hostname.toLowerCase().startsWith("fd")) {
    return true;
  }

  // IPv4
  const parts = hostname.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
    const a = parseInt(parts[0]);
    const b = parseInt(parts[1]);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // link-local
  }

  // Reject "localhost" explicitly
  if (hostname === "localhost") return true;

  return false;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== "/proxy") {
      return new Response("Not Found", { status: 404 });
    }

    // Must be a WebSocket upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    const host = url.searchParams.get("host");
    const portStr = url.searchParams.get("port");

    if (!host || !portStr) {
      return new Response("Missing host or port query parameter", { status: 400 });
    }

    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return new Response("Invalid port", { status: 400 });
    }

    if (isPrivateIP(host)) {
      return new Response("Connection to private IP denied", { status: 403 });
    }

    // Accept the WebSocket
    const [client, server] = Object.values(new WebSocketPair());

    server.accept();

    // Connect to the target TCP host via Cloudflare connect() API
    let tcpSocket: Socket;
    try {
      tcpSocket = connect({ hostname: host, port });
    } catch {
      server.close(1011, "Failed to connect to target");
      return new Response(null, { status: 101, webSocket: client });
    }

    // TCP -> WebSocket: read from TCP and forward to WebSocket
    const tcpToWs = async () => {
      try {
        const reader = tcpSocket.readable.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          server.send(value);
        }
      } catch {
        // TCP read error or socket closed
      } finally {
        server.close(1000, "TCP connection closed");
      }
    };

    // WebSocket -> TCP: receive from WebSocket and write to TCP
    const writer = tcpSocket.writable.getWriter();

    server.addEventListener("message", async (event: MessageEvent) => {
      try {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          await writer.write(new Uint8Array(data));
        } else if (typeof data === "string") {
          await writer.write(new TextEncoder().encode(data));
        }
      } catch {
        server.close(1011, "TCP write error");
      }
    });

    server.addEventListener("close", async () => {
      try {
        await writer.close();
      } catch {
        // already closed
      }
      tcpSocket.close();
    });

    server.addEventListener("error", () => {
      try {
        writer.close();
      } catch {
        // ignore
      }
      tcpSocket.close();
    });

    // Start TCP->WS pump
    tcpToWs();

    return new Response(null, { status: 101, webSocket: client });
  },
};
