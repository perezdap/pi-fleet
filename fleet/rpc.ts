/** JSONL RPC client for one headless `pi --mode rpc` member process.
 *
 * Protocol per docs/rpc.md: strict JSONL on stdin/stdout, split on "\n" only
 * (Node readline is not compliant because it splits on U+2028/U+2029).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import * as path from "node:path";
import { mkdir } from "node:fs/promises";

export type RpcEventHandler = (event: any) => void;

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

/** Quote one argument for `shell: true` on Windows (cmd.exe). */
function winQuote(arg: string): string {
  // Safe characters that need no quoting in cmd.
  if (/^[A-Za-z0-9_\-./:\\=]+$/.test(arg)) return arg;
  if (/["&|<>^%!]/.test(arg)) {
    throw new Error(`Refusing to pass unsafe argument through cmd.exe: ${arg}`);
  }
  return `"${arg}"`;
}

export async function killProcessTree(pid: number): Promise<void> {
  if (!pid || pid <= 0) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) =>
      execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => resolve()),
    );
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
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
  private seq = 0;
  private pending = new Map<
    string,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private handlers = new Set<RpcEventHandler>();
  private log?: WriteStream;

  private constructor(opts: RpcSpawnOptions) {
    const isWin = process.platform === "win32";
    // Windows needs shell:true to run pi.cmd (Node refuses .cmd without shell).
    const args = ["--mode", "rpc", ...opts.args].map((a) => (isWin ? winQuote(a) : a));
    this.proc = spawn(opts.piBin, args, {
      cwd: opts.cwd,
      shell: isWin,
      detached: !isWin, // POSIX: own process group for clean tree kill
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
    this.pid = this.proc.pid ?? -1;
    this.log = createWriteStream(opts.logFile, { flags: "a" });

    this.proc.stdout?.on("data", (c: Buffer) => this.onData(c));
    this.proc.stderr?.on("data", (c: Buffer) => this.log?.write(c));
    this.proc.on("error", (err) => {
      this.log?.write(`[fleet] spawn error: ${err.message}\n`);
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("member process exited"));
      }
      this.pending.clear();
    });
  }

  static async create(opts: RpcSpawnOptions): Promise<RpcMember> {
    await mkdir(path.dirname(opts.logFile), { recursive: true });
    return new RpcMember(opts);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        this.log?.write(line + "\n"); // non-JSON noise, keep for debugging
        continue;
      }
      this.log?.write(line + "\n");
      this.lastEventAt = Date.now();

      if (msg.type === "response" && typeof msg.id === "string" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.success) p.resolve(msg.data);
        else p.reject(new Error(msg.error ?? `RPC command failed: ${msg.command}`));
        continue;
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
  }

  onEvent(handler: RpcEventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /** Send one command, await its correlated response. */
  send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
    if (this.exited) return Promise.reject(new Error("member process exited"));
    const id = `fleet-${++this.seq}`;
    const payload = JSON.stringify({ id, ...command });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for response to '${command.type}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin?.write(payload + "\n", (err) => {
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
        throw new Error(`member exited during startup (code ${this.exitCode})`);
      }
      try {
        await this.getState();
        return;
      } catch {
        await sleep(500);
      }
    }
    throw new Error("member did not become ready in time");
  }

  /** Stop receiving events and close the log (does not kill the process). */
  detach(): void {
    this.handlers.clear();
    this.log?.end();
    this.log = undefined;
  }

  /** Kill the member process tree. */
  async kill(): Promise<void> {
    if (this.exited) return;
    await killProcessTree(this.pid);
    const start = Date.now();
    while (!this.exited && Date.now() - start < 5_000) await sleep(100);
  }
}
