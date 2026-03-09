import { startRegistration, startAuthentication } from "@simplewebauthn/browser";

export interface AuthStatus {
  registered: boolean;
  authenticated: boolean;
  mode: "self-deploy" | "demo";
  turnstileSiteKey?: string | null;
}

export async function checkAuthStatus(): Promise<AuthStatus> {
  const res = await fetch("/api/auth/status");
  return res.json();
}

export async function registerPasskey(): Promise<boolean> {
  // 1. Get registration options
  const optionsRes = await fetch("/api/auth/register/options", { method: "POST" });
  if (!optionsRes.ok) throw new Error("Failed to get registration options");
  const { options, challengeId } = await optionsRes.json();

  // 2. Start browser registration
  const attResp = await startRegistration({ optionsJSON: options });

  // 3. Verify with server
  const verifyRes = await fetch("/api/auth/register/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, response: attResp }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.json();
    throw new Error(err.error || "Registration failed");
  }

  return true;
}

export async function loginPasskey(): Promise<boolean> {
  // 1. Get authentication options
  const optionsRes = await fetch("/api/auth/login/options", { method: "POST" });
  if (!optionsRes.ok) throw new Error("Failed to get login options");
  const { options, challengeId } = await optionsRes.json();

  // 2. Start browser authentication
  const authResp = await startAuthentication({ optionsJSON: options });

  // 3. Verify with server
  const verifyRes = await fetch("/api/auth/login/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, response: authResp }),
  });

  if (!verifyRes.ok) {
    const err = await verifyRes.json();
    throw new Error(err.error || "Login failed");
  }

  return true;
}

export async function loginDemo(turnstileToken: string): Promise<boolean> {
  const res = await fetch("/api/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ turnstileToken }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || "Demo login failed");
  }

  return true;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
