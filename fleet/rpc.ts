/** JSONL RPC client for one headless `pi --mode rpc` member process.
 *
 * Protocol per pi's RPC spec: strict JSONL on stdin/stdout, split on "\n" only
 * (Node readline is not compliant because it splits on U+2028/U+2029).
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isPidAlive } from "./manifest.ts";

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

export interface ProcessInfo {
  commandLine: string;
  startedAt?: string;
}

export type ProcessInfoResult =
  | { status: "ok"; info: ProcessInfo }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Check whether a live process's command line identifies this Fleet member. */
export function hasFleetCommandIdentity(commandLine: string, memberName: string): boolean {
  if (!commandLine.trim()) return false;
  const hasRpcMode = /(?:^|[\s"'])--mode[\s"']+rpc(?:$|[\s"'])/.test(commandLine);
  const memberToken = new RegExp(`(?:^|[\\s"'])fleet:${escapeRegExp(memberName)}(?:$|[\\s"'])`);
  return hasRpcMode && memberToken.test(commandLine);
}

/** Inspect OS process metadata (command line + start time) to guard against PID reuse. */
export async function getProcessInfo(pid: number): Promise<ProcessInfoResult> {
  if (!Number.isInteger(pid) || pid <= 0) return { status: "not_found" };

  if (process.platform === "linux") {
    try {
      const [cmdlineBuf, statRaw] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const commandLine = cmdlineBuf
        .toString("utf8")
        .split("\0")
        .filter(Boolean)
        .join(" ");
      const rparen = statRaw.lastIndexOf(")");
      let startedAt: string | undefined;
      if (rparen >= 0) {
        const fields = statRaw.slice(rparen + 2).trim().split(/\s+/);
        // Field 22 in /proc/<pid>/stat is starttime (index 19 after comm/state/ppid).
        if (fields[19]) startedAt = fields[19];
      }
      if (!commandLine) return { status: "not_found" };
      return { status: "ok", info: { commandLine, startedAt } };
    } catch (err: any) {
      if (err?.code === "ENOENT" || err?.code === "ESRCH") {
        return { status: "not_found" };
      }
      return { status: "unavailable", reason: err?.message ?? String(err) };
    }
  }

  if (process.platform === "win32") {
    return new Promise<ProcessInfoResult>((resolve) => {
      const script =
        `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; ` +
        `if ($null -eq $p) { '' } else { ` +
        `$s = if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }; ` +
        `[pscustomobject]@{ startedAt = $s; commandLine = [string]$p.CommandLine } | ConvertTo-Json -Compress }`;
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10_000 },
        (err, stdout) => {
          if (err) {
            resolve({ status: "unavailable", reason: err.message });
            return;
          }
          const trimmed = stdout.trim();
          if (!trimmed) {
            resolve({ status: "not_found" });
            return;
          }
          try {
            const parsed = JSON.parse(trimmed);
            const commandLine = typeof parsed?.commandLine === "string" ? parsed.commandLine : "";
            const startedAt =
              typeof parsed?.startedAt === "string" && parsed.startedAt ? parsed.startedAt : undefined;
            if (!commandLine) {
              resolve({ status: "unavailable", reason: "empty commandLine" });
              return;
            }
            resolve({ status: "ok", info: { commandLine, startedAt } });
          } catch (parseErr: any) {
            resolve({ status: "unavailable", reason: parseErr?.message ?? String(parseErr) });
          }
        },
      );
    });
  }

  // macOS and other POSIX platforms
  return new Promise<ProcessInfoResult>((resolve) => {
    execFile(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 5_000, env: { ...process.env, LC_ALL: "C" } },
      (startErr, startOut) => {
        if (startErr) {
          resolve(isPidAlive(pid) ? { status: "unavailable", reason: startErr.message } : { status: "not_found" });
          return;
        }
        const startedAt = startOut.trim() || undefined;
        execFile("ps", ["-ww", "-o", "args=", "-p", String(pid)], { timeout: 5_000 }, (argsErr, argsOut) => {
          if (argsErr) {
            resolve(isPidAlive(pid) ? { status: "unavailable", reason: argsErr.message } : { status: "not_found" });
            return;
          }
          const commandLine = argsOut.trim();
          if (!commandLine) {
            resolve({ status: "not_found" });
            return;
          }
          resolve({ status: "ok", info: { commandLine, startedAt } });
        });
      },
    );
  });
}

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

export async function waitForPidExit(
  pid: number,
  timeoutMs: number,
  checkAlive: (pid: number) => boolean = isPidAlive,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (checkAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
  return true;
}

export async function terminateProcessTreeVerified(
  pid: number,
  opts?: {
    termTimeoutMs?: number;
    killTimeoutMs?: number;
    killTree?: (pid: number, signal?: NodeJS.Signals) => Promise<void>;
    checkAlive?: (pid: number) => boolean;
  },
): Promise<boolean> {
  const killTree = opts?.killTree ?? killProcessTree;
  const checkAlive = opts?.checkAlive ?? isPidAlive;
  const termTimeoutMs = opts?.termTimeoutMs ?? 3_000;
  const killTimeoutMs = opts?.killTimeoutMs ?? 2_000;

  if (!checkAlive(pid)) return true;
  await killTree(pid, "SIGTERM");
  if (await waitForPidExit(pid, termTimeoutMs, checkAlive)) return true;

  if (process.platform !== "win32") {
    await killTree(pid, "SIGKILL");
    if (await waitForPidExit(pid, killTimeoutMs, checkAlive)) return true;
  }
  return !checkAlive(pid);
}

export class RpcMember {
  readonly proc: ChildProcess;
  readonly pid: number;
  exited = false;
  exitCode: number | null = null;
  busy = false;

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
  private stdoutFlushed = false;
  private finalized = false;
  private detached = false;
  private exitDrainTimer?: NodeJS.Timeout;
  private readonly onStdoutDataBound: (c: Buffer) => void;
  private readonly onStdoutEndBound: () => void;
  private readonly onStderrDataBound: (c: Buffer) => void;

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

    this.onStdoutDataBound = (c: Buffer) => this.onData(c);
    this.onStdoutEndBound = () => this.onStdoutEnd();
    this.onStderrDataBound = (c: Buffer) => this.writeLog(c);

    this.proc.stdout?.on("data", this.onStdoutDataBound);
    this.proc.stdout?.on("end", this.onStdoutEndBound);
    this.proc.stderr?.on("data", this.onStderrDataBound);
    this.proc.on("error", (err) => {
      this.spawnError = err;
      this.exited = true;
      this.finalized = true;
      this.writeLog(`[fleet] spawn error: ${err.message}\n`);
      this.teardown({
        err: new Error(`member spawn error: ${err.message}`),
        destroyStreams: true,
        flushStdout: false,
        notifyExit: true,
        exitCode: null,
      });
    });
    this.proc.on("exit", (code) => {
      this.exited = true;
      this.exitCode = code;
      // Do not fail pending requests immediately on 'exit': stdout may still have
      // a buffered final response (especially without a trailing newline). Always
      // schedule a bounded drain timer so a grandchild inheriting stdout/stderr
      // cannot delay finalization, log closure, or Fleet exit handling.
      if (this.stdoutFlushed) {
        this.finalizeExit(code);
      } else if (!this.finalized && !this.exitDrainTimer) {
        this.exitDrainTimer = setTimeout(() => {
          this.exitDrainTimer = undefined;
          this.finalizeExit(code);
        }, 250);
        this.exitDrainTimer.unref();
      }
    });
    this.proc.on("close", (code) => {
      this.finalizeExit(code);
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

  private teardown(opts: {
    err: Error;
    destroyStreams: boolean;
    flushStdout: boolean;
    notifyExit: boolean;
    exitCode?: number | null;
  }): void {
    this.clearExitDrainTimer();
    if (opts.flushStdout) {
      this.onStdoutEnd();
    }
    this.proc.stdout?.off("data", this.onStdoutDataBound);
    this.proc.stdout?.off("end", this.onStdoutEndBound);
    this.proc.stderr?.off("data", this.onStderrDataBound);
    if (opts.destroyStreams) {
      if (this.proc.stdout && !this.proc.stdout.destroyed) {
        this.proc.stdout.destroy();
      }
      if (this.proc.stderr && !this.proc.stderr.destroyed) {
        this.proc.stderr.destroy();
      }
    }
    this.failPending(opts.err);
    this.closeLog();
    if (opts.notifyExit) {
      this.emitExit(opts.exitCode ?? this.exitCode);
    } else {
      this.handlers.clear();
      this.exitHandlers.clear();
    }
  }

  private finalizeExit(code: number | null): void {
    if (this.finalized) return;
    this.finalized = true;
    this.exited = true;
    if (this.exitCode === null) this.exitCode = code;
    this.teardown({
      err: new Error("member process exited"),
      destroyStreams: true,
      flushStdout: true,
      notifyExit: true,
      exitCode: this.exitCode,
    });
  }

  private clearExitDrainTimer(): void {
    if (this.exitDrainTimer) {
      clearTimeout(this.exitDrainTimer);
      this.exitDrainTimer = undefined;
    }
  }

  private onStdoutEnd(): void {
    if (this.stdoutFlushed) return;
    this.stdoutFlushed = true;
    this.buffer += this.decoder.end();
    const trailing = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    if (trailing.trim()) {
      this.processLine(trailing);
    }
    if (this.exited) {
      this.failPending(new Error("member process exited"));
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
    if (this.detached) return Promise.reject(new Error("member detached"));
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

  prompt(message: string): Promise<any> {
    return this.send({ type: "prompt", message }, 60_000);
  }

  steer(message: string): Promise<any> {
    return this.send({ type: "steer", message }, 60_000);
  }

  abort(): Promise<any> {
    return this.send({ type: "abort" }, 10_000);
  }

  getState(): Promise<any> {
    return this.send({ type: "get_state" }, 10_000);
  }

  /** Poll get_state until the member answers (RPC ready). */
  async waitReady(timeoutMs = 120_000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.exited) {
        if (this.spawnError) {
          throw new Error(`member failed to start: ${this.spawnError.message}`);
        }
        throw new Error(`member exited during startup (code ${this.exitCode})`);
      }
      try {
        return await this.getState();
      } catch {
        if (this.exited) continue;
        await sleep(500);
      }
    }
    throw new Error("member did not become ready in time");
  }

  /** Stop receiving events and close the log (does not kill the process). */
  detach(): void {
    this.detached = true;
    if (this.exited || this.exitDrainTimer) {
      this.finalizeExit(this.exitCode);
      this.handlers.clear();
      this.exitHandlers.clear();
      return;
    }
    this.teardown({
      err: new Error("member detached"),
      destroyStreams: false,
      flushStdout: false,
      notifyExit: false,
    });
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
