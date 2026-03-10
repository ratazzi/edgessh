import { Hono } from "hono";
import type { AppType } from "./types";

interface ServerConfig {
  host: string;
  port: number;
  username: string;
  authType: "password" | "key";
  credential: string;
  passphrase: string;
  cols: number;
  rows: number;
}

interface SessionRecord {
  id: string;
  host: string;
  port: number;
  username: string;
  createdAt: number;
}

export const sessionRoutes = new Hono<AppType>();

// Create session
sessionRoutes.post("/", async (c) => {
  const user = c.get("user");
  const config = await c.req.json<ServerConfig>();
  const sessionId = crypto.randomUUID();
  console.log(`[sessions] POST create: ${config.username}@${config.host}:${config.port} sessionId=${sessionId}`);
  const doId = c.env.SSH_SESSION.idFromName(`${user.sub}:${sessionId}`);
  const stub = c.env.SSH_SESSION.get(doId);

  const res = await stub.fetch(
    new Request("https://do/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, userId: user.sub, sessionId }),
    }),
  );

  if (!res.ok) {
    const text = await res.text();
    return c.json({ error: text }, 502);
  }

  // Save session metadata to KV
  const key = `sessions:${user.sub}`;
  const raw = await c.env.ZEROSSH_KV.get(key);
  const sessions: SessionRecord[] = raw ? JSON.parse(raw) : [];
  sessions.push({
    id: sessionId,
    host: config.host,
    port: config.port,
    username: config.username,
    createdAt: Date.now(),
  });
  await c.env.ZEROSSH_KV.put(key, JSON.stringify(sessions));

  return c.json({ sessionId });
});

// List active sessions
sessionRoutes.get("/", async (c) => {
  const user = c.get("user");
  const key = `sessions:${user.sub}`;
  const raw = await c.env.ZEROSSH_KV.get(key);
  const sessions: SessionRecord[] = raw ? JSON.parse(raw) : [];
  return c.json({ sessions });
});

// Terminate session
sessionRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("id");
  const doId = c.env.SSH_SESSION.idFromName(`${user.sub}:${sessionId}`);
  const stub = c.env.SSH_SESSION.get(doId);
  await stub.fetch(new Request("https://do/", { method: "DELETE" }));

  // Remove from KV
  const key = `sessions:${user.sub}`;
  const raw = await c.env.ZEROSSH_KV.get(key);
  if (raw) {
    const sessions: SessionRecord[] = JSON.parse(raw);
    const updated = sessions.filter((s) => s.id !== sessionId);
    await c.env.ZEROSSH_KV.put(key, JSON.stringify(updated));
  }

  return c.json({ ok: true });
});

// WebSocket connect to session
sessionRoutes.get("/:id/ws", async (c) => {
  const user = c.get("user");
  const sessionId = c.req.param("id");
  const doId = c.env.SSH_SESSION.idFromName(`${user.sub}:${sessionId}`);
  const stub = c.env.SSH_SESSION.get(doId);

  // Forward the WebSocket upgrade to the DO
  return stub.fetch(
    new Request("https://do/ws", {
      headers: c.req.raw.headers,
    }),
  );
});
