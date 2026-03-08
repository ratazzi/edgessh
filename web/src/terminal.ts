import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";

export class TerminalUI {
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private container: HTMLElement;
  private pendingData: Uint8Array[] = [];
  private rafScheduled = false;

  constructor(container: HTMLElement) {
    this.container = container;
    this.fitAddon = new FitAddon();
    this.terminal = new Terminal({
      fontFamily: '"IBM Plex Mono", "SF Mono", "Cascadia Code", monospace',
      fontSize: 14,
      lineHeight: 1.2,
      theme: {
        background: "#0a0e14",
        foreground: "#e6edf3",
        cursor: "#3fb950",
        cursorAccent: "#0a0e14",
        selectionBackground: "rgba(63, 185, 80, 0.25)",
        black: "#484f58",
        red: "#f85149",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39d353",
        white: "#e6edf3",
        brightBlack: "#6e7681",
        brightRed: "#ff7b72",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d364",
        brightWhite: "#f0f6fc",
      },
      cursorBlink: true,
      cursorStyle: "block",
      allowProposedApi: true,
    });
  }

  open(): void {
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(this.container);
    try {
      this.terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL not available, fallback to canvas renderer
    }
    this.fit();
    window.addEventListener("resize", () => this.fit());
  }

  fit(): void {
    this.fitAddon.fit();
  }

  get cols(): number {
    return this.terminal.cols;
  }

  get rows(): number {
    return this.terminal.rows;
  }

  write(data: Uint8Array): void {
    this.pendingData.push(data);
    if (!this.rafScheduled) {
      this.rafScheduled = true;
      requestAnimationFrame(() => this.flushPending());
    }
  }

  private flushPending(): void {
    this.rafScheduled = false;
    const chunks = this.pendingData;
    this.pendingData = [];
    // Concatenate into single write to minimize xterm.js reflows
    if (chunks.length === 1) {
      this.terminal.write(chunks[0]);
    } else if (chunks.length > 1) {
      let total = 0;
      for (const c of chunks) total += c.length;
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        merged.set(c, offset);
        offset += c.length;
      }
      this.terminal.write(merged);
    }
  }

  onData(cb: (data: string) => void): void {
    this.terminal.onData(cb);
  }

  onResize(cb: (size: { cols: number; rows: number }) => void): void {
    this.terminal.onResize(cb);
    window.addEventListener("resize", () => {
      this.fit();
    });
  }

  focus(): void {
    this.terminal.focus();
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
