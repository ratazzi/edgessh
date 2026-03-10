import "./style.css";
import "@xterm/xterm/css/xterm.css";
import { DoSessionProvider, type DoConnection, type ServerConfig, type SessionInfo } from "./transport";
import { TerminalUI } from "./terminal";
import { checkAuthStatus, registerPasskey, loginPasskey, loginDemo, logout, type AuthStatus } from "./auth";
import { loadServers, saveServers, type SavedServer } from "./servers";

const provider = new DoSessionProvider();
let connection: DoConnection | null = null;
let terminalUI: TerminalUI | null = null;
let connectionCheckTimer: ReturnType<typeof setInterval> | null = null;
let currentSessionId: string | null = null;

// DOM elements
const authScreen = document.getElementById("auth-screen")!;
const authLoading = document.getElementById("auth-loading")!;
const authActions = document.getElementById("auth-actions")!;
const authError = document.getElementById("auth-error")!;
const registerBtn = document.getElementById("register-btn") as HTMLButtonElement;
const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
const turnstileContainer = document.getElementById("turnstile-container")!;

const dashboard = document.getElementById("dashboard")!;
const serverGrid = document.getElementById("server-grid")!;
const emptyState = document.getElementById("empty-state")!;

const connectModal = document.getElementById("connect-modal")!;
const connectForm = document.getElementById("connect-form") as HTMLFormElement;
const terminalContainer = document.getElementById("terminal-container")!;
const terminalEl = document.getElementById("terminal")!;
const statusIndicator = document.getElementById("status-indicator")!;
const statusText = document.getElementById("status-text")!;
const disconnectBtn = document.getElementById("disconnect-btn")!;
const connectBtn = document.getElementById("connect-btn") as HTMLButtonElement;
const btnText = connectBtn.querySelector(".btn-text")!;
const btnSpinner = connectBtn.querySelector(".btn-spinner")!;
const errorMsg = document.getElementById("error-msg")!;

// Auth type toggle
const toggleBtns = document.querySelectorAll<HTMLButtonElement>(".toggle-btn");
const passwordField = document.getElementById("password-field")!;
const keyField = document.getElementById("key-field")!;
const passphraseField = document.getElementById("passphrase-field")!;

let authType = "password";
let authMode: "self-deploy" | "demo" = "self-deploy";

toggleBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    toggleBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    authType = btn.dataset.auth!;
    passwordField.classList.toggle("hidden", authType !== "password");
    keyField.classList.toggle("hidden", authType !== "key");
    passphraseField.classList.toggle("hidden", authType !== "key");
  });
});

function showError(msg: string): void {
  errorMsg.textContent = msg;
  errorMsg.classList.remove("hidden");
}

function hideError(): void {
  errorMsg.classList.add("hidden");
}

function setConnecting(loading: boolean): void {
  connectBtn.disabled = loading;
  btnText.textContent = loading ? "Connecting..." : "Connect";
  btnSpinner.classList.toggle("hidden", !loading);
}

const terminateBtn = document.getElementById("terminate-btn");

function setStatus(connected: boolean, text: string): void {
  statusIndicator.className = connected
    ? "w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_theme(--color-emerald-500)] transition-all"
    : "w-2 h-2 rounded-full bg-slate-300 transition-all";
  statusText.textContent = text;
  disconnectBtn.classList.toggle("hidden", !connected);
  terminateBtn?.classList.toggle("hidden", !connected);
}

function showAuthScreen(): void {
  authScreen.classList.remove("hidden");
  dashboard.classList.add("hidden");
  connectModal.classList.add("hidden");
  terminalContainer.classList.add("hidden");
}

function showDashboard(): void {
  authScreen.classList.add("hidden");
  terminalContainer.classList.add("hidden");
  connectModal.classList.add("hidden");
  dashboard.classList.remove("hidden");
  document.getElementById("demo-banner")!.classList.toggle("hidden", authMode !== "demo");
  setStatus(false, "Disconnected");
}

function showTerminal(): void {
  dashboard.classList.add("hidden");
  connectModal.classList.add("hidden");
  terminalContainer.classList.remove("hidden");
  if (terminalUI) {
    terminalUI.fit();
    terminalUI.focus();
  }
}

function showAuthError(msg: string): void {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}

function hideAuthError(): void {
  authError.classList.add("hidden");
}

function setAuthBtnLoading(btn: HTMLButtonElement, loading: boolean): void {
  btn.disabled = loading;
  const text = btn.querySelector(".btn-text")!;
  const spinner = btn.querySelector(".btn-spinner")!;
  if (loading) {
    text.classList.add("hidden");
    spinner.classList.remove("hidden");
  } else {
    text.classList.remove("hidden");
    spinner.classList.add("hidden");
  }
}

// Modal open/close
function openModal(): void {
  connectForm.reset();
  authType = "password";
  toggleBtns.forEach((b) => b.classList.toggle("active", b.dataset.auth === "password"));
  passwordField.classList.remove("hidden");
  keyField.classList.add("hidden");
  passphraseField.classList.add("hidden");
  hideError();
  setConnecting(false);
  connectModal.classList.remove("hidden");
}

function closeModal(): void {
  connectModal.classList.add("hidden");
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

// Active sessions rendering
function renderActiveSessions(sessions: SessionInfo[]): void {
  const container = document.getElementById("active-sessions")!;

  if (sessions.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = `<h3 class="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Active Sessions</h3>`;

  const grid = document.createElement("div");
  grid.className = "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4";

  for (const session of sessions) {
    const card = document.createElement("div");
    card.className = "relative bg-emerald-50 border border-emerald-200 rounded-lg p-4 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-400 group";

    const header = document.createElement("div");
    header.className = "flex items-center gap-2 mb-1";

    const liveBadge = document.createElement("span");
    liveBadge.className = "inline-flex items-center gap-1 text-[0.6rem] font-bold bg-emerald-100 text-emerald-700 border border-emerald-300 rounded px-1.5 py-0.5 uppercase";
    liveBadge.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span> Live`;
    header.appendChild(liveBadge);

    const duration = document.createElement("span");
    duration.className = "text-[0.6rem] text-slate-400";
    duration.textContent = formatDuration(Date.now() - session.createdAt);
    header.appendChild(duration);
    card.appendChild(header);

    const title = document.createElement("div");
    title.className = "font-mono text-sm font-semibold text-slate-800 pr-6";
    title.textContent = `${session.username}@${session.host}:${session.port}`;
    card.appendChild(title);

    const terminateSessionBtn = document.createElement("button");
    terminateSessionBtn.className = "absolute top-3 right-3 bg-transparent border-none text-slate-300 text-base cursor-pointer w-6 h-6 flex items-center justify-center rounded transition-all opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500";
    terminateSessionBtn.title = "Terminate";
    terminateSessionBtn.textContent = "\u00d7";
    terminateSessionBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await provider.terminate(session.id);
      const updated = await provider.listSessions();
      renderActiveSessions(updated);
    });
    card.appendChild(terminateSessionBtn);

    card.addEventListener("click", () => reconnectSession(session));
    grid.appendChild(card);
  }

  container.appendChild(grid);
}

// Reconnect to an existing session
async function reconnectSession(session: SessionInfo): Promise<void> {
  terminalUI = new TerminalUI(terminalEl);
  terminalUI.open();

  try {
    connection = await provider.reconnect(session.id);
    currentSessionId = session.id;

    const encoder = new TextEncoder();

    connection.onData((data) => {
      terminalUI?.write(data);
    });

    terminalUI.onData((data: string) => {
      connection?.send(encoder.encode(data));
    });

    terminalUI.onResize((size) => {
      connection?.resize?.(size.cols, size.rows);
    });

    setStatus(true, `${session.username}@${session.host}:${session.port}`);
    showTerminal();

    connectionCheckTimer = setInterval(() => {
      if (connection && !(connection.isConnected?.() ?? true)) {
        console.warn("[zerossh] connection lost (detected by health check)");
        handleDisconnect();
      }
    }, 3000);
  } catch (err) {
    terminalUI.dispose();
    terminalUI = null;
    terminalEl.innerHTML = "";
    console.error("[zerossh] reconnect error:", err);
  }
}

// Dashboard rendering
function renderDashboard(servers: SavedServer[]): void {
  serverGrid.innerHTML = "";

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const card = document.createElement("div");
    card.className = "relative bg-white border border-slate-200 rounded-lg p-4 cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md hover:border-emerald-300 group";

    const title = document.createElement("div");
    title.className = "font-sans text-sm font-semibold text-slate-800 mb-1 pr-6";
    title.textContent = server.name || `${server.username}@${server.host}:${server.port}`;
    card.appendChild(title);

    if (server.name) {
      const subtitle = document.createElement("div");
      subtitle.className = "font-mono text-xs text-slate-400 mb-2";
      subtitle.textContent = `${server.username}@${server.host}:${server.port}`;
      card.appendChild(subtitle);
    }

    const badge = document.createElement("span");
    if (server.authType === "password") {
      badge.className = "inline-block text-[0.6rem] font-semibold bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5 tracking-wide uppercase";
      badge.textContent = "Password";
    } else {
      badge.className = "inline-block text-[0.6rem] font-semibold bg-sky-50 text-sky-700 border border-sky-200 rounded px-1.5 py-0.5 tracking-wide uppercase";
      badge.textContent = "Key";
    }
    card.appendChild(badge);

    const removeBtn = document.createElement("button");
    removeBtn.className = "absolute top-3 right-3 bg-transparent border-none text-slate-300 text-base cursor-pointer w-6 h-6 flex items-center justify-center rounded transition-all opacity-0 group-hover:opacity-100 hover:bg-red-50 hover:text-red-500";
    removeBtn.title = "Remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const updated = servers.filter((_, idx) => idx !== i);
      await saveServers(updated);
      renderDashboard(updated);
    });
    card.appendChild(removeBtn);

    card.addEventListener("click", () => connectToServer(server, card));
    serverGrid.appendChild(card);
  }

  // "+" New Connection card
  const newCard = document.createElement("div");
  newCard.className = "flex flex-col items-center justify-center gap-2 bg-transparent border-2 border-dashed border-slate-200 rounded-lg p-4 cursor-pointer transition-all duration-200 text-slate-400 min-h-[88px] hover:border-emerald-400 hover:bg-emerald-50/50 hover:text-emerald-600";
  newCard.innerHTML = `<span class="text-2xl leading-none font-light">+</span><span class="text-xs font-medium">New Connection</span>`;
  newCard.addEventListener("click", openModal);
  serverGrid.appendChild(newCard);

  emptyState.classList.toggle("hidden", servers.length > 0);
}

// Direct connect from a saved server card
async function connectToServer(server: SavedServer, card: HTMLElement): Promise<void> {
  card.classList.add("connecting");
  card.querySelector(".card-error")?.remove();

  terminalUI = new TerminalUI(terminalEl);
  terminalUI.open();

  const config: ServerConfig = {
    host: server.host,
    port: server.port,
    username: server.username,
    authType: server.authType,
    credential: server.credential,
    passphrase: server.passphrase ?? "",
    cols: terminalUI.cols,
    rows: terminalUI.rows,
  };

  try {
    connection = await provider.connect(config);
    currentSessionId = connection.sessionId;

    const encoder = new TextEncoder();

    connection.onData((data) => {
      terminalUI?.write(data);
    });

    terminalUI.onData((data: string) => {
      connection?.send(encoder.encode(data));
    });

    terminalUI.onResize((size) => {
      connection?.resize?.(size.cols, size.rows);
    });

    setStatus(true, `${server.username}@${server.host}:${server.port}`);
    showTerminal();

    connectionCheckTimer = setInterval(() => {
      if (connection && !(connection.isConnected?.() ?? true)) {
        console.warn("[zerossh] connection lost (detected by health check)");
        handleDisconnect();
      }
    }, 3000);
  } catch (err) {
    terminalUI.dispose();
    terminalUI = null;
    terminalEl.innerHTML = "";
    card.classList.remove("connecting");

    const errEl = document.createElement("div");
    errEl.className = "card-error text-xs text-red-500 mt-2";
    errEl.textContent = err instanceof Error ? err.message : String(err);
    card.appendChild(errEl);

    setTimeout(() => errEl.remove(), 4000);
  }
}

async function onAuthenticated(): Promise<void> {
  showDashboard();

  try {
    const [servers, sessions] = await Promise.all([
      loadServers().catch(() => [] as SavedServer[]),
      provider.listSessions().catch(() => [] as SessionInfo[]),
    ]);
    renderActiveSessions(sessions);
    renderDashboard(servers);
  } catch {
    renderDashboard([]);
  }
}

// Auth initialization
async function initApp(): Promise<void> {
  showAuthScreen();

  let status: AuthStatus;
  try {
    status = await checkAuthStatus();
  } catch {
    showAuthError("Failed to check auth status");
    authLoading.classList.add("hidden");
    return;
  }

  authLoading.classList.add("hidden");
  authMode = status.mode;

  if (status.authenticated) {
    await onAuthenticated();
    return;
  }

  authActions.classList.remove("hidden");

  if (status.mode === "demo") {
    turnstileContainer.classList.remove("hidden");
    if (status.turnstileSiteKey) {
      loadTurnstile(status.turnstileSiteKey);
    } else {
      try {
        await loginDemo("");
        await onAuthenticated();
      } catch (err) {
        showAuthError(err instanceof Error ? err.message : String(err));
      }
    }
  } else if (status.registered) {
    loginBtn.classList.remove("hidden");
  } else {
    registerBtn.classList.remove("hidden");
  }
}

function loadTurnstile(siteKey: string): void {
  const script = document.createElement("script");
  script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad";
  script.async = true;
  document.head.appendChild(script);

  (window as unknown as Record<string, unknown>).onTurnstileLoad = () => {
    (window as unknown as Record<string, { render: (el: string | HTMLElement, opts: Record<string, unknown>) => void }>).turnstile.render(turnstileContainer, {
      sitekey: siteKey,
      callback: async (token: string) => {
        try {
          await loginDemo(token);
          await onAuthenticated();
        } catch (err) {
          showAuthError(err instanceof Error ? err.message : String(err));
        }
      },
    });
  };
}

// Register button handler
registerBtn.addEventListener("click", async () => {
  hideAuthError();
  setAuthBtnLoading(registerBtn, true);
  try {
    await registerPasskey();
    await onAuthenticated();
  } catch (err) {
    showAuthError(err instanceof Error ? err.message : String(err));
    setAuthBtnLoading(registerBtn, false);
  }
});

// Login button handler
loginBtn.addEventListener("click", async () => {
  hideAuthError();
  setAuthBtnLoading(loginBtn, true);
  try {
    await loginPasskey();
    await onAuthenticated();
  } catch (err) {
    showAuthError(err instanceof Error ? err.message : String(err));
    setAuthBtnLoading(loginBtn, false);
  }
});

async function handleConnect(e: Event): Promise<void> {
  e.preventDefault();
  hideError();
  setConnecting(true);

  const connName = (document.getElementById("conn-name") as HTMLInputElement).value.trim();
  const host = (document.getElementById("host") as HTMLInputElement).value;
  const port = (document.getElementById("port") as HTMLInputElement).value;
  const username = (document.getElementById("username") as HTMLInputElement).value;

  let credential: string;
  let passphrase = "";

  if (authType === "password") {
    credential = (document.getElementById("password") as HTMLInputElement).value;
  } else {
    credential = (document.getElementById("private-key") as HTMLTextAreaElement).value;
    passphrase = (document.getElementById("passphrase") as HTMLInputElement).value;
  }

  terminalUI = new TerminalUI(terminalEl);
  terminalUI.open();

  const cols = terminalUI.cols;
  const rows = terminalUI.rows;

  const config: ServerConfig = {
    host,
    port: parseInt(port, 10),
    username,
    authType: authType as "password" | "key",
    credential,
    passphrase,
    cols,
    rows,
  };

  try {
    connection = await provider.connect(config);
    currentSessionId = connection.sessionId;

    const encoder = new TextEncoder();

    connection.onData((data) => {
      terminalUI?.write(data);
    });

    terminalUI.onData((data: string) => {
      connection?.send(encoder.encode(data));
    });

    terminalUI.onResize((size) => {
      connection?.resize?.(size.cols, size.rows);
    });

    setStatus(true, `${username}@${host}:${port}`);
    closeModal();
    showTerminal();

    // Save server if checkbox is checked
    const saveCheckbox = document.getElementById("save-server") as HTMLInputElement;
    if (saveCheckbox.checked) {
      try {
        const servers = await loadServers();
        const exists = servers.some(
          (s) => s.host === host && s.port === parseInt(port) && s.username === username,
        );
        if (!exists) {
          servers.push({
            name: connName || undefined,
            host,
            port: parseInt(port),
            username,
            authType: authType as "password" | "key",
            credential,
            passphrase: passphrase || undefined,
          });
          await saveServers(servers);
        }
      } catch {
        // ignore save error
      }
    }

    connectionCheckTimer = setInterval(() => {
      if (connection && !(connection.isConnected?.() ?? true)) {
        console.warn("[zerossh] connection lost (detected by health check)");
        handleDisconnect();
      }
    }, 3000);
  } catch (err) {
    terminalUI.dispose();
    terminalUI = null;
    terminalEl.innerHTML = "";
    const msg = err instanceof Error ? err.message : String(err);
    showError(msg);
    setConnecting(false);
  }
}

async function handleDisconnect(): Promise<void> {
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }
  if (connection) {
    // Only close the WebSocket; session stays alive in the DO
    await connection.close();
    connection = null;
  }
  currentSessionId = null;
  terminalUI?.dispose();
  terminalUI = null;
  terminalEl.innerHTML = "";

  await onAuthenticated();
}

async function handleTerminate(): Promise<void> {
  if (connectionCheckTimer) {
    clearInterval(connectionCheckTimer);
    connectionCheckTimer = null;
  }
  const sessionId = currentSessionId;
  if (connection) {
    await connection.close();
    connection = null;
  }
  if (sessionId) {
    await provider.terminate(sessionId);
  }
  currentSessionId = null;
  terminalUI?.dispose();
  terminalUI = null;
  terminalEl.innerHTML = "";

  await onAuthenticated();
}

// Event listeners
connectForm.addEventListener("submit", handleConnect);
disconnectBtn.addEventListener("click", handleDisconnect);
terminateBtn?.addEventListener("click", handleTerminate);

// Modal close handlers
document.getElementById("modal-close-btn")!.addEventListener("click", closeModal);
connectModal.querySelector(".modal-backdrop")!.addEventListener("click", closeModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !connectModal.classList.contains("hidden")) {
    closeModal();
  }
});

// Logout from dashboard header
const logoutBtn = document.getElementById("logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await logout();
    location.reload();
  });
}

// Start app
initApp();
