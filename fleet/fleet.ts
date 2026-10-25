/** Fleet controller: spawn, steer, watch, merge, and clean member agents.
 *
 * Members are headless `pi --mode rpc` processes, one per git worktree.
 * The manifest (.pi/fleet/manifest.json) is the disk-truth registry.
 */

import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadFleetConfig, piBinary, resolveRoleSpec } from "./config.ts";
import {
  addWorktree,
  attachWorktree,
  branchExists,
  branchMerged,
  commitsSince,
  deleteBranch,
  diffForReview,
  git,
  headRev,
  mergeBranch,
  parseCommitRange,
  removeWorktree,
  type CommitRange,
  type MergeResult,
} from "./gitw.ts";
import { fleetDir, isActiveStatus, isPidAlive, loadManifest, saveManifest } from "./manifest.ts";
import { buildSystemAppend, resumePreamble } from "./roles.ts";
import { killProcessTree, RpcMember } from "./rpc.ts";
import {
  ROLE_NAMES,
  type CleanTarget,
  type FleetCommand,
  type FleetConfig,
  type FleetMessage,
  type FleetResult,
  type Manifest,
  type Member,
  type MemberStatus,
  type MergeTarget,
  type NotifyLevel,
  type RoleName,
  type SpawnMemberInput,
  type StopTarget,
  type WaitMode,
  type WaitTarget,
} from "./types.ts";

export type { NotifyLevel } from "./types.ts";

export interface FleetUi {
  notify(text: string, level?: NotifyLevel): void;
  /** Pass an empty array to clear the widget. */
  setWidget(lines: string[]): void;
}

interface SpawnOptions extends SpawnMemberInput {
  extra?: string;
  preserveTask?: boolean;
}

interface PreparedSpawn {
  input: SpawnOptions;
  member: Member;
  resume: boolean;
  role: RoleName;
  spec: ReturnType<typeof resolveRoleSpec>;
  model?: string;
  branch: string;
  wt: string;
  effectiveOver?: string;
  range: CommitRange | undefined;
}

interface StatusRow {
  member: Member;
  live: boolean;
  busy: boolean;
}

const USAGE = [
  "/fleet — run parallel pi agents in isolated git worktrees",
  "  status                          Show all members",
  "  spawn [--role r] [--model m] [--over ref] [--transient|--no-transient] <name> <task…>",
  "  resume <name> [extra…]          Continue a stale/stopped member",
  "  send <name> <message…>          Steer or prompt a member",
  "  wait [name|--all] [--any] [--timeout <sec>]  Wait for member(s) to settle",
  "  log <name> [n]                  Tail a member's activity log",
  "  merge <name|--done>             Merge a member branch into HEAD",
  "  stop <name|--all>               Abort + kill member process(es)",
  "  clean <name|--done|--all> [--force]  Remove worktree (+branch if merged)",
  "  open <name>                     Resume member session in a new pi window",
  "Roles: coder, tester, reviewer (read-only), integrator — see README.",
].join("\n");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;
const RESUMABLE = new Set<MemberStatus>(["stale", "stopped", "failed", "done"]);
const CLEANABLE_DONE = new Set<MemberStatus>(["done", "merged", "failed", "stopped", "stale", "detached"]);
const SETTLED_STATUSES = new Set<MemberStatus>(["done", "failed", "stopped", "stale", "merged"]);

function isMemberSettled(member: Member): boolean {
  return SETTLED_STATUSES.has(member.status) || Boolean(member.needsAttention);
}

const GLYPH: Record<Member["status"], string> = {
  starting: "…",
  running: "⚙",
  idle: "○",
  done: "✓",
  failed: "✗",
  stopped: "■",
  detached: "△",
  stale: "✗",
  merged: "✔",
};

function info(lines: string[]): FleetResult {
  return { messages: lines.map((text) => ({ text, level: "info" })) };
}

export class Fleet {
  readonly root: string;
  public ui: FleetUi;

  private clients = new Map<string, RpcMember>();
  private askWatchers = new Map<string, FSWatcher>();
  private stateListeners = new Set<() => void>();
  private spawning = new Map<string, Promise<void>>();
  private cleaningTransient = new Set<string>();
  private completedTransient = new Map<string, { createdAt: number; lines: string[] }>();
  private saveChain: Promise<void> = Promise.resolve();
  private prepareChain: Promise<void> = Promise.resolve();
  private cfg?: FleetConfig;
  private cfgPromise?: Promise<FleetConfig>;
  private man?: Manifest;
  private manPromise?: Promise<Manifest>;

  constructor(root: string, ui: FleetUi) {
    this.root = root;
    this.ui = ui;
  }

  // ── state ────────────────────────────────────────────────────────────────

  private async config(): Promise<FleetConfig> {
    this.cfgPromise ??= loadFleetConfig(this.root).then((cfg) => (this.cfg = cfg));
    return this.cfgPromise;
  }

  private async manifest(): Promise<Manifest> {
    this.manPromise ??= loadManifest(this.root).then((man) => (this.man = man));
    return this.manPromise;
  }

  private async withPrepareLock<T>(fn: () => Promise<T>): Promise<T> {
    const op = this.prepareChain.then(fn, fn);
    this.prepareChain = op.then(
      () => undefined,
      () => undefined,
    );
    return op;
  }

  private async save(): Promise<void> {
    const man = this.man ?? (this.manPromise ? await this.manPromise : undefined);
    if (!man) return;
    const op = this.saveChain.then(async () => {
      await saveManifest(man);
      await this.refreshWidget();
      for (const listener of this.stateListeners) {
        try {
          listener();
        } catch {
          // ignore listener error
        }
      }
    });
    this.saveChain = op.catch(() => undefined);
    await op;
  }

  // ── command dispatch ─────────────────────────────────────────────────────

  async execute(cmd: FleetCommand): Promise<FleetResult> {
    switch (cmd.action) {
      case "help":
        return info([USAGE]);

      case "status": {
        const rows = await this.statusRows();
        await this.refreshWidget();
        if (rows.length === 0) {
          return info(["fleet: no members; try /fleet spawn <name> <task>"]);
        }
        return info(this.statusLines(rows));
      }

      case "spawn": {
        const inputs: SpawnOptions[] =
          "members" in cmd
            ? cmd.members
            : [
                {
                  name: cmd.name,
                  task: cmd.task,
                  role: cmd.role,
                  model: cmd.model,
                  over: cmd.over,
                  transient: cmd.transient,
                },
              ];
        return this.spawnBatch(inputs);
      }

      case "resume": {
        const resumed = await this.resume(cmd.name, cmd.extra);
        return info([`fleet: resumed '${resumed.name}'`]);
      }

      case "send": {
        const mode = await this.send(cmd.name, cmd.message);
        return info([`fleet: sent to '${cmd.name}' (${mode})`]);
      }

      case "wait": {
        return this.waitForMembers(cmd.target, cmd.mode ?? "all", cmd.timeout);
      }

      case "log": {
        const text = await this.logTail(cmd.name, cmd.n ?? 20);
        return info(text.split("\n"));
      }

      case "merge": {
        const man = await this.manifest();
        const names =
          cmd.target.kind === "done"
            ? Object.values(man.members)
                .filter((m) => m.status === "done")
                .map((m) => m.name)
            : [cmd.target.name];
        if (cmd.target.kind === "done" && names.length === 0) {
          return info(["fleet: no matching members to merge"]);
        }
        const messages: FleetMessage[] = [];
        for (const name of names) {
          const result = await this.merge(name);
          if (result.ok) {
            messages.push({ text: `fleet: merged ${name}`, level: "info" });
          } else {
            messages.push({
              text: `fleet: merge ${name} CONFLICTS in: ${result.conflicts.join(", ") || "(unknown)"}`,
              level: "error",
            });
          }
        }
        return { messages };
      }

      case "stop": {
        const man = await this.manifest();
        const names =
          cmd.target.kind === "all"
            ? Object.values(man.members)
                .filter((m) => isActiveStatus(m.status) || this.clients.has(m.name))
                .map((m) => m.name)
            : [cmd.target.name];
        if (cmd.target.kind === "all" && names.length === 0) {
          return info(["fleet: no matching members to stop"]);
        }
        const lines: string[] = [];
        for (const name of names) {
          await this.stop(name);
          lines.push(`fleet: stopped '${name}'`);
        }
        return info(lines);
      }

      case "clean": {
        const force = !!cmd.force;
        const man = await this.manifest();
        const names =
          cmd.target.kind === "all"
            ? Object.keys(man.members)
            : cmd.target.kind === "done"
              ? Object.values(man.members)
                  .filter((m) => CLEANABLE_DONE.has(m.status))
                  .map((m) => m.name)
              : [cmd.target.name];
        if (cmd.target.kind !== "member" && names.length === 0) {
          return info(["fleet: no matching members to clean"]);
        }
        const lines: string[] = [];
        for (const name of names) {
          if (cmd.target.kind === "done" && man.members[name]?.status === "detached") {
            await this.stop(name);
          }
          const outcome = await this.clean(name, force);
          lines.push(`fleet: cleaned '${name}' (${outcome})`);
        }
        return info(lines);
      }

      case "open": {
        const outcome = await this.open(cmd.name);
        return info([`fleet: ${outcome}`]);
      }
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  private async spawnBatch(batch: SpawnOptions[]): Promise<FleetResult> {
    const { cfg, prepared } = await this.withPrepareLock(async () => {
      const cfg = await this.config();
      const man = await this.manifest();

      const seenNames = new Set<string>();
      const candidates = batch.map((input) => {
        if (!NAME_RE.test(input.name)) {
          throw new Error(`invalid member name '${input.name}' (use lowercase letters, digits, dashes)`);
        }
        if (seenNames.has(input.name)) {
          throw new Error(`duplicate member name '${input.name}' in spawn batch`);
        }
        seenNames.add(input.name);

        const existing = man.members[input.name];
        const resume = !!existing && RESUMABLE.has(existing.status);
        if (existing && !resume) {
          throw new Error(`member '${input.name}' already exists with status '${existing.status}'`);
        }
        return { input, existing, resume };
      });

      const netNewActiveCount = candidates.filter(
        ({ existing }) => !existing || !isActiveStatus(existing.status),
      ).length;
      const live = Object.values(man.members).filter((m) => isActiveStatus(m.status)).length;
      const maxMembers = cfg.maxMembers ?? 6;
      if (live + netNewActiveCount > maxMembers) {
        throw new Error(`fleet is at max members (${maxMembers}); stop or clean one first`);
      }

      const validated = await Promise.all(
        candidates.map(async ({ input, existing, resume }) => {
          const role: RoleName = input.role ?? (resume ? existing!.role : (cfg.defaultRole ?? "coder"));
          const spec = resolveRoleSpec(cfg, role);
          const model = input.model ?? spec.model;

          const branch = `fleet/${input.name}`;
          const wt = path.join(this.root, cfg.worktreeRoot ?? ".pi/fleet/wt", input.name);
          const effectiveOver = input.over ?? (input.preserveTask ? existing?.over : undefined);
          const range = parseCommitRange(effectiveOver);
          const baseInput = range
            ? range.head
            : (effectiveOver ?? (resume ? existing!.baseRef : (cfg.baseRef ?? "HEAD")));
          let baseRef: string;

          if (resume) {
            if (!existsSync(wt) && !(await branchExists(this.root, branch))) {
              throw new Error(
                `cannot resume '${input.name}': worktree and branch are gone; run /fleet clean ${input.name} first`,
              );
            }
            if (!input.preserveTask && input.over) {
              if (range) await headRev(this.root, range.base);
              baseRef = await headRev(this.root, baseInput);
            } else {
              baseRef = existing!.baseRef;
            }
          } else {
            if (range) await headRev(this.root, range.base);
            baseRef = await headRev(this.root, baseInput);
          }

          return { input, existing, resume, role, spec, model, branch, wt, effectiveOver, range, baseRef };
        }),
      );

      const prevSnapshots = new Map<string, Member | undefined>(
        validated.map(({ input, existing }) => [input.name, existing ? { ...existing } : undefined]),
      );
      const createdWorktrees: Array<{ name: string; wt: string; branch: string }> = [];

      try {
        const prepared = await Promise.all(
          validated.map(
            async ({ input, existing, resume, role, spec, model, branch, wt, effectiveOver, range, baseRef }) => {
              if (resume) {
                if (this.clients.has(input.name)) {
                  await this.stop(input.name);
                }
                if (!existsSync(wt)) {
                  await attachWorktree(this.root, wt, branch);
                }
                if (!input.preserveTask && input.over) {
                  await git(wt, "reset", "--hard", baseRef);
                }
              } else {
                await addWorktree(this.root, wt, branch, baseRef);
                createdWorktrees.push({ name: input.name, wt, branch });
              }

              await rm(path.join(wt, "FLEET_ASK.md"), { force: true }).catch(() => undefined);
              this.completedTransient.delete(input.name);

              const transient =
                input.transient ??
                (input.preserveTask && existing?.transient !== undefined
                  ? existing.transient
                  : Boolean(spec.autoClean));

              const now = Date.now();
              const member: Member = existing ?? {
                name: input.name,
                role,
                task: input.task,
                branch,
                worktree: wt,
                baseRef,
                status: "starting",
                createdAt: now,
                updatedAt: now,
              };
              if (resume) {
                if (!input.preserveTask && input.task) member.task = input.task;
                member.model = model ?? member.model;
              } else {
                member.model = model;
              }
              member.role = role;
              member.baseRef = baseRef;
              member.over = effectiveOver;
              member.transient = transient;
              member.status = "starting";
              member.needsAttention = undefined;
              member.result = undefined;
              member.updatedAt = now;
              man.members[input.name] = member;
              return { input, member, resume, role, spec, model, branch, wt, effectiveOver, range };
            },
          ),
        );
        await this.save();
        return { cfg, prepared };
      } catch (err) {
        for (const created of createdWorktrees) {
          await removeWorktree(this.root, created.wt, true).catch(() => undefined);
          await deleteBranch(this.root, created.branch, true).catch(() => undefined);
        }
        for (const [name, snap] of prevSnapshots) {
          if (snap) man.members[name] = snap;
          else delete man.members[name];
        }
        await this.save().catch(() => undefined);
        throw err;
      }

      await this.save();
      return { cfg, prepared };
    });

    const settled = await Promise.allSettled(
      prepared.map(async ({ input, member, resume, role, spec, model, branch, wt, effectiveOver, range }) => {
        let releaseSpawn!: () => void;
        const spawnDone = new Promise<void>((resolve) => {
          releaseSpawn = resolve;
        });
        this.spawning.set(input.name, spawnDone);
        try {
          const promptsDir = path.join(fleetDir(this.root), "prompts");
          await mkdir(promptsDir, { recursive: true });
          const promptFile = path.join(promptsDir, `${input.name}.md`);
          const extraAppend = [spec.systemAppend, input.extra].filter(Boolean).join("\n\n");
          await writeFile(
            promptFile,
            buildSystemAppend(
              { name: input.name, role, branch, repoRoot: this.root, task: member.task },
              extraAppend || undefined,
            ),
            "utf8",
          );

          if (role === "reviewer") {
            await this.writeReviewContext(member, effectiveOver, range);
          }

          const sessionDir = path.join(this.root, cfg.sessionDir ?? ".pi/fleet/sessions");
          await mkdir(sessionDir, { recursive: true });
          const logFile = path.join(this.root, cfg.logDir ?? ".pi/fleet/logs", `${input.name}.jsonl`);

          const args = [
            "--approve",
            "--name", `fleet:${input.name}`,
            "--session-dir", sessionDir,
            "--append-system-prompt", promptFile,
          ];
          if (model) args.push("--model", model);
          else if (spec.thinking) args.push("--thinking", spec.thinking);
          if (spec.tools) args.push("--tools", spec.tools);

          const client = await RpcMember.create({
            piBin: piBinary(cfg),
            cwd: wt,
            args,
            logFile,
          });
          this.clients.set(input.name, client);
          client.onEvent((ev) => void this.onMemberEvent(input.name, ev).catch(() => undefined));
          client.onExit(() => void this.onClientExit(input.name, client).catch(() => undefined));
          this.watchAsk(member);

          await client.waitReady();
          const state = await client.getState().catch(() => undefined);
          member.pid = client.pid;
          member.sessionFile = state?.sessionFile ?? member.sessionFile;
          member.status = "running";
          member.updatedAt = Date.now();
          await this.save();

          const firstMessage = resume ? resumePreamble(member, input.extra) : member.task;
          await client.prompt(firstMessage);
          return member;
        } catch (err) {
          await this.stop(input.name).catch(() => undefined);
          member.status = "failed";
          member.updatedAt = Date.now();
          await this.save();
          throw err;
        } finally {
          this.spawning.delete(input.name);
          releaseSpawn();
        }
      }),
    );

    const messages: FleetMessage[] = [];
    let firstRejection: unknown;
    let fulfilledCount = 0;
    for (let i = 0; i < settled.length; i++) {
      const res = settled[i];
      if (res.status === "fulfilled") {
        fulfilledCount++;
        const m = res.value;
        messages.push({
          text: `fleet: spawned '${m.name}' (${m.role}) on ${m.branch}`,
          level: "info",
        });
      } else {
        firstRejection ??= res.reason;
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        messages.push({
          text: `fleet: spawn '${prepared[i].input.name}' failed: ${msg}`,
          level: "error",
        });
      }
    }
    if (fulfilledCount === 0 && firstRejection !== undefined) {
      throw firstRejection;
    }
    return { messages };
  }

  private async resume(name: string, extra?: string): Promise<Member> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) throw new Error(`no such member '${name}'`);
    await this.spawnBatch([
      {
        name,
        task: member.task,
        role: member.role,
        model: member.model,
        extra,
        preserveTask: true,
      },
    ]);
    return (await this.manifest()).members[name];
  }

  private async writeReviewContext(
    member: Member,
    over?: string,
    range = parseCommitRange(over),
  ): Promise<void> {
    const cfg = await this.config();
    const man = await this.manifest();
    const target = range ? range.head : (over ?? member.baseRef);
    const targetName = !range && over ? over.replace(/^fleet\//, "") : undefined;
    const targetMember = targetName ? man.members[targetName] : undefined;
    const diffBase = range ? range.base : (targetMember?.baseRef ?? cfg.baseRef ?? "HEAD");
    const commits = await commitsSince(this.root, diffBase, target).catch(() => [] as string[]);
    const diff = await diffForReview(this.root, diffBase, target, range?.dots);
    const dir = path.join(member.worktree, ".pi", "fleet");
    await mkdir(dir, { recursive: true });
    const commitList = commits.length ? commits.map((c) => `- ${c}`).join("\n") : "(no commits)";
    await writeFile(
      path.join(dir, "review-context.md"),
      `# Review context\n\nTarget: \`${target}\`\nDiff base: \`${diffBase}\`\n\n## Assignment\n\n${member.task}\n\n## Commits\n\n${commitList}\n\n## Diff\n\n\`\`\`diff\n${diff}\n\`\`\`\n`,
      "utf8",
    );
  }

  private async send(name: string, message: string): Promise<"steer" | "prompt"> {
    const client = this.mustClient(name);
    const man = await this.manifest();
    const member = man.members[name];
    if (member) {
      await rm(path.join(member.worktree, "FLEET_ASK.md"), { force: true }).catch(() => undefined);
      if (member.needsAttention) {
        member.needsAttention = undefined;
        member.updatedAt = Date.now();
        await this.save();
      }
    }
    if (client.busy) {
      await client.steer(message);
      return "steer";
    }
    await client.prompt(message);
    return "prompt";
  }

  private async waitForMembers(
    target: WaitTarget,
    mode: WaitMode,
    timeoutSec?: number,
  ): Promise<FleetResult> {
    const man = await this.manifest();
    let names: string[];
    if (target.kind === "all") {
      const entries = new Map<string, number>();
      for (const m of Object.values(man.members)) entries.set(m.name, m.createdAt);
      for (const [name, snap] of this.completedTransient.entries()) {
        if (!entries.has(name)) entries.set(name, snap.createdAt);
      }
      names = Array.from(entries.entries())
        .sort((a, b) => a[1] - b[1])
        .map(([name]) => name);
      if (names.length === 0) {
        return info(["fleet: no members to wait for"]);
      }
    } else {
      for (const name of target.names) {
        if (!man.members[name] && !this.completedTransient.has(name)) {
          throw new Error(`no such member '${name}'`);
        }
      }
      names = target.names;
    }

    const isSettled = (n: string): boolean => {
      const m = man.members[n];
      if (!m) return true;
      if (this.cleaningTransient.has(n)) return false;
      return isMemberSettled(m);
    };

    const isSatisfied = (): boolean =>
      mode === "any" ? names.some(isSettled) : names.every(isSettled);

    const syncAsks = async (): Promise<void> => {
      for (const name of names) {
        const member = man.members[name];
        if (member && existsSync(path.join(member.worktree, "FLEET_ASK.md"))) {
          await this.readAsk(name);
        }
      }
    };

    let timedOut = false;
    await syncAsks();
    if (!isSatisfied()) {
      await new Promise<void>((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const done = () => {
          this.stateListeners.delete(check);
          clearInterval(poll);
          if (timer) clearTimeout(timer);
          resolve();
        };
        const check = () => {
          if (isSatisfied()) done();
        };
        const poll = setInterval(() => {
          void syncAsks().then(check);
        }, 50);
        if (timeoutSec !== undefined) {
          timer = setTimeout(() => {
            if (!isSatisfied()) timedOut = true;
            done();
          }, Math.max(1, Math.round(timeoutSec * 1000)));
        }
        this.stateListeners.add(check);
      });
    }

    const lines: string[] = [];
    if (timedOut) {
      const settled = names.filter(isSettled);
      const running = names.filter((n) => !isSettled(n));
      lines.push(
        `fleet: wait timed out after ${timeoutSec}s (settled: ${settled.join(", ") || "none"}; running: ${running.join(", ") || "none"})`,
      );
    }
    for (const name of names) {
      const snap = this.completedTransient.get(name);
      if (snap) {
        lines.push(...snap.lines);
        continue;
      }
      const member = man.members[name];
      if (!member) continue;
      lines.push(...(await this.formatWaitMember(member)));
    }
    return info(lines);
  }

  private async formatWaitMember(member: Member): Promise<string[]> {
    const commits = await commitsSince(this.root, member.baseRef, member.branch).catch(() => [] as string[]);
    const lines = [
      `${member.name} [${member.role}] status=${member.status} branch=${member.branch}`,
      commits.length > 0 ? `  commits: ${commits.join("; ")}` : "  commits: (no commits)",
    ];
    if (member.needsAttention) {
      lines.push(`  ASK: ${member.needsAttention}`);
    }
    if (member.result) {
      lines.push(`  result: ${member.result}`);
    }
    return lines;
  }

  private async killAttachedClient(name: string): Promise<boolean> {
    const client = this.clients.get(name);
    if (!client) return false;
    this.clients.delete(name);
    this.unwatchAsk(name);
    await client.abort().catch(() => undefined);
    await client.kill();
    return true;
  }

  private async stop(name: string): Promise<void> {
    const hadClient = await this.killAttachedClient(name);
    const man = await this.manifest();
    const member = man.members[name];
    const canKillDetached =
      !!member && (isActiveStatus(member.status) || member.status === "detached");
    if (!hadClient && canKillDetached && member.pid && isPidAlive(member.pid)) {
      await killProcessTree(member.pid);
    }
    if (member && (canKillDetached || hadClient)) {
      member.status = "stopped";
      member.pid = undefined;
      member.updatedAt = Date.now();
      await this.save();
    }
  }

  private async clean(name: string, force = false): Promise<string> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) throw new Error(`no such member '${name}'`);
    if (this.clients.has(name)) {
      if (!force) throw new Error(`member '${name}' is still attached; run /fleet stop ${name} first`);
      await this.stop(name);
    }
    this.unwatchAsk(name);
    if (existsSync(member.worktree)) {
      const r = await removeWorktree(this.root, member.worktree, force);
      if (!r.ok) throw new Error(`worktree remove failed: ${r.out}`);
    }
    const merged = await branchMerged(this.root, member.branch).catch(() => false);
    if (merged || force) {
      const r = await deleteBranch(this.root, member.branch, force);
      if (!r.ok && force) throw new Error(`branch delete failed: ${r.out}`);
    }
    delete man.members[name];
    await this.save();
    return merged ? "worktree removed, merged branch deleted" : "worktree removed, branch kept (unmerged)";
  }

  private async merge(name: string): Promise<MergeResult> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) throw new Error(`no such member '${name}'`);
    const result = await mergeBranch(this.root, member.branch, `fleet(${name}): ${member.task.split("\n")[0]}`);
    if (result.ok) {
      member.status = "merged";
      member.updatedAt = Date.now();
      await this.save();
    }
    return result;
  }

  private async open(name: string): Promise<string> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member?.sessionFile || !existsSync(member.sessionFile)) {
      throw new Error(`no resumable session recorded for '${name}'`);
    }
    const target = JSON.stringify(member.sessionFile);
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd", "/k", `pi --session ${target}`], {
        cwd: member.worktree,
        windowsHide: true,
      });
    } else {
      const child = spawn("pi", ["--session", member.sessionFile], {
        cwd: member.worktree,
        detached: true,
        stdio: "inherit",
      });
      child.unref();
    }
    return `opened interactive pi for '${name}' in ${member.worktree}`;
  }

  // ── observation ──────────────────────────────────────────────────────────

  private async statusRows(): Promise<StatusRow[]> {
    const man = await this.manifest();
    const rows: StatusRow[] = [];
    for (const member of Object.values(man.members)) {
      const client = this.clients.get(member.name);
      rows.push({ member, live: !!client && !client.exited, busy: !!client?.busy });
    }
    rows.sort((a, b) => a.member.createdAt - b.member.createdAt);
    return rows;
  }

  private formatHeader(rows: StatusRow[]): string {
    const active = rows.filter((r) => isActiveStatus(r.member.status)).length;
    return `fleet: ${rows.length} member${rows.length === 1 ? "" : "s"} (${active} active)`;
  }

  private memberGlyph(member: Member, live: boolean): string {
    return live ? GLYPH[member.status] : (member.status === "merged" ? "✔" : "·");
  }

  private statusLines(rows: StatusRow[]): string[] {
    const lines = [this.formatHeader(rows)];
    for (const { member, live, busy } of rows) {
      const glyph = this.memberGlyph(member, live);
      const flags = `${busy ? " (busy)" : ""}${live ? "" : " (not attached)"}`;
      const ask = member.needsAttention ? ` ASK: ${member.needsAttention}` : "";
      lines.push(
        ` ${glyph} ${member.name} [${member.role}] status=${member.status}${flags} branch=${member.branch}${ask}`,
      );
    }
    return lines;
  }

  private widgetLines(rows: StatusRow[]): string[] {
    if (rows.length === 0) return [];
    const lines = [this.formatHeader(rows)];
    for (const { member, live } of rows.slice(0, 8)) {
      const glyph = this.memberGlyph(member, live);
      const ask = member.needsAttention ? `  ASK: ${truncate(member.needsAttention, 48)}` : "";
      lines.push(` ${glyph} ${member.name.padEnd(12)} ${member.role.padEnd(10)} ${member.status}${ask}`);
    }
    if (rows.length > 8) lines.push(` … ${rows.length - 8} more`);
    return lines;
  }

  private async refreshWidget(): Promise<void> {
    try {
      const rows = await this.statusRows();
      this.ui.setWidget(this.widgetLines(rows));
    } catch {
      // Widget is best-effort.
    }
  }

  private async logTail(name: string, n = 20): Promise<string> {
    const cfg = await this.config();
    const logFile = path.join(this.root, cfg.logDir ?? ".pi/fleet/logs", `${name}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(logFile, "utf8");
    } catch {
      return `(no log yet for '${name}')`;
    }
    const items: Array<
      | { kind: "assistant"; text: string }
      | { kind: "tool"; toolName: string }
    > = [];
    let lastResultIdx = -1;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        const text = extractText(ev.message).trim();
        if (text) {
          if (parseResultPrefix(text)) lastResultIdx = items.length;
          items.push({ kind: "assistant", text });
        }
      } else if (ev.type === "tool_execution_start") {
        items.push({ kind: "tool", toolName: ev.toolName });
      }
    }
    const entries = items.map((item, idx) => {
      if (item.kind === "tool") return `tool: ${item.toolName}`;
      if (idx === lastResultIdx) return `assistant: ${item.text}`;
      return `assistant: ${truncate(item.text.replace(/\s+/g, " "), 220)}`;
    });
    const tail = entries.slice(-n);
    return tail.length ? tail.join("\n") : `(no activity logged for '${name}')`;
  }

  /** Re-check member processes after a supervisor restart. */
  async reconcile(): Promise<void> {
    const man = await this.manifest();
    let changed = false;
    for (const member of Object.values(man.members)) {
      if (!isActiveStatus(member.status)) continue;
      if (this.clients.has(member.name)) continue;
      const alive = isPidAlive(member.pid) && existsSync(member.worktree);
      member.status = alive ? "detached" : "stale";
      member.updatedAt = Date.now();
      changed = true;
      this.ui.notify(
        `fleet member '${member.name}' is ${member.status} after restart` +
          (member.status === "stale" ? "; /fleet resume to continue" : "; /fleet open or stop+clean"),
        "warn",
      );
    }
    if (changed) await this.save();
    else await this.refreshWidget();
  }

  /** Detach from all clients without killing them (used on session shutdown). */
  dispose(): void {
    const entries = Array.from(this.clients.entries());
    this.clients.clear();
    for (const [name, client] of entries) {
      client.detach();
      this.unwatchAsk(name);
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private mustClient(name: string): RpcMember {
    const client = this.clients.get(name);
    if (!client || client.exited) {
      throw new Error(`member '${name}' is not attached (status may be stale; try /fleet resume ${name})`);
    }
    return client;
  }

  private async onMemberEvent(name: string, ev: any): Promise<void> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) return;

    if (ev.type === "agent_start" && member.status !== "running") {
      member.status = "running";
      member.updatedAt = Date.now();
      await this.save();
    } else if (ev.type === "agent_end" && member.status === "running") {
      member.status = "idle";
      member.updatedAt = Date.now();
      await this.save();
    } else if (ev.type === "message_end" && ev.message?.role === "assistant") {
      const text = extractText(ev.message);
      const prefix = parseResultPrefix(text);
      if (prefix === "done") {
        if (member.transient) {
          const cleanPromise = this.completeAndCleanTransient(member, text.trim());
          this.ui.notify(`fleet member '${name}' reports DONE`, "info");
          await cleanPromise;
        } else {
          member.status = "done";
          member.result = text.trim();
          member.updatedAt = Date.now();
          await this.save();
          this.ui.notify(`fleet member '${name}' reports DONE`, "info");
        }
      } else if (prefix === "failed") {
        member.status = "failed";
        member.result = text.trim();
        member.updatedAt = Date.now();
        await this.save();
        this.ui.notify(`fleet member '${name}' reports FAILED`, "error");
      }
    }
  }

  private async onClientExit(name: string, client: RpcMember): Promise<void> {
    if (this.clients.get(name) !== client) return;
    this.clients.delete(name);
    this.unwatchAsk(name);
    await this.spawning.get(name);
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) return;
    if (member.status === "done" && client.exitCode === 0 && member.transient) {
      await this.completeAndCleanTransient(member);
      return;
    }
    if (isActiveStatus(member.status)) {
      member.status = "failed";
      member.pid = undefined;
      member.updatedAt = Date.now();
      await this.save();
    }
  }

  private async completeAndCleanTransient(member: Member, result?: string): Promise<void> {
    const name = member.name;
    if (this.cleaningTransient.has(name)) return;
    this.cleaningTransient.add(name);
    try {
      member.status = "done";
      member.pid = undefined;
      if (result !== undefined) member.result = result;
      member.updatedAt = Date.now();
      await this.spawning.get(name);
      const man = await this.manifest();
      const current = man.members[name];
      if (!current || current.status === "failed") return;
      const lines = await this.formatWaitMember(current);
      this.completedTransient.set(current.name, { createdAt: current.createdAt, lines });
      await this.killAttachedClient(name);
      try {
        await this.clean(name, false);
      } catch {
        await removeWorktree(this.root, current.worktree, true);
        await this.clean(name, false);
      }
    } finally {
      this.cleaningTransient.delete(name);
    }
  }

  private watchAsk(member: Member): void {
    this.unwatchAsk(member.name);
    try {
      let timer: NodeJS.Timeout | undefined;
      const watcher = watch(member.worktree, (_event, filename) => {
        if (filename !== "FLEET_ASK.md") return;
        clearTimeout(timer);
        timer = setTimeout(() => void this.readAsk(member.name), 500);
      });
      this.askWatchers.set(member.name, watcher);
    } catch {
      // Watching is best-effort.
    }
  }

  private unwatchAsk(name: string): void {
    this.askWatchers.get(name)?.close();
    this.askWatchers.delete(name);
  }

  private async readAsk(name: string): Promise<void> {
    const man = await this.manifest();
    const member = man.members[name];
    if (!member) return;
    try {
      const content = await readFile(path.join(member.worktree, "FLEET_ASK.md"), "utf8");
      const question = content.split("\n").map((l) => l.trim()).find(Boolean);
      if (question && question !== member.needsAttention) {
        member.needsAttention = question;
        member.updatedAt = Date.now();
        await this.save();
        this.ui.notify(`fleet member '${name}' asks: ${truncate(question, 120)}`, "warn");
      }
    } catch {
      if (member.needsAttention) {
        member.needsAttention = undefined;
        await this.save();
      }
    }
  }
}

// ── helpers & command parsers ────────────────────────────────────────────────

function parseResultPrefix(text: string): "done" | "failed" | undefined {
  const match = /^\s*(DONE|FAILED):/i.exec(text.slice(0, 500));
  if (!match) return undefined;
  return match[1].toUpperCase() === "DONE" ? "done" : "failed";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function extractText(message: any): string {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

function unquote(text: string): string {
  const trimmed = text.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function shiftToken(input: string): { token: string; rest: string } {
  const trimmed = input.trimStart();
  const match = /^(\S+)([\s\S]*)$/.exec(trimmed);
  if (!match) return { token: "", rest: "" };
  return { token: match[1], rest: match[2] ?? "" };
}

function parseMergeTarget(raw: string): MergeTarget {
  if (raw === "--done") return { kind: "done" };
  if (!raw || raw.startsWith("--")) throw new Error("usage: /fleet merge <name|--done>");
  return { kind: "member", name: raw };
}

function parseStopTarget(raw: string): StopTarget {
  if (raw === "--all") return { kind: "all" };
  if (!raw || raw.startsWith("--")) throw new Error("usage: /fleet stop <name|--all>");
  return { kind: "member", name: raw };
}

function parseCleanTarget(raw: string): CleanTarget {
  if (raw === "--done") return { kind: "done" };
  if (raw === "--all") return { kind: "all" };
  if (!raw || raw.startsWith("--")) throw new Error("usage: /fleet clean <name|--done|--all> [--force]");
  return { kind: "member", name: raw };
}

function parseLogCount(raw: unknown): number {
  const n = typeof raw === "number" ? raw : raw ? Number(raw) : 20;
  return Number.isFinite(n) && n > 0 ? n : 20;
}

const WAIT_USAGE = "usage: /fleet wait [name|--all] [--any] [--timeout <sec>]";

function parseWaitTimeout(raw: unknown): number {
  if (typeof raw === "string" && (!raw || raw.startsWith("-"))) throw new Error(WAIT_USAGE);
  const sec = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(WAIT_USAGE);
  return sec;
}

function parseSpawnMemberInput(raw: any, missingMsg: string): SpawnMemberInput {
  if (!raw || typeof raw !== "object" || !raw.name || !raw.task) {
    throw new Error(missingMsg);
  }
  if (raw.role !== undefined && !ROLE_NAMES.includes(raw.role)) {
    throw new Error(`invalid role '${raw.role}'`);
  }
  if (raw.transient !== undefined && typeof raw.transient !== "boolean") {
    throw new Error("transient must be a boolean");
  }
  return {
    name: raw.name,
    task: raw.task,
    ...(raw.role ? { role: raw.role } : {}),
    ...(raw.model ? { model: raw.model } : {}),
    ...(raw.over ? { over: raw.over } : {}),
    ...(raw.transient !== undefined ? { transient: raw.transient } : {}),
  };
}

function parseWaitTarget(tokens: string[]): WaitTarget {
  let explicitAll = false;
  const names: string[] = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    if (token === "--all") explicitAll = true;
    else if (token.startsWith("-")) throw new Error(WAIT_USAGE);
    else if (!names.includes(token)) names.push(token);
  }
  if (explicitAll && names.length > 0) throw new Error(WAIT_USAGE);
  return explicitAll || names.length === 0 ? { kind: "all" } : { kind: "members", names };
}

export function parseFleetCommand(raw: string): FleetCommand {
  const { token: sub, rest } = shiftToken(raw);
  if (!sub || sub === "status") return { action: "status" };
  if (sub === "help" || sub === "--help" || sub === "-h") return { action: "help" };

  switch (sub) {
    case "spawn": {
      const opts: { role?: RoleName; model?: string; over?: string; transient?: boolean } = {};
      let cursor = rest;
      let name = "";
      const spawnUsage =
        "usage: /fleet spawn [--role r] [--model m] [--over ref] [--transient|--no-transient] <name> <task…>";
      while (cursor.trimStart()) {
        const next = shiftToken(cursor);
        if (next.token === "--role") {
          const val = shiftToken(next.rest);
          if (!val.token || !ROLE_NAMES.includes(val.token as RoleName)) {
            throw new Error(spawnUsage);
          }
          opts.role = val.token as RoleName;
          cursor = val.rest;
        } else if (next.token === "--model") {
          const val = shiftToken(next.rest);
          if (!val.token) {
            throw new Error(spawnUsage);
          }
          opts.model = val.token;
          cursor = val.rest;
        } else if (next.token === "--over") {
          const val = shiftToken(next.rest);
          if (!val.token) {
            throw new Error(spawnUsage);
          }
          opts.over = val.token;
          cursor = val.rest;
        } else if (next.token === "--transient") {
          opts.transient = true;
          cursor = next.rest;
        } else if (next.token === "--no-transient") {
          opts.transient = false;
          cursor = next.rest;
        } else if (next.token.startsWith("--")) {
          throw new Error(spawnUsage);
        } else {
          name = next.token;
          cursor = next.rest;
          break;
        }
      }
      const task = unquote(cursor);
      if (!name || !task) {
        throw new Error(spawnUsage);
      }
      return { action: "spawn", name, task, ...opts };
    }

    case "resume": {
      const { token: name, rest: tail } = shiftToken(rest);
      if (!name) throw new Error("usage: /fleet resume <name> [extra instructions…]");
      const extra = unquote(tail);
      return { action: "resume", name, ...(extra ? { extra } : {}) };
    }

    case "send": {
      const { token: name, rest: tail } = shiftToken(rest);
      const message = unquote(tail);
      if (!name || !message) throw new Error("usage: /fleet send <name> <message…>");
      return { action: "send", name, message };
    }

    case "wait": {
      let cursor = rest;
      let mode: WaitMode | undefined;
      let timeout: number | undefined;
      const targetTokens: string[] = [];

      while (cursor.trimStart()) {
        const next = shiftToken(cursor);
        if (next.token === "--any") {
          mode = "any";
          cursor = next.rest;
        } else if (next.token === "--timeout") {
          const val = shiftToken(next.rest);
          timeout = parseWaitTimeout(val.token);
          cursor = val.rest;
        } else {
          targetTokens.push(next.token);
          cursor = next.rest;
        }
      }

      return {
        action: "wait",
        target: parseWaitTarget(targetTokens),
        ...(mode ? { mode } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
    }

    case "log": {
      const { token: name, rest: tail } = shiftToken(rest);
      if (!name) throw new Error("usage: /fleet log <name> [n]");
      const { token: nStr } = shiftToken(tail);
      return { action: "log", name, n: parseLogCount(nStr) };
    }

    case "merge": {
      const { token: rawTarget, rest: tail } = shiftToken(rest);
      if (shiftToken(tail).token) throw new Error("usage: /fleet merge <name|--done>");
      return { action: "merge", target: parseMergeTarget(rawTarget) };
    }

    case "stop": {
      const { token: rawTarget, rest: tail } = shiftToken(rest);
      if (shiftToken(tail).token) throw new Error("usage: /fleet stop <name|--all>");
      return { action: "stop", target: parseStopTarget(rawTarget) };
    }

    case "clean": {
      const tokens = rest.trim().split(/\s+/).filter(Boolean);
      let force = false;
      const rawTargets: string[] = [];
      for (const t of tokens) {
        if (t === "--force") {
          force = true;
        } else {
          rawTargets.push(t);
        }
      }
      if (rawTargets.length !== 1) {
        throw new Error("usage: /fleet clean <name|--done|--all> [--force]");
      }
      return {
        action: "clean",
        target: parseCleanTarget(rawTargets[0]),
        ...(force ? { force: true } : {}),
      };
    }

    case "open": {
      const { token: name, rest: tail } = shiftToken(rest);
      if (!name || shiftToken(tail).token || name.startsWith("--")) {
        throw new Error("usage: /fleet open <name>");
      }
      return { action: "open", name };
    }

    default:
      return { action: "help" };
  }
}

export function toolParamsToCommand(params: {
  action: string;
  name?: string;
  names?: string[];
  task?: string;
  role?: RoleName;
  model?: string;
  over?: string;
  transient?: boolean;
  members?: SpawnMemberInput[];
  message?: string;
  n?: number;
  force?: boolean;
  mode?: WaitMode;
  timeout?: number;
}): FleetCommand {
  switch (params.action) {
    case "status":
      return { action: "status" };
    case "spawn": {
      if (params.members !== undefined) {
        if (
          params.name !== undefined ||
          params.task !== undefined ||
          params.role !== undefined ||
          params.model !== undefined ||
          params.over !== undefined ||
          params.transient !== undefined
        ) {
          throw new Error(
            "spawn cannot mix members with top-level name, task, role, model, over, or transient",
          );
        }
        if (!Array.isArray(params.members) || params.members.length === 0) {
          throw new Error("spawn members must be a non-empty array");
        }
        const members = params.members.map((m) =>
          parseSpawnMemberInput(m, "each spawn member requires name and task"),
        );
        return { action: "spawn", members };
      }
      return {
        action: "spawn",
        ...parseSpawnMemberInput(params, "spawn requires name and task"),
      };
    }
    case "resume": {
      if (!params.name) throw new Error("resume requires name");
      const extra = params.message?.trim();
      return {
        action: "resume",
        name: params.name,
        ...(extra ? { extra } : {}),
      };
    }
    case "send": {
      if (!params.name || !params.message) throw new Error("send requires name and message");
      return { action: "send", name: params.name, message: params.message };
    }
    case "wait": {
      const timeout = params.timeout !== undefined ? parseWaitTimeout(params.timeout) : undefined;
      if (params.mode !== undefined && params.mode !== "all" && params.mode !== "any") {
        throw new Error(WAIT_USAGE);
      }
      const targetTokens = [
        ...(params.name ? params.name.trim().split(/\s+/) : []),
        ...(Array.isArray(params.names) ? params.names.map(String) : []),
      ].filter((t) => t.trim().length > 0);
      if ((params.name !== undefined || params.names !== undefined) && targetTokens.length === 0) {
        throw new Error(WAIT_USAGE);
      }
      return {
        action: "wait",
        target: parseWaitTarget(targetTokens),
        ...(params.mode ? { mode: params.mode } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      };
    }
    case "log": {
      if (!params.name) throw new Error("log requires name");
      return { action: "log", name: params.name, n: parseLogCount(params.n) };
    }
    case "merge": {
      if (!params.name) throw new Error("merge requires name (or '--done')");
      return { action: "merge", target: parseMergeTarget(params.name) };
    }
    case "stop": {
      if (!params.name) throw new Error("stop requires name (or '--all')");
      return { action: "stop", target: parseStopTarget(params.name) };
    }
    case "clean": {
      if (!params.name) throw new Error("clean requires name (or '--done' / '--all')");
      return {
        action: "clean",
        target: parseCleanTarget(params.name),
        ...(params.force ? { force: true } : {}),
      };
    }
    default:
      throw new Error(`unknown fleet action '${params.action}'`);
  }
}
