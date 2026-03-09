import "./style.css";
import "@xterm/xterm/css/xterm.css";
import { WsProxyProvider, type Connection, type ServerConfig } from "./transport";
import { TerminalUI } from "./terminal";

const provider = new WsProxyProvider();
let connection: Connection | null = null;
let terminalUI: TerminalUI | null = null;
let connectionCheckTimer: ReturnType<typeof setInterval> | null = null;

// DOM elements
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

function showConnectPanel(): void {
  terminalContainer.classList.add("hidden");
  connectPanel.classList.remove("hidden", "slide-out");
  setConnecting(false);
  setStatus(false, "Disconnected");
}

async function handleConnect(e: Event): Promise<void> {
  e.preventDefault();
  hideError();
  setConnecting(true);

  const host = (document.getElementById("host") as HTMLInputElement).value;
  const port = (document.getElementById("port") as HTMLInputElement).value;
  const username = (document.getElementById("username") as HTMLInputElement)
    .value;

  let credential: string;
  let passphrase = "";

  if (authType === "password") {
    credential = (document.getElementById("password") as HTMLInputElement)
      .value;
  } else {
    credential = (
      document.getElementById("private-key") as HTMLTextAreaElement
    ).value;
    passphrase = (document.getElementById("passphrase") as HTMLInputElement)
      .value;
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
