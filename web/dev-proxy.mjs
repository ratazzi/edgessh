// Local WebSocket-to-TCP proxy for development testing.
// Usage: node dev-proxy.mjs [port]
// Connects to: ws://localhost:<port>/proxy?host=<host>&port=<port>

import { WebSocketServer } from "ws";
import { createConnection } from "net";

const PORT = parseInt(process.argv[2] || "8088", 10);

const wss = new WebSocketServer({ port: PORT });

wss.on("listening", () => {
  console.log(`WS→TCP proxy listening on ws://localhost:${PORT}`);
  console.log(`Usage: ws://localhost:${PORT}/proxy?host=<host>&port=<port>`);
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/proxy") {
    ws.close(4004, "Not Found");
    return;
  }

  const host = url.searchParams.get("host");
  const port = parseInt(url.searchParams.get("port") || "22", 10);

  if (!host || isNaN(port)) {
    ws.close(4000, "Missing host or port");
    return;
  }

  console.log(`Connecting to ${host}:${port}`);

  const tcp = createConnection({ host, port }, () => {
    console.log(`TCP connected to ${host}:${port}`);
  });

  tcp.on("data", (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(data);
    }
  });

  tcp.on("end", () => {
    console.log(`TCP disconnected from ${host}:${port}`);
    ws.close(1000, "TCP closed");
  });

  tcp.on("error", (err) => {
    console.error(`TCP error: ${err.message}`);
    ws.close(1011, "TCP error");
  });

  ws.on("message", (data) => {
    tcp.write(data);
  });

  ws.on("close", () => {
    console.log(`WS closed for ${host}:${port}`);
    tcp.destroy();
  });

  ws.on("error", () => {
    tcp.destroy();
  });
});
