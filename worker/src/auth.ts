import { Hono } from "hono";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { AppType, UserRecord, StoredCredential } from "./types";
import { signJwt, verifyJwt, getSessionCookie, clearSessionCookie, parseCookie } from "./jwt";

export const authRoutes = new Hono<AppType>();

function getRpId(c: { env: AppType["Bindings"]; req: { header: (name: string) => string | undefined } }): string {
  return c.env.RP_ID || new URL(`https://${c.req.header("Host") || "localhost"}`).hostname;
}

function getRpOrigin(c: { env: AppType["Bindings"]; req: { header: (name: string) => string | undefined } }): string {
  return c.env.RP_ORIGIN || `https://${c.req.header("Host") || "localhost"}`;
}

function isDemoMode(env: AppType["Bindings"]): boolean {
  return env.DEMO_MODE === "true" || env.DEMO_MODE === "1";
}

// GET /status
authRoutes.get("/status", async (c) => {
  const demo = isDemoMode(c.env);
  const cookieHeader = c.req.header("Cookie");
  const token = parseCookie(cookieHeader, "session");

  let authenticated = false;
  if (token) {
    const payload = await verifyJwt(token, c.env.JWT_SECRET);
    authenticated = payload !== null;
  }

  if (demo) {
    return c.json({
      registered: false,
      authenticated,
      mode: "demo",
      turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || null,
    });
  }

  // Self-deploy mode: check if owner is registered
  const owner = await c.env.ZEROSSH_KV.get<UserRecord>("user:owner", "json");
  return c.json({
    registered: !!owner,
    authenticated,
    mode: "self-deploy",
  });
});

// POST /register/options
authRoutes.post("/register/options", async (c) => {
  if (isDemoMode(c.env)) {
    return c.json({ error: "Registration not available in demo mode" }, 403);
  }

  const existing = await c.env.ZEROSSH_KV.get<UserRecord>("user:owner", "json");
  if (existing) {
    return c.json({ error: "Already registered" }, 409);
  }

  const rpID = getRpId(c);
  const options = await generateRegistrationOptions({
    rpName: "EdgeSSH",
    rpID,
    userName: "owner",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    attestationType: "none",
  });

  // Store challenge in KV with 5min TTL
  const challengeId = crypto.randomUUID();
  await c.env.ZEROSSH_KV.put(
    `challenge:${challengeId}`,
    JSON.stringify({ challenge: options.challenge, type: "registration" }),
    { expirationTtl: 300 },
  );

  return c.json({ options, challengeId });
});

// POST /register/verify
authRoutes.post("/register/verify", async (c) => {
  if (isDemoMode(c.env)) {
    return c.json({ error: "Registration not available in demo mode" }, 403);
  }

  const existing = await c.env.ZEROSSH_KV.get<UserRecord>("user:owner", "json");
  if (existing) {
    return c.json({ error: "Already registered" }, 409);
  }

  const body = await c.req.json<{ challengeId: string; response: unknown }>();
  const stored = await c.env.ZEROSSH_KV.get<{ challenge: string; type: string }>(`challenge:${body.challengeId}`, "json");
  if (!stored || stored.type !== "registration") {
    return c.json({ error: "Invalid or expired challenge" }, 400);
  }

  // Delete challenge immediately
  await c.env.ZEROSSH_KV.delete(`challenge:${body.challengeId}`);

  const rpID = getRpId(c);
  const rpOrigin = getRpOrigin(c);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as Parameters<typeof verifyRegistrationResponse>[0]["response"],
      expectedChallenge: stored.challenge,
      expectedOrigin: rpOrigin,
      expectedRPID: rpID,
    });
  } catch (err) {
    console.error("[auth] registration verification failed:", err);
    return c.json({ error: "Verification failed" }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ error: "Verification failed" }, 400);
  }

  const { credential } = verification.registrationInfo;

  // Encode publicKey to base64url for storage
  const publicKeyB64 = uint8ArrayToBase64url(credential.publicKey);

  const storedCred: StoredCredential = {
    id: credential.id,
    publicKey: publicKeyB64,
    counter: credential.counter,
    transports: credential.transports as AuthenticatorTransport[] | undefined,
  };

  const user: UserRecord = {
    id: "owner",
    type: "passkey",
    credentials: [storedCred],
    createdAt: Date.now(),
  };

  await c.env.ZEROSSH_KV.put("user:owner", JSON.stringify(user));

  // Issue JWT (7 day expiry)
  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    { sub: "owner", mode: "passkey", iat: now, exp: now + 7 * 86400 },
    c.env.JWT_SECRET,
  );

  c.header("Set-Cookie", getSessionCookie(token, 7 * 86400));
  return c.json({ verified: true });
});

// POST /login/options
authRoutes.post("/login/options", async (c) => {
  if (isDemoMode(c.env)) {
    return c.json({ error: "Login not available in demo mode" }, 403);
  }

  const owner = await c.env.ZEROSSH_KV.get<UserRecord>("user:owner", "json");
  if (!owner || !owner.credentials?.length) {
    return c.json({ error: "Not registered" }, 404);
  }

  const rpID = getRpId(c);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: owner.credentials.map((cred) => ({
      id: cred.id,
      transports: cred.transports,
    })),
    userVerification: "preferred",
  });

  const challengeId = crypto.randomUUID();
  await c.env.ZEROSSH_KV.put(
    `challenge:${challengeId}`,
    JSON.stringify({ challenge: options.challenge, type: "authentication" }),
    { expirationTtl: 300 },
  );

  return c.json({ options, challengeId });
});

// POST /login/verify
authRoutes.post("/login/verify", async (c) => {
  if (isDemoMode(c.env)) {
    return c.json({ error: "Login not available in demo mode" }, 403);
  }

  const owner = await c.env.ZEROSSH_KV.get<UserRecord>("user:owner", "json");
  if (!owner || !owner.credentials?.length) {
    return c.json({ error: "Not registered" }, 404);
  }

  const body = await c.req.json<{ challengeId: string; response: { id: string } }>();
  const stored = await c.env.ZEROSSH_KV.get<{ challenge: string; type: string }>(`challenge:${body.challengeId}`, "json");
  if (!stored || stored.type !== "authentication") {
    return c.json({ error: "Invalid or expired challenge" }, 400);
  }

  await c.env.ZEROSSH_KV.delete(`challenge:${body.challengeId}`);

  // Find matching credential
  const matchingCred = owner.credentials.find((cred) => cred.id === body.response.id);
  if (!matchingCred) {
    return c.json({ error: "Credential not found" }, 400);
  }

  const rpID = getRpId(c);
  const rpOrigin = getRpOrigin(c);

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as unknown as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
      expectedChallenge: stored.challenge,
      expectedOrigin: rpOrigin,
      expectedRPID: rpID,
      credential: {
        id: matchingCred.id,
        publicKey: base64urlToUint8Array(matchingCred.publicKey),
        counter: matchingCred.counter,
        transports: matchingCred.transports,
      },
    });
  } catch (err) {
    console.error("[auth] authentication verification failed:", err);
    return c.json({ error: "Verification failed" }, 400);
  }

  if (!verification.verified) {
    return c.json({ error: "Verification failed" }, 400);
  }

  // Update counter
  matchingCred.counter = verification.authenticationInfo.newCounter;
  await c.env.ZEROSSH_KV.put("user:owner", JSON.stringify(owner));

  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    { sub: "owner", mode: "passkey", iat: now, exp: now + 7 * 86400 },
    c.env.JWT_SECRET,
  );

  c.header("Set-Cookie", getSessionCookie(token, 7 * 86400));
  return c.json({ verified: true });
});

// POST /demo
authRoutes.post("/demo", async (c) => {
  if (!isDemoMode(c.env)) {
    return c.json({ error: "Demo mode not enabled" }, 403);
  }

  const body = await c.req.json<{ turnstileToken: string }>();

  // Verify Turnstile token
  if (c.env.TURNSTILE_SECRET) {
    const formData = new FormData();
    formData.append("secret", c.env.TURNSTILE_SECRET);
    formData.append("response", body.turnstileToken);

    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: formData,
    });
    const outcome = await result.json<{ success: boolean }>();
    if (!outcome.success) {
      return c.json({ error: "Turnstile verification failed" }, 403);
    }
  }

  // Create anonymous user with 24h TTL
  const userId = `anon-${crypto.randomUUID()}`;
  const user: UserRecord = {
    id: userId,
    type: "demo",
    createdAt: Date.now(),
  };

  await c.env.ZEROSSH_KV.put(`user:${userId}`, JSON.stringify(user), {
    expirationTtl: 86400,
  });

  const now = Math.floor(Date.now() / 1000);
  const token = await signJwt(
    { sub: userId, mode: "demo", iat: now, exp: now + 86400 },
    c.env.JWT_SECRET,
  );

  c.header("Set-Cookie", getSessionCookie(token, 86400));
  return c.json({ verified: true, userId });
});

// POST /logout
authRoutes.post("/logout", (c) => {
  c.header("Set-Cookie", clearSessionCookie());
  return c.json({ ok: true });
});

// Helpers
function uint8ArrayToBase64url(arr: Uint8Array): string {
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToUint8Array(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
