# EdgeSSH

A browser-based SSH client running entirely on Cloudflare's edge. Connect to any SSH server from your browser — no plugins, no extensions, no local software required.

## How It Works

EdgeSSH compiles a full SSH protocol implementation (forked [russh](https://github.com/warp-tech/russh)) to WebAssembly, then runs it inside a Cloudflare Durable Object. The Durable Object opens a raw TCP socket to your SSH server via [`cloudflare:sockets`](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) and bridges the SSH session to your browser over WebSocket.

```
Browser ↔ WebSocket ↔ Cloudflare DO (WASM SSH) ↔ TCP ↔ SSH Server
```

Sessions are persistent — you can close your browser tab and reattach later. Terminal output is buffered in the DO so you won't miss anything.

## Features

- **Full SSH in WASM** — Password and private key authentication (ed25519, RSA, ECDSA). Encrypted key passphrases supported.
- **Persistent sessions** — SSH sessions live in Durable Objects. Detach and reattach from any browser.
- **Host key verification** — Trust On First Use (TOFU). Keys stored per-user, with mismatch warnings.
- **Passkey auth** — Passwordless login via WebAuthn. Single-owner self-deploy or multi-user demo mode.
- **Private IP blocking** — Connections to RFC 1918, loopback, and link-local addresses are rejected.
- **Terminal** — xterm.js with WebGL rendering, window resize, and fit-to-container.

## Architecture

| Component | Stack | Location |
|---|---|---|
| `crates/russh/` | Rust | Forked russh SSH protocol library |
| `crates/zerossh-do/` | Rust → WASM | SSH bindings for Durable Object runtime |
| `crates/zerossh-wasm/` | Rust → WASM | SSH bindings for browser runtime (legacy) |
| `worker/` | TypeScript (Hono) | Cloudflare Worker: API, auth, Durable Object |
| `web/` | TypeScript (Vite) | Frontend: auth UI, server dashboard, terminal |

## Self-Hosting

### Prerequisites

- Rust stable toolchain with `wasm32-unknown-unknown` target
- [wasm-pack](https://rustwasm.github.io/wasm-pack/)
- Node.js
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)
- [mise](https://mise.jdx.dev/) (optional, for task orchestration)

### Setup

1. **Create Cloudflare resources**

   Create a KV namespace and update the ID in `worker/wrangler.toml`:

   ```bash
   npx wrangler kv namespace create ZEROSSH_KV
   ```

2. **Set secrets**

   ```bash
   cd worker
   # Required
   echo "your-jwt-secret" | npx wrangler secret put JWT_SECRET
   echo "your-32-byte-hex-key" | npx wrangler secret put ENCRYPTION_KEY

   # Optional: enable demo mode
   echo "true" | npx wrangler secret put DEMO_MODE

   # Optional: Turnstile bot protection for demo mode
   echo "your-site-key" | npx wrangler secret put TURNSTILE_SITE_KEY
   echo "your-secret-key" | npx wrangler secret put TURNSTILE_SECRET
   ```

3. **Install dependencies**

   ```bash
   cd web && npm install
   cd ../worker && npm install
   ```

4. **Build and deploy**

   ```bash
   mise run deploy
   ```

   Or manually:

   ```bash
   wasm-pack build crates/zerossh-do --target web --release
   wasm-pack build crates/zerossh-wasm --target web --release
   cd web && npm run build
   cd ../worker && npx wrangler deploy
   ```

### Local Development

```bash
# Build WASM packages first
mise run wasm

# Start frontend dev server
cd web && npm run dev

# Start worker dev server (separate terminal)
cd worker && npm run dev
```

## Auth Modes

- **Self-deploy** (default): First visitor registers a passkey and becomes the sole owner. No other users can register.
- **Demo** (`DEMO_MODE=true`): Anyone can log in. Optionally gated by Cloudflare Turnstile. User data expires after 24 hours.

## License

MIT
