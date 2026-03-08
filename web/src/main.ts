import "./style.css";
import "@xterm/xterm/css/xterm.css";
import init, { SshClient } from "zerossh-wasm";
import { TerminalUI } from "./terminal";

let client: SshClient | null = null;
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

  // Build WebSocket URL (same origin)
  const wsProto = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${wsProto}//${location.host}/proxy?host=${encodeURIComponent(host)}&port=${encodeURIComponent(port)}`;

  // Create terminal
  terminalUI = new TerminalUI(terminalEl);
  terminalUI.open();

  const cols = terminalUI.cols;
  const rows = terminalUI.rows;

  try {
    // Initialize WASM
    await init();

    // Data callback: write SSH output to terminal
    const onData = (data: Uint8Array) => {
      terminalUI?.write(data);
    };

    // Connect SSH
    client = await SshClient.connect(
      wsUrl,
      username,
      authType,
      credential,
      passphrase,
      cols,
      rows,
      onData,
    );

    // Terminal input -> SSH (await to detect send failures)
    terminalUI.onData((data: string) => {
      const encoder = new TextEncoder();
      client?.send_data(encoder.encode(data)).catch(() => {
        handleDisconnect();
      });
    });

    // Terminal resize -> SSH
    terminalUI.onResize((size) => {
      client?.resize(size.cols, size.rows);
    });

    setStatus(true, `${username}@${host}:${port}`);
    showTerminal();

    // Poll connection health every 3 seconds
    connectionCheckTimer = setInterval(() => {
      if (client && !client.is_connected()) {
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
  // Try graceful disconnect with a timeout — if the event loop is stuck,
  // the disconnect call will hang, so we race it with a 2s timer.
  if (client) {
    try {
      await Promise.race([
        client.disconnect(),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      // ignore disconnect errors
    }
    client.free();
    client = null;
  }
  terminalUI?.dispose();
  terminalUI = null;
  terminalEl.innerHTML = "";
  showConnectPanel();
}

// Event listeners
connectForm.addEventListener("submit", handleConnect);
disconnectBtn.addEventListener("click", handleDisconnect);
