import "./style.css";
import "@xterm/xterm/css/xterm.css";
import { WsProxyProvider, type Connection, type ServerConfig } from "./transport";
import { TerminalUI } from "./terminal";
import { checkAuthStatus, registerPasskey, loginPasskey, loginDemo, logout, type AuthStatus } from "./auth";
import { loadServers, saveServers, type SavedServer } from "./servers";

const provider = new WsProxyProvider();
let connection: Connection | null = null;
let terminalUI: TerminalUI | null = null;
let connectionCheckTimer: ReturnType<typeof setInterval> | null = null;

// DOM elements
const authScreen = document.getElementById("auth-screen")!;
const authLoading = document.getElementById("auth-loading")!;
const authActions = document.getElementById("auth-actions")!;
const authError = document.getElementById("auth-error")!;
const registerBtn = document.getElementById("register-btn") as HTMLButtonElement;
const loginBtn = document.getElementById("login-btn") as HTMLButtonElement;
const turnstileContainer = document.getElementById("turnstile-container")!;

const connectPanel = document.getElementById("connect-panel")!;
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

function setStatus(connected: boolean, text: string): void {
  statusIndicator.classList.toggle("connected", connected);
  statusText.textContent = text;
  disconnectBtn.classList.toggle("hidden", !connected);
}

function showAuthScreen(): void {
  authScreen.classList.remove("hidden");
  connectPanel.classList.add("hidden");
  terminalContainer.classList.add("hidden");
}

function showConnectPanel(): void {
  authScreen.classList.add("hidden");
  terminalContainer.classList.add("hidden");
  connectPanel.classList.remove("hidden", "slide-out");
  setConnecting(false);
  setStatus(false, "Disconnected");
}

function showTerminal(): void {
  connectPanel.classList.add("slide-out");
  setTimeout(() => {
    connectPanel.classList.add("hidden");
    terminalContainer.classList.remove("hidden");
    if (terminalUI) {
      terminalUI.fit();
      terminalUI.focus();
    }
  }, 350);
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

function fillFormFromServer(server: SavedServer): void {
  (document.getElementById("host") as HTMLInputElement).value = server.host;
  (document.getElementById("port") as HTMLInputElement).value = String(server.port);
  (document.getElementById("username") as HTMLInputElement).value = server.username;

  // Set auth type
  authType = server.authType;
  toggleBtns.forEach((b) => {
    b.classList.toggle("active", b.dataset.auth === authType);
  });
  passwordField.classList.toggle("hidden", authType !== "password");
  keyField.classList.toggle("hidden", authType !== "key");
  passphraseField.classList.toggle("hidden", authType !== "key");

  // Fill credentials
  if (authType === "password") {
    (document.getElementById("password") as HTMLInputElement).value = server.credential;
  } else {
    (document.getElementById("private-key") as HTMLTextAreaElement).value = server.credential;
    (document.getElementById("passphrase") as HTMLInputElement).value = server.passphrase ?? "";
  }
}

// Server list
function renderServerList(servers: SavedServer[]): void {
  const section = document.getElementById("server-list-section");
  if (!section) return;

  const list = section.querySelector(".server-list")!;
  list.innerHTML = "";

  if (servers.length === 0) {
    section.classList.add("hidden");
    return;
  }

  section.classList.remove("hidden");
  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    const item = document.createElement("div");
    item.className = "server-item";

    const info = document.createElement("span");
    info.className = "server-info";
    info.textContent = `${server.username}@${server.host}:${server.port}`;
    info.addEventListener("click", () => fillFormFromServer(server));

    const removeBtn = document.createElement("button");
    removeBtn.className = "server-remove";
    removeBtn.title = "Remove";
    removeBtn.textContent = "\u00d7";
    removeBtn.addEventListener("click", async () => {
      const updated = servers.filter((_, idx) => idx !== i);
      await saveServers(updated);
      renderServerList(updated);
    });

    item.appendChild(info);
    item.appendChild(removeBtn);
    list.appendChild(item);
  }
}

async function onAuthenticated(): Promise<void> {
  showConnectPanel();

  // Load saved servers
  try {
    const servers = await loadServers();
    renderServerList(servers);
  } catch {
    // ignore
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

  if (status.authenticated) {
    await onAuthenticated();
    return;
  }

  authActions.classList.remove("hidden");

  if (status.mode === "demo") {
    // Demo mode: show Turnstile widget
    turnstileContainer.classList.remove("hidden");
    if (status.turnstileSiteKey) {
      loadTurnstile(status.turnstileSiteKey);
    } else {
      // No Turnstile configured, just create demo session directly
      try {
        await loginDemo("");
        await onAuthenticated();
      } catch (err) {
        showAuthError(err instanceof Error ? err.message : String(err));
      }
    }
  } else if (status.registered) {
    // Self-deploy: already registered, show login
    loginBtn.classList.remove("hidden");
  } else {
    // Self-deploy: not registered, show register
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

  // Create terminal
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
    showTerminal();

    // Save server if checkbox is checked
    const saveCheckbox = document.getElementById("save-server") as HTMLInputElement | null;
    if (saveCheckbox?.checked) {
      try {
        const servers = await loadServers();
        const exists = servers.some(
          (s) => s.host === host && s.port === parseInt(port) && s.username === username,
        );
        if (!exists) {
          servers.push({
            host,
            port: parseInt(port),
            username,
            authType: authType as "password" | "key",
            credential,
            passphrase: passphrase || undefined,
          });
          await saveServers(servers);
          renderServerList(servers);
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
    await connection.close();
    connection = null;
  }
  terminalUI?.dispose();
  terminalUI = null;
  terminalEl.innerHTML = "";
  showConnectPanel();
}

// Event listeners
connectForm.addEventListener("submit", handleConnect);
disconnectBtn.addEventListener("click", handleDisconnect);

// Logout from status bar
const logoutBtn = document.getElementById("logout-btn");
if (logoutBtn) {
  logoutBtn.addEventListener("click", async () => {
    await logout();
    location.reload();
  });
}

// Start app
initApp();
