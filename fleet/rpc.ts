/** JSONL RPC client for one headless `pi --mode rpc` member process.
 *
 * Protocol per docs/rpc.md: strict JSONL on stdin/stdout, split on "\n" only
 * (Node readline is not compliant because it splits on U+2028/U+2029).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import * as path from "node:path";
import { mkdir } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

export type RpcEventHandler = (event: any) => void;
export type RpcExitHandler = (code: number | null) => void;

export interface RpcSpawnOptions {
  piBin: string;
  /** Member worktree; becomes the member's cwd. */
  cwd: string;
  /** Extra pi CLI args (--mode rpc is added by create()). */
  args: string[];
  /** JSONL event tee. */
  logFile: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Quote one argument for cmd.exe on Windows. */
export function winQuote(arg: string): string {
  if (arg.length === 0) return '""';
  if (/["&|<>^%!\r\n]/.test(arg)) {
    throw new Error(`Refusing to pass unsafe argument through cmd.exe: ${arg}`);
  }
  // Safe characters that need no quoting in cmd.exe (excludes whitespace, =, ,, ;).
  if (/^[A-Za-z0-9_\-./:\\]+$/.test(arg)) return arg;
  // Double trailing backslashes so they do not escape the closing quote.
  const escaped = arg.replace(/\\+$/, (m) => m + m);
  return `"${escaped}"`;
}

export async function killProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) =>
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve()),
    );
  } else {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
  }
}

export class RpcMember {
  readonly proc: ChildProcess;
  readonly pid: number;
  exited = false;
  exitCode: number | null = null;
  busy = false;
  lastEventAt = Date.now();

  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private handlers = new Set<RpcEventHandler>();
  private exitHandlers = new Set<RpcExitHandler>();
  private log?: WriteStream;
  private spawnError?: Error;
  private exitNotified = false;

  private constructor(opts: RpcSpawnOptions) {
    const isWin = process.platform === "win32";
    const fullArgs = ["--mode", "rpc", ...opts.args];
    if (isWin) {
      // Node refuses .cmd without cmd.exe; /s /c with an outer-quoted command avoids DEP0190.
      const cmdLine = [winQuote(opts.piBin), ...fullArgs.map(winQuote)].join(" ");
      this.proc = spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${cmdLine}"`], {
        cwd: opts.cwd,
        shell: false,
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    } else {
      this.proc = spawn(opts.piBin, fullArgs, {
        cwd: opts.cwd,
        shell: false,
        detached: true, // POSIX: own process group for clean tree kill
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: process.env,
      });
    }
    this.pid = this.proc.pid ?? -1;
    this.log = createWriteStream(opts.logFile, { flags: "a" });
    this.log.on("error", () => {
      this.log = undefined;
    });
    this.proc.stdin?.on("error", () => {
      // Handled via write callback and process exit.
    });

    this.proc.stdout?.on("data", (c: Buffer) => this.onData(c));
    this.proc.stdout?.on("end", () => this.onStdoutEnd());
    this.proc.stderr?.on("data", (c: Buffer) => this.writeLog(c));
    this.proc.on("error", (err) => {
      this.spawnError = err;
      this.exited = true;
      this.writeLog(`[fleet] spawn error: ${err.message}\n`);
      this.failPending(new Error(`member spawn error: ${err.message}`));
      this.closeLog();
      this.emitExit(null);
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      this.failPending(new Error("member process exited"));
    });
    this.proc.on("close", (code) => {
      this.closeLog();
      this.emitExit(code);
    });
  }

  static async create(opts: RpcSpawnOptions): Promise<RpcMember> {
    await mkdir(path.dirname(opts.logFile), { recursive: true });
    return new RpcMember(opts);
  }

  private writeLog(chunk: string | Buffer): void {
    if (this.log && !this.log.destroyed && !this.log.writableEnded) {
      this.log.write(chunk);
    }
  }

  private closeLog(): void {
    const log = this.log;
    this.log = undefined;
    if (log && !log.destroyed && !log.writableEnded) {
      log.end();
    }
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private emitExit(code: number | null): void {
    if (this.exitNotified) return;
    this.exitNotified = true;
    for (const h of this.exitHandlers) {
      try {
        h(code);
      } catch {
        // ignore exit handler error
      }
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    let start = 0;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n", start)) >= 0) {
      const line = this.buffer.slice(start, idx).replace(/\r$/, "");
      start = idx + 1;
      this.processLine(line);
    }
    if (start > 0) this.buffer = this.buffer.slice(start);
  }

  private onStdoutEnd(): void {
    this.buffer += this.decoder.end();
    const trailing = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    if (trailing.trim()) {
      this.processLine(trailing);
    }
  }

  private processLine(line: string): void {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      this.writeLog(line + "\n"); // non-JSON noise, keep for debugging
      return;
    }
    this.writeLog(line + "\n");
    this.lastEventAt = Date.now();

    if (msg.type === "response" && typeof msg.id === "string" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.data);
      else p.reject(new Error(msg.error ?? `RPC command failed: ${msg.command}`));
      return;
    }
    if (msg.type === "agent_start") this.busy = true;
    if (msg.type === "agent_end" || msg.type === "agent_settled") this.busy = false;
    for (const h of this.handlers) {
      try {
        h(msg);
      } catch {
        // Never let a handler kill the pump.
      }
    }
  }

  onEvent(handler: RpcEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onExit(handler: RpcExitHandler): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  /** Send one command, await its correlated response. */
  send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (this.exited) return Promise.reject(new Error("member process exited"));
    const stdin = this.proc.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded) {
      return Promise.reject(new Error("member stdin is closed"));
    }
    const id = `fleet-${++this.seq}`;
    const payload = JSON.stringify({ id, ...command });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response to '${command.type}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      stdin.write(payload + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<any> {
    return this.send(
      { type: "prompt", message, ...(streamingBehavior ? { streamingBehavior } : {}) },
      60_000,
    );
  }

  steer(message: string): Promise<any> {
    return this.send({ type: "steer", message }, 60_000);
  }

  followUp(message: string): Promise<any> {
    return this.send({ type: "follow_up", message }, 60_000);
  }

  abort(): Promise<any> {
    return this.send({ type: "abort" }, 10_000);
  }

  getState(): Promise<any> {
    return this.send({ type: "get_state" }, 10_000);
  }

  /** Poll get_state until the member answers (RPC ready). */
  async waitReady(timeoutMs = 120_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.exited) {
        if (this.spawnError) {
          throw new Error(`member failed to start: ${this.spawnError.message}`);
        }
        throw new Error(`member exited during startup (code ${this.exitCode})`);
      }
      try {
        await this.getState();
        return;
      } catch {
        if (this.exited) continue;
        await sleep(500);
      }
    }
    throw new Error("member did not become ready in time");
  }

  /** Stop receiving events and close the log (does not kill the process). */
  detach(): void {
    this.handlers.clear();
    this.exitHandlers.clear();
    this.closeLog();
  }

  /** Kill the member process tree. */
  async kill(): Promise<void> {
    if (this.exited) return;
    await killProcessTree(this.pid, "SIGTERM");
    const start = Date.now();
    while (!this.exited && Date.now() - start < 5_000) await sleep(100);
    if (!this.exited && process.platform !== "win32") {
      await killProcessTree(this.pid, "SIGKILL");
      const killStart = Date.now();
      while (!this.exited && Date.now() - killStart < 2_000) await sleep(100);
    }
  }
}
