export interface Env {
  ZEROSSH_KV: KVNamespace;
  JWT_SECRET: string;
  ENCRYPTION_KEY: string;
  DEMO_MODE?: string;
  TURNSTILE_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  RP_ID?: string;
  RP_ORIGIN?: string;
}

export interface JwtPayload {
  sub: string;
  mode: "passkey" | "demo";
  iat: number;
  exp: number;
}

export interface UserRecord {
  id: string;
  type: "passkey" | "demo";
  credentials?: StoredCredential[];
  createdAt: number;
}

export interface StoredCredential {
  id: string;
  publicKey: string; // base64url
  counter: number;
  transports?: AuthenticatorTransport[];
}

type Variables = {
  user: JwtPayload;
};

export type AppType = {
  Bindings: Env;
  Variables: Variables;
};
