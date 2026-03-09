import { Hono } from "hono";
import type { AppType } from "./types";
import { encrypt, decrypt } from "./crypto";

export const serverRoutes = new Hono<AppType>();

// GET / — decrypt and return server list
serverRoutes.get("/", async (c) => {
  const user = c.get("user");
  const key = `user:${user.sub}:servers`;
  const encrypted = await c.env.ZEROSSH_KV.get(key);

  if (!encrypted) {
    return c.json({ servers: [] });
  }

  try {
    const plaintext = await decrypt(encrypted, c.env.ENCRYPTION_KEY, user.sub);
    return c.json({ servers: JSON.parse(plaintext) });
  } catch (err) {
    console.error("[servers] decrypt failed:", err);
    return c.json({ servers: [] });
  }
});

// POST / — encrypt and store server list (full replacement)
serverRoutes.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ servers: unknown[] }>();
  const key = `user:${user.sub}:servers`;

  const encrypted = await encrypt(JSON.stringify(body.servers), c.env.ENCRYPTION_KEY, user.sub);

  const options: KVNamespacePutOptions = {};
  if (user.mode === "demo") {
    options.expirationTtl = 86400; // 24h
  }

  await c.env.ZEROSSH_KV.put(key, encrypted, options);
  return c.json({ ok: true });
});
