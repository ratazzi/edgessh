import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
  acceptNewHostKey?: boolean;
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

  // Read known_hosts from KV for TOFU
  const knownHostsKey = `known_hosts:${user.sub}`;
  const knownHostsRaw = await c.env.ZEROSSH_KV.get(knownHostsKey);
  const knownHosts: Record<string, string> = knownHostsRaw ? JSON.parse(knownHostsRaw) : {};
  const hostId = `${config.host}:${config.port}`;
  let expectedHostKey = knownHosts[hostId] ?? "";

  // If user explicitly accepts a new key, clear the old one
  if (config.acceptNewHostKey) {
    expectedHostKey = "";
  }

  const res = await stub.fetch(
    new Request("https://do/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...config, userId: user.sub, sessionId, expectedHostKey }),
    }),
  );

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: { code: "unknown", message: res.statusText } }));
    return c.json(body, res.status as ContentfulStatusCode);
  }

  const doResult = (await res.json()) as { ok: boolean; hostKey?: string };

  const hostWasKnown = !!knownHosts[hostId];

  // Only persist host key if host was already known (key matched) or user explicitly accepted
  if (doResult.hostKey && (hostWasKnown || config.acceptNewHostKey)) {
    knownHosts[hostId] = doResult.hostKey;
    await c.env.ZEROSSH_KV.put(knownHostsKey, JSON.stringify(knownHosts));
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

  // If first time seeing this host, tell frontend to confirm
  if (!hostWasKnown && !config.acceptNewHostKey) {
    return c.json({ sessionId, hostKeyUnknown: true, hostKey: doResult.hostKey });
  }

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

// Accept host key (first-connection confirmation)
sessionRoutes.post("/:id/accept-host-key", async (c) => {
  const user = c.get("user");
  const { host, port, hostKey } = await c.req.json<{ host: string; port: number; hostKey: string }>();

  const knownHostsKey = `known_hosts:${user.sub}`;
  const knownHostsRaw = await c.env.ZEROSSH_KV.get(knownHostsKey);
  const knownHosts: Record<string, string> = knownHostsRaw ? JSON.parse(knownHostsRaw) : {};
  knownHosts[`${host}:${port}`] = hostKey;
  await c.env.ZEROSSH_KV.put(knownHostsKey, JSON.stringify(knownHosts));

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
