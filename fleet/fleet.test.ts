import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { loadFleetConfig, resolveRoleSpec } from "./config.ts";
import {
  Fleet,
  MAX_LOG_LINE_BYTES,
  parseFleetCommand,
  planOpenLaunch,
  readLogTailEntries,
  toolParamsToCommand,
} from "./fleet.ts";
import { addWorktree, branchExists, diffForReview, git, headRev, mergeBranch } from "./gitw.ts";
import registerFleet from "./index.ts";
import { isPidAlive, loadManifest, saveManifest } from "./manifest.ts";
import { roleAppend } from "./roles.ts";
import { getProcessInfo, hasFleetCommandIdentity, RpcMember, winQuote } from "./rpc.ts";
import type { Member, MemberStatus, NotifyLevel } from "./types.ts";

const FAKE_PI_SCRIPT = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

if (process.argv.some((a) => a.startsWith("fleet:spawn-fail"))) {
  process.exit(0);
}

writeFileSync(path.join(process.cwd(), ".rpc-argv.json"), JSON.stringify(process.argv.slice(2)), "utf8");

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    appendFileSync(path.join(process.cwd(), ".rpc-received.jsonl"), JSON.stringify(msg) + "\\n");
    if (msg.type === "get_state") {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: msg.id,
        success: true,
        data: { sessionFile: path.join(process.cwd(), "session.json") },
      }) + "\\n");
    } else {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: msg.id,
        success: true,
        data: {},
      }) + "\\n");
      const activeMsg =
        typeof msg.message === "string"
          ? msg.message.replace(/Original assignment:[\\s\\S]*?(?=\\n\\nAdditional instructions|$)/, "")
          : "";
      const parseTimedPayload = (prefix) => {
        const rest = activeMsg.slice(prefix.length);
        const colon = rest.indexOf(":");
        return { ms: Number(rest.slice(0, colon)), payload: rest.slice(colon + 1) };
      };
      if (msg.type === "prompt" && activeMsg.includes("FINISH_NOW")) {
        const customIdx = activeMsg.indexOf("FINISH_NOW:");
        const content =
          customIdx >= 0
            ? activeMsg.slice(customIdx + "FINISH_NOW:".length)
            : "DONE: finished work";
        process.stdout.write(JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content },
        }) + "\\n");
      } else if (msg.type === "prompt" && activeMsg.startsWith("DELAY_DONE:")) {
        const { ms, payload } = parseTimedPayload("DELAY_DONE:");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: payload },
          }) + "\\n");
        }, ms);
      } else if (msg.type === "prompt" && activeMsg.startsWith("WRITE_ASK:")) {
        const { ms, payload } = parseTimedPayload("WRITE_ASK:");
        setTimeout(() => {
          writeFileSync(path.join(process.cwd(), "FLEET_ASK.md"), payload + "\\n", "utf8");
        }, ms);
      } else if (msg.type === "prompt" && activeMsg.startsWith("EXIT_AFTER:")) {
        const { ms, payload } = parseTimedPayload("EXIT_AFTER:");
        setTimeout(() => {
          process.exit(Number(payload));
        }, ms);
      } else if (msg.type === "prompt" && activeMsg.startsWith("DONE_AND_EXIT:")) {
        const { ms, payload } = parseTimedPayload("DONE_AND_EXIT:");
        process.stdout.write(JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: payload },
        }) + "\\n");
        setTimeout(() => {
          process.exit(0);
        }, ms);
      } else if (msg.type === "prompt" && activeMsg.startsWith("BUSY_NOW")) {
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
      } else if (msg.type === "prompt" && activeMsg.startsWith("SETTLED_NOW")) {
        process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\\n");
        setTimeout(() => {
          process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
        }, 30);
      }
    }
  }
});
`;

interface TestHarness {
  root: string;
  notifications: Array<{ text: string; level: NotifyLevel }>;
  widgetLines: () => string[] | undefined;
  errors: () => string[];
  reconcileSession: () => Promise<void>;
  runCommand: (args: string) => Promise<void>;
  runTool: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<{ text: string; isError: boolean }>;
  seedMember: (
    name: string,
    status: MemberStatus,
    opts?: {
      task?: string;
      unmergedCommit?: boolean;
      mergedCommit?: boolean;
      conflictingCommit?: boolean;
      createdAt?: number;
      result?: string;
      needsAttention?: string;
    },
  ) => Promise<Member>;
  cleanup: () => Promise<void>;
}

async function createHarness(): Promise<TestHarness> {
  const rawRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-test-"));
  await git(rawRoot, "init", "-b", "main");
  await git(rawRoot, "config", "user.email", "test@example.com");
  await git(rawRoot, "config", "user.name", "Test User");
  await writeFile(path.join(rawRoot, "README.md"), "initial\n", "utf8");
  await git(rawRoot, "add", "README.md");
  await git(rawRoot, "commit", "-m", "initial");
  await writeFile(
    path.join(rawRoot, ".git", "info", "exclude"),
    ".rpc-received.jsonl\n.rpc-argv.json\nsession.json\n",
    "utf8",
  );

  const root = await git(rawRoot, "rev-parse", "--show-toplevel");
  const baseRef = await headRev(root);

  const binDir = await mkdtemp(path.join(tmpdir(), "pi-fleet-bin-"));
  const mjsPath = path.join(binDir, "fake-pi.mjs");
  await writeFile(mjsPath, FAKE_PI_SCRIPT, "utf8");
  await chmod(mjsPath, 0o755);

  let piBin = mjsPath;
  if (process.platform === "win32") {
    const cmdPath = path.join(binDir, "fake-pi.cmd");
    await writeFile(cmdPath, `@node "%~dp0fake-pi.mjs" %*\r\n`, "utf8");
    piBin = cmdPath;
  }

  await mkdir(path.join(root, ".pi", "fleet"), { recursive: true });
  await writeFile(
    path.join(root, ".pi", "fleet", "config.json"),
    JSON.stringify({ piBin }),
    "utf8",
  );

  const notifications: Array<{ text: string; level: NotifyLevel }> = [];
  let currentWidget: string[] | undefined;
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  let sessionStartHandler: ((event: any, ctx: any) => Promise<void>) | undefined;
  let toolExecutor:
    | ((id: string, params: any, sig: any, upd: any, ctx: any) => Promise<any>)
    | undefined;
  const shutdownHandlers: Array<() => Promise<void> | void> = [];

  function bindExtension(): void {
    shutdownHandlers.length = 0;
    const fakePi: any = {
      on: (event: string, fn: (event: any, ctx: any) => Promise<void> | void) => {
        if (event === "session_start") sessionStartHandler = fn;
        if (event === "session_shutdown") shutdownHandlers.push(fn);
      },
      registerCommand: (name: string, spec: { handler: (args: string, ctx: any) => Promise<void> }) => {
        if (name === "fleet") commandHandler = spec.handler;
      },
      registerTool: (spec: { name: string; execute: any }) => {
        if (spec.name === "fleet") toolExecutor = spec.execute;
      },
    };
    registerFleet(fakePi);
  }
  bindExtension();

  const ctx = {
    cwd: root,
    ui: {
      notify: (text: string, level: NotifyLevel = "info") => {
        notifications.push({ text, level });
      },
      setWidget: (_id: string, lines: string[] | undefined) => {
        currentWidget = lines;
      },
    },
  };

  async function seedMember(
    name: string,
    status: MemberStatus,
    opts?: {
      task?: string;
      unmergedCommit?: boolean;
      mergedCommit?: boolean;
      conflictingCommit?: boolean;
      createdAt?: number;
      result?: string;
      needsAttention?: string;
    },
  ): Promise<Member> {
    const branch = `fleet/${name}`;
    const wt = path.join(root, ".pi", "fleet", "wt", name);
    await addWorktree(root, wt, branch, baseRef);

    if (opts?.conflictingCommit) {
      await writeFile(path.join(wt, "README.md"), `branch-${name}\n`, "utf8");
      await git(wt, "add", "README.md");
      await git(wt, "commit", "-m", `conflict by ${name}`);
      await writeFile(path.join(root, "README.md"), `main-change-against-${name}\n`, "utf8");
      await git(root, "add", "README.md");
      await git(root, "commit", "-m", `main change against ${name}`);
    } else if (opts?.unmergedCommit || opts?.mergedCommit) {
      await writeFile(path.join(wt, `${name}.txt`), `${name}\n`, "utf8");
      await git(wt, "add", `${name}.txt`);
      await git(wt, "commit", "-m", `work by ${name}`);
    }
    if (opts?.mergedCommit) {
      await mergeBranch(root, branch, `merge ${name}`);
    }

    const man = await loadManifest(root);
    const ts = opts?.createdAt ?? Date.now();
    const member: Member = {
      name,
      role: "coder",
      task: opts?.task ?? `task for ${name}`,
      branch,
      worktree: wt,
      baseRef,
      status,
      ...(opts?.result !== undefined ? { result: opts.result } : {}),
      ...(opts?.needsAttention !== undefined ? { needsAttention: opts.needsAttention } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    man.members[name] = member;
    await saveManifest(man);
    bindExtension();
    return member;
  }

  return {
    root,
    notifications,
    widgetLines: () => currentWidget,
    errors: () => notifications.filter((n) => n.level === "error").map((n) => n.text),
    reconcileSession: async () => {
      assert.ok(sessionStartHandler, "session_start handler must be registered");
      await sessionStartHandler({}, ctx);
    },
    runCommand: async (args: string) => {
      assert.ok(commandHandler);
      await commandHandler(args, ctx);
    },
    runTool: async (params: Record<string, unknown>, signal?: AbortSignal) => {
      assert.ok(toolExecutor);
      const res = await toolExecutor("call-1", params, signal, undefined, ctx);
      return {
        text: res.content.map((c: any) => c.text).join("\n"),
        isError: !!res.isError,
      };
    },
    seedMember,
    cleanup: async () => {
      for (const fn of shutdownHandlers) await fn();
      await rm(rawRoot, { recursive: true, force: true });
      await rm(binDir, { recursive: true, force: true });
    },
  };
}

describe("parseFleetCommand", () => {
  it("parses empty input as status", () => {
    assert.deepEqual(parseFleetCommand(""), { action: "status" });
  });

  it("parses spawn with flags and strips outer quotes from task", () => {
    assert.deepEqual(
      {
        defaultTransient: parseFleetCommand(
          'spawn --role reviewer --model openai/gpt-5 --over fleet/api r1 "Review the auth work"',
        ),
        explicitTransient: parseFleetCommand('spawn --transient c1 "One-shot coder task"'),
        explicitNoTransient: parseFleetCommand('spawn --role reviewer --no-transient r2 "Keep reviewer around"'),
      },
      {
        defaultTransient: {
          action: "spawn",
          name: "r1",
          task: "Review the auth work",
          role: "reviewer",
          model: "openai/gpt-5",
          over: "fleet/api",
        },
        explicitTransient: {
          action: "spawn",
          name: "c1",
          task: "One-shot coder task",
          transient: true,
        },
        explicitNoTransient: {
          action: "spawn",
          name: "r2",
          task: "Keep reviewer around",
          role: "reviewer",
          transient: false,
        },
      },
    );
  });

  it("parses clean --done and --force in either flag order", () => {
    assert.deepEqual(parseFleetCommand("clean --force --done"), {
      action: "clean",
      target: { kind: "done" },
      force: true,
    });
  });

  it("parses resume with quoted extra instructions", () => {
    assert.deepEqual(parseFleetCommand('resume api "Finish validation tests"'), {
      action: "resume",
      name: "api",
      extra: "Finish validation tests",
    });
  });

  it("rejects missing required target on clean", () => {
    assert.throws(() => parseFleetCommand("clean --force"), /usage: \/fleet clean/);
  });

  it("parses wait with default all, --all, named members, --any, and --timeout in any order", () => {
    assert.deepEqual(
      {
        defaultAll: parseFleetCommand("wait"),
        explicitAll: parseFleetCommand("wait --all --any"),
        namedWithFlags: parseFleetCommand("wait --any --timeout 15 api ui"),
        flagsAfterTarget: parseFleetCommand("wait api --timeout 5 --any"),
      },
      {
        defaultAll: { action: "wait", target: { kind: "all" } },
        explicitAll: { action: "wait", target: { kind: "all" }, mode: "any" },
        namedWithFlags: {
          action: "wait",
          target: { kind: "members", names: ["api", "ui"] },
          mode: "any",
          timeout: 15,
        },
        flagsAfterTarget: {
          action: "wait",
          target: { kind: "members", names: ["api"] },
          mode: "any",
          timeout: 5,
        },
      },
    );
  });

  it("rejects invalid --timeout values, unknown flags, or mixing --all with names on wait", () => {
    const usageRe = /usage: \/fleet wait \[name\|--all\] \[--any\] \[--timeout <sec>\]/;
    assert.throws(() => parseFleetCommand("wait --timeout"), usageRe);
    assert.throws(() => parseFleetCommand("wait --timeout 0"), usageRe);
    assert.throws(() => parseFleetCommand("wait --timeout -5"), usageRe);
    assert.throws(() => parseFleetCommand("wait --timeout abc"), usageRe);
    assert.throws(() => parseFleetCommand("wait --bogus"), usageRe);
    assert.throws(() => parseFleetCommand("wait --all api"), usageRe);
  });
});

describe("toolParamsToCommand", () => {
  it("maps spawn parameters including over and transient to a spawn command", () => {
    assert.deepEqual(
      {
        withTransientTrue: toolParamsToCommand({
          action: "spawn",
          name: "rev1",
          task: "Review PR",
          role: "reviewer",
          over: "fleet/api",
          transient: true,
        }),
        withTransientFalse: toolParamsToCommand({
          action: "spawn",
          name: "rev2",
          task: "Persistent review",
          role: "reviewer",
          transient: false,
        }),
      },
      {
        withTransientTrue: {
          action: "spawn",
          name: "rev1",
          task: "Review PR",
          role: "reviewer",
          over: "fleet/api",
          transient: true,
        },
        withTransientFalse: {
          action: "spawn",
          name: "rev2",
          task: "Persistent review",
          role: "reviewer",
          transient: false,
        },
      },
    );
  });

  it("maps batch spawn members and rejects empty, mixed, or invalid member entries", () => {
    assert.deepEqual(
      toolParamsToCommand({
        action: "spawn",
        members: [
          { name: "rev-std", task: "Standards review", role: "reviewer", over: "main..HEAD", transient: false },
          { name: "coder-1", task: "Implement feature", model: "openai/gpt-5", transient: true },
        ],
      }),
      {
        action: "spawn",
        members: [
          { name: "rev-std", task: "Standards review", role: "reviewer", over: "main..HEAD", transient: false },
          { name: "coder-1", task: "Implement feature", model: "openai/gpt-5", transient: true },
        ],
      },
    );

    assert.throws(() => toolParamsToCommand({ action: "spawn", members: [] }), /non-empty/);
    assert.throws(
      () =>
        toolParamsToCommand({
          action: "spawn",
          name: "single",
          task: "Single task",
          members: [{ name: "m1", task: "Task 1" }],
        }),
      /cannot mix|requires/i,
    );
    assert.throws(
      () =>
        toolParamsToCommand({
          action: "spawn",
          transient: true,
          members: [{ name: "m1", task: "Task 1" }],
        } as any),
      /cannot mix|requires/i,
    );
    assert.throws(
      () =>
        toolParamsToCommand({
          action: "spawn",
          members: [{ name: "m1", task: "" }],
        }),
      /name and task/i,
    );
    assert.throws(
      () =>
        toolParamsToCommand({
          action: "spawn",
          members: [{ name: "m1", task: "Task 1", role: "bogus" as any }],
        }),
      /role/i,
    );
  });

  it("maps resume message to extra instructions", () => {
    assert.deepEqual(
      toolParamsToCommand({
        action: "resume",
        name: "api",
        message: "Cover edge cases",
      }),
      {
        action: "resume",
        name: "api",
        extra: "Cover edge cases",
      },
    );
  });

  it("maps wait parameters for all, single name, and multiple names with mode and timeout", () => {
    const usageRe = /usage: \/fleet wait \[name\|--all\] \[--any\] \[--timeout <sec>\]/;
    assert.throws(() => toolParamsToCommand({ action: "wait", names: [] }), usageRe);
    assert.throws(() => toolParamsToCommand({ action: "wait", name: "   " }), usageRe);
    assert.throws(() => toolParamsToCommand({ action: "wait", name: 42 as unknown as string }), usageRe);
    assert.throws(() => toolParamsToCommand({ action: "wait", names: ["api", 42 as unknown as string] }), usageRe);
    assert.throws(() => toolParamsToCommand({ action: "wait", names: "api" as unknown as string[] }), usageRe);
    assert.deepEqual(
      {
        allOmitted: toolParamsToCommand({ action: "wait" }),
        allExplicit: toolParamsToCommand({ action: "wait", name: "--all", mode: "any", timeout: 10 }),
        singleName: toolParamsToCommand({ action: "wait", name: "api" }),
        multipleNames: toolParamsToCommand({
          action: "wait",
          names: ["api", "ui"],
          mode: "any",
          timeout: 30,
        }),
      },
      {
        allOmitted: { action: "wait", target: { kind: "all" } },
        allExplicit: { action: "wait", target: { kind: "all" }, mode: "any", timeout: 10 },
        singleName: { action: "wait", target: { kind: "members", names: ["api"] } },
        multipleNames: {
          action: "wait",
          target: { kind: "members", names: ["api", "ui"] },
          mode: "any",
          timeout: 30,
        },
      },
    );
  });
});

describe("Fleet execution through /fleet command and fleet tool adapters", () => {
  it("spawns a member, sends initial prompt, and stops it via --all", async () => {
    const h = await createHarness();
    try {
      const spawnRes = await h.runTool({
        action: "spawn",
        name: "api",
        task: "Implement OAuth login",
      });
      assert.equal(spawnRes.isError, false);

      await h.runCommand("stop --all");
      const man = await loadManifest(h.root);
      assert.equal(man.members.api.status, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("stops an attached member that already reached done status and transitions it to stopped", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "finisher",
        task: "FINISH_NOW",
      });
      await new Promise((r) => setTimeout(r, 150));
      const beforeStop = await loadManifest(h.root);
      assert.equal(beforeStop.members.finisher.status, "done");

      await h.runCommand("stop --all");
      const afterStop = await loadManifest(h.root);
      assert.equal(afterStop.members.finisher.status, "stopped");
    } finally {
      await h.cleanup();
    }
  });

  it("kills the live process of a detached member when stopped and clears its pid", async () => {
    const h = await createHarness();
    const sleeper = spawnChild(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc", "--name", "fleet:ghost"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      const m = await h.seedMember("ghost", "detached");
      const man = await loadManifest(h.root);
      const info = await getProcessInfo(sleeper.pid!);
      assert.equal(info.status, "ok");
      man.members[m.name].pid = sleeper.pid;
      man.members[m.name].pidStartedAt = info.info.startedAt;
      await saveManifest(man);

      await h.runCommand("stop ghost");
      const afterStop = await loadManifest(h.root);
      assert.deepEqual(
        {
          status: afterStop.members.ghost.status,
          pid: afterStop.members.ghost.pid,
          alive: isPidAlive(sleeper.pid),
        },
        {
          status: "stopped",
          pid: undefined,
          alive: false,
        },
      );
    } finally {
      try {
        sleeper.kill();
      } catch {
        // already killed
      }
      await h.cleanup();
    }
  });

  it("preserves member.task in manifest on resume while forwarding extra instructions", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("api", "stale", { task: "Implement OAuth login" });

      await h.runCommand('resume api "Also cover PKCE token refresh"');
      const manAfterResume = await loadManifest(h.root);
      const promptFile = await readFile(
        path.join(h.root, ".pi", "fleet", "prompts", "api.md"),
        "utf8",
      );
      const receivedRaw = await readFile(
        path.join(h.root, ".pi", "fleet", "wt", "api", ".rpc-received.jsonl"),
        "utf8",
      );
      await h.runCommand("stop api");

      assert.deepEqual(
        {
          taskInManifest: manAfterResume.members.api.task,
          promptFileHasExtra: promptFile.includes("Also cover PKCE token refresh"),
          rpcPromptHasExtra: receivedRaw.includes("Also cover PKCE token refresh"),
        },
        {
          taskInManifest: "Implement OAuth login",
          promptFileHasExtra: true,
          rpcPromptHasExtra: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("delivers send messages and tails member activity logs through the tool adapter", async () => {
    const h = await createHarness();
    try {
      await h.runTool({ action: "spawn", name: "coder1", task: "Initial task" });
      const sendRes = await h.runTool({
        action: "send",
        name: "coder1",
        message: "Use strict types",
      });

      const logPath = path.join(h.root, ".pi", "fleet", "logs", "coder1.jsonl");
      await writeFile(
        logPath,
        [
          JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: "DONE: completed checks" },
          }),
        ].join("\n") + "\n",
        { flag: "a" },
      );

      const logRes = await h.runTool({ action: "log", name: "coder1", n: 5 });
      await h.runTool({ action: "stop", name: "--all" });

      assert.deepEqual(
        {
          sendText: sendRes.text,
          hasToolEntry: logRes.text.includes("tool: read"),
          hasAssistantEntry: logRes.text.includes("assistant: DONE: completed checks"),
        },
        {
          sendText: "fleet: sent to 'coder1' (prompt)",
          hasToolEntry: true,
          hasAssistantEntry: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("merges only done members on merge --done and reports error level on conflicts", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("m1", "done", { unmergedCommit: true });
      await h.seedMember("m2", "running", { unmergedCommit: true });

      await h.runCommand("merge --done");
      const man = await loadManifest(h.root);
      assert.equal(man.members.m1.status, "merged");
      assert.equal(man.members.m2.status, "running");

      await h.seedMember("m3", "done", { conflictingCommit: true });
      await h.runCommand("merge --done");
      assert.equal(
        h.errors().some((e) => e.includes("merge m3 CONFLICTS in: README.md")),
        true,
      );
    } finally {
      await h.cleanup();
    }
  });

  it("cleans finished and detached members (stopping live detached PIDs) on clean --done while leaving active members intact", async () => {
    const h = await createHarness();
    const sleeper = spawnChild(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc", "--name", "fleet:fin-detached"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      const finished: MemberStatus[] = ["done", "merged", "failed", "stopped", "stale", "detached"];
      const untouched: MemberStatus[] = ["starting", "running", "idle"];

      for (const status of finished) {
        await h.seedMember(`fin-${status}`, status, {
          mergedCommit: status === "merged",
          unmergedCommit: status !== "merged",
        });
      }
      const manBefore = await loadManifest(h.root);
      const sleeperInfo = await getProcessInfo(sleeper.pid!);
      assert.equal(sleeperInfo.status, "ok");
      manBefore.members["fin-detached"].pid = sleeper.pid;
      manBefore.members["fin-detached"].pidStartedAt = sleeperInfo.info.startedAt;
      await saveManifest(manBefore);

      for (const status of untouched) {
        await h.seedMember(`keep-${status}`, status);
      }

      await h.seedMember("direct-detached", "detached");
      const directDetachedClean = await h.runTool({ action: "clean", name: "direct-detached" });
      await h.seedMember("dirty-stopped", "stopped");
      await writeFile(path.join(h.root, ".pi", "fleet", "wt", "dirty-stopped", "uncommitted.txt"), "dirty\n", "utf8");
      const dirtyCleanWithoutForce = await h.runTool({ action: "clean", name: "dirty-stopped" });
      await h.runTool({ action: "clean", name: "dirty-stopped", force: true });

      await h.runCommand("clean --done");
      const man = await loadManifest(h.root);

      assert.deepEqual(
        {
          directDetachedCleanOk: !directDetachedClean.isError,
          dirtyCleanRejectedWithoutForce: dirtyCleanWithoutForce.isError,
          remaining: Object.keys(man.members).sort(),
          mergedBranchGone: !(await branchExists(h.root, "fleet/fin-merged")),
          unmergedDoneBranchKept: await branchExists(h.root, "fleet/fin-done"),
          doneWorktreeGone: !existsSync(path.join(h.root, ".pi", "fleet", "wt", "fin-done")),
          detachedPidAlive: isPidAlive(sleeper.pid),
          detachedWorktreeGone: !existsSync(path.join(h.root, ".pi", "fleet", "wt", "fin-detached")),
          unmergedDetachedBranchKept: await branchExists(h.root, "fleet/fin-detached"),
          errors: h.errors(),
        },
        {
          directDetachedCleanOk: true,
          dirtyCleanRejectedWithoutForce: true,
          remaining: ["keep-idle", "keep-running", "keep-starting"],
          mergedBranchGone: true,
          unmergedDoneBranchKept: true,
          doneWorktreeGone: true,
          detachedPidAlive: false,
          detachedWorktreeGone: true,
          unmergedDetachedBranchKept: true,
          errors: [],
        },
      );
    } finally {
      try {
        sleeper.kill();
      } catch {
        // already killed
      }
      await h.cleanup();
    }
  });

  it("deletes unmerged branches when clean --force is passed in either flag order", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("done-a", "done", { unmergedCommit: true });
      await h.runCommand("clean --done --force");

      await h.seedMember("done-b", "failed", { unmergedCommit: true });
      await h.runCommand("clean --force --done");

      assert.deepEqual(
        {
          doneABranchExists: await branchExists(h.root, "fleet/done-a"),
          doneBBranchExists: await branchExists(h.root, "fleet/done-b"),
          errors: h.errors(),
        },
        {
          doneABranchExists: false,
          doneBBranchExists: false,
          errors: [],
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("returns all members uncapped on status while capping the TUI widget at 8 rows", async () => {
    const h = await createHarness();
    try {
      for (let i = 1; i <= 10; i++) {
        await h.seedMember(`m${i}`, "done", { createdAt: i * 100 });
      }

      const statusRes = await h.runTool({ action: "status" });
      assert.deepEqual(
        {
          statusLineCount: statusRes.text.split("\n").length,
          widgetLineCount: h.widgetLines()?.length,
          widgetFooter: h.widgetLines()?.[9],
        },
        {
          statusLineCount: 11,
          widgetLineCount: 10,
          widgetFooter: " … 2 more",
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears the TUI widget when cleaning the last member", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("last-done", "done");
      await h.runCommand("status");
      const rendered = h.widgetLines();

      await h.runCommand("clean last-done");

      assert.deepEqual(
        { rendered, afterClean: h.widgetLines(), errors: h.errors() },
        {
          rendered: ["fleet: 1 member (0 active)", " · last-done    coder      done"],
          afterClean: undefined,
          errors: [],
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears a stale TUI widget on status when no members exist", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("stale", "done");
      await h.runCommand("status");
      await h.runCommand("clean stale");
      await h.runCommand("status");

      assert.deepEqual(
        { widget: h.widgetLines(), errors: h.errors() },
        { widget: undefined, errors: [] },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears a stale TUI widget on session_start when no members exist", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("stale", "done");
      await h.runCommand("status");
      await h.runCommand("clean stale");
      await h.reconcileSession();

      assert.deepEqual(
        { widget: h.widgetLines(), errors: h.errors() },
        { widget: undefined, errors: [] },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("persists full DONE message on member.result and clears it on resume or re-spawn", async () => {
    const h = await createHarness();
    try {
      const fullDone = "DONE: implemented auth flow\n\nDetails:\n- added token validation\n- added refresh tests";
      await h.runTool({
        action: "spawn",
        name: "finisher",
        task: `FINISH_NOW:  ${fullDone}  \n`,
      });
      await new Promise((r) => setTimeout(r, 150));
      const afterDone = await loadManifest(h.root);
      const firstPid = afterDone.members.finisher.pid;

      await h.runCommand('resume finisher "Continue with edge cases"');
      const afterResume = await loadManifest(h.root);
      await h.runCommand("stop finisher");

      assert.deepEqual(
        {
          doneStatus: afterDone.members.finisher.status,
          doneResult: afterDone.members.finisher.result,
          firstPidStoppedOnResume: !isPidAlive(firstPid),
          resumedResult: afterResume.members.finisher.result,
        },
        {
          doneStatus: "done",
          doneResult: fullDone,
          firstPidStoppedOnResume: true,
          resumedResult: undefined,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("transitions a member emitting FAILED: to failed status, stores full result, notifies error, resolves wait, and skips it on merge --done", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("passing-coder", "done", { unmergedCommit: true });

      const fullFailed =
        "FAILED: 2 blocker defects found\nDONE: parser step passed\n- auth.ts:42 missing signature check\n- session.ts:18 token leak";
      await h.runTool({
        action: "spawn",
        name: "failing-rev",
        role: "reviewer",
        task: `DELAY_DONE:80:  ${fullFailed}  \n`,
      });
      const waitRes = await h.runTool({ action: "wait", name: "failing-rev", timeout: 1 });
      const afterFailed = await loadManifest(h.root);

      await h.runCommand("merge --done");
      const afterMerge = await loadManifest(h.root);
      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          failedStatus: afterFailed.members["failing-rev"].status,
          failedResult: afterFailed.members["failing-rev"].result,
          errorNotified: h.notifications.some(
            (n) => n.level === "error" && n.text === "fleet member 'failing-rev' reports FAILED",
          ),
          waitHasFailedStatus: waitRes.text.includes("status=failed"),
          waitHasFullResult: waitRes.text.includes(fullFailed),
          failedSkippedOnMergeDone: afterMerge.members["failing-rev"].status,
          doneMergedOnMergeDone: afterMerge.members["passing-coder"].status,
        },
        {
          failedStatus: "failed",
          failedResult: fullFailed,
          errorNotified: true,
          waitHasFailedStatus: true,
          waitHasFullResult: true,
          failedSkippedOnMergeDone: "failed",
          doneMergedOnMergeDone: "merged",
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("keeps the final DONE message untruncated in log while truncating earlier assistant messages", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("logger", "done");
      const logPath = path.join(h.root, ".pi", "fleet", "logs", "logger.jsonl");
      await mkdir(path.dirname(logPath), { recursive: true });

      const longProgress = `Investigating module\n${"a".repeat(260)}`;
      const earlierDone = `DONE: first attempt\n${"b".repeat(260)}`;
      const finalDone = `DONE: final report\n\nSection 1:\n${"c".repeat(260)}\n\nSection 2: verified`;

      await writeFile(
        logPath,
        [
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: longProgress },
          }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: earlierDone },
          }),
          JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: finalDone },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const logRes = await h.runTool({ action: "log", name: "logger", n: 10 });

      await h.seedMember("fail-logger", "failed");
      const failLogPath = path.join(h.root, ".pi", "fleet", "logs", "fail-logger.jsonl");
      const earlierFailed = `FAILED: initial failure\n${"d".repeat(260)}`;
      const finalFailed = `FAILED: final blocker report\n\nSection 1:\n${"e".repeat(260)}\n\nSection 2: unresolved`;

      await writeFile(
        failLogPath,
        [
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: earlierDone },
          }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: earlierFailed },
          }),
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: finalFailed },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      const failLogRes = await h.runTool({ action: "log", name: "fail-logger", n: 10 });

      assert.deepEqual(
        {
          progressTruncated: !logRes.text.includes("a".repeat(240)) && logRes.text.includes("assistant: Investigating module "),
          earlierDoneTruncated: !logRes.text.includes("b".repeat(240)) && logRes.text.includes("assistant: DONE: first attempt "),
          finalDoneUntruncated: logRes.text.includes(`assistant: ${finalDone}`),
          earlierDoneBeforeFailedTruncated:
            !failLogRes.text.includes("b".repeat(240)) &&
            failLogRes.text.includes("assistant: DONE: first attempt "),
          earlierFailedTruncated:
            !failLogRes.text.includes("d".repeat(240)) &&
            failLogRes.text.includes("assistant: FAILED: initial failure "),
          finalFailedUntruncated: failLogRes.text.includes(`assistant: ${finalFailed}`),
        },
        {
          progressTruncated: true,
          earlierDoneTruncated: true,
          finalDoneUntruncated: true,
          earlierDoneBeforeFailedTruncated: true,
          earlierFailedTruncated: true,
          finalFailedUntruncated: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("resolves wait immediately for already-settled or needsAttention members and rejects unknown members", async () => {
    const h = await createHarness();
    try {
      const missingRes = await h.runTool({ action: "wait", name: "missing" });

      const fullResult = "DONE: completed auth\n\nParagraph 2: all 14 tests green";
      await h.seedMember("m-done", "done", { unmergedCommit: true, result: fullResult });
      await h.seedMember("m-ask", "running", { needsAttention: "Use JWT or session cookies?" });
      await h.seedMember("m-failed", "failed");
      await h.seedMember("m-stopped", "stopped");
      await h.seedMember("m-stale", "stale");
      await h.seedMember("m-merged", "merged", { mergedCommit: true });

      const doneWait = await h.runTool({ action: "wait", name: "m-done" });
      const askWait = await h.runTool({ action: "wait", name: "m-ask" });
      const allWait = await h.runTool({ action: "wait" });

      assert.deepEqual(
        {
          missingError: missingRes.isError && missingRes.text.includes("no such member 'missing'"),
          doneHasStatus: doneWait.text.includes("status=done"),
          doneHasCommit: doneWait.text.includes("work by m-done"),
          doneHasFullResult: doneWait.text.includes(fullResult),
          askHasQuestion: askWait.text.includes("Use JWT or session cookies?"),
          allHasAllSettled:
            !allWait.isError &&
            allWait.text.includes("m-done") &&
            allWait.text.includes("m-ask") &&
            allWait.text.includes("m-failed") &&
            allWait.text.includes("m-stopped") &&
            allWait.text.includes("m-stale") &&
            allWait.text.includes("m-merged"),
        },
        {
          missingError: true,
          doneHasStatus: true,
          doneHasCommit: true,
          doneHasFullResult: true,
          askHasQuestion: true,
          allHasAllSettled: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("blocks wait on running members until they finish with DONE, write FLEET_ASK.md, or exit unexpectedly", async () => {
    const h = await createHarness();
    try {
      const asyncReport = "DONE: completed async work\n\nAll checks passed";
      await h.runTool({
        action: "spawn",
        name: "m-done",
        task: `DELAY_DONE:120:${asyncReport}`,
      });
      const doneWait = await h.runTool({ action: "wait", name: "m-done" });

      await h.runTool({
        action: "spawn",
        name: "m-ask",
        task: "WRITE_ASK:80:Should we support legacy tokens?",
      });
      const askWait = await h.runTool({ action: "wait", name: "m-ask" });
      await h.runTool({
        action: "send",
        name: "m-ask",
        message: "DELAY_DONE:100:DONE: answered and completed",
      });
      const afterSendWait = await h.runTool({ action: "wait", name: "m-ask" });

      await h.runTool({
        action: "spawn",
        name: "m-crash",
        task: "EXIT_AFTER:80:1",
      });
      const crashWait = await h.runTool({ action: "wait", name: "m-crash" });

      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          doneResolved: doneWait.text.includes("status=done") && doneWait.text.includes(asyncReport),
          askResolved: askWait.text.includes("ASK: Should we support legacy tokens?"),
          afterSendBlockedUntilDone:
            afterSendWait.text.includes("status=done") &&
            afterSendWait.text.includes("DONE: answered and completed") &&
            !afterSendWait.text.includes("ASK:"),
          crashResolved: crashWait.text.includes("status=failed"),
        },
        {
          doneResolved: true,
          askResolved: true,
          afterSendBlockedUntilDone: true,
          crashResolved: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("supports wait mode=any, wait --all, and reports settled vs running members on timeout", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "fast",
        task: "DELAY_DONE:100:DONE: fast member finished",
      });
      await h.runTool({
        action: "spawn",
        name: "slow",
        task: "Stay running until prompted",
      });

      const anyRes = await h.runTool({
        action: "wait",
        names: ["fast", "slow"],
        mode: "any",
      });
      const manAfterAny = await loadManifest(h.root);

      const timeoutRes = await h.runTool({
        action: "wait",
        timeout: 0.15,
      });

      await h.runTool({
        action: "send",
        name: "slow",
        message: "FINISH_NOW:DONE: slow member finished",
      });
      const allRes = await h.runTool({ action: "wait", name: "--all" });

      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          fastDoneAfterAny: manAfterAny.members.fast.status,
          slowStillRunningAfterAny: manAfterAny.members.slow.status,
          anyHasFastResult: anyRes.text.includes("DONE: fast member finished"),
          timeoutIndicatesTimeout: /timed out/i.test(timeoutRes.text),
          timeoutShowsSettled: timeoutRes.text.includes("settled: fast"),
          timeoutShowsRunning: timeoutRes.text.includes("running: slow"),
          allHasBothResults:
            allRes.text.includes("DONE: fast member finished") &&
            allRes.text.includes("DONE: slow member finished"),
        },
        {
          fastDoneAfterAny: "done",
          slowStillRunningAfterAny: "running",
          anyHasFastResult: true,
          timeoutIndicatesTimeout: true,
          timeoutShowsSettled: true,
          timeoutShowsRunning: true,
          allHasBothResults: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("writes review-context.md with target, diff base, assignment, commits, and diff for reviewer with --over branch, and not for coder", async () => {
    const h = await createHarness();
    try {
      const apiMember = await h.seedMember("api", "done", { unmergedCommit: true });
      await h.runTool({
        action: "spawn",
        name: "impl",
        role: "coder",
        over: "fleet/api",
        task: "Follow-up coder work",
      });
      await h.runTool({
        action: "spawn",
        name: "rev-branch",
        role: "reviewer",
        over: "fleet/api",
        task: "Check api changes for regressions",
      });
      await h.runCommand("stop --all");

      const coderCtxPath = path.join(h.root, ".pi", "fleet", "wt", "impl", ".pi", "fleet", "review-context.md");
      const revCtxPath = path.join(h.root, ".pi", "fleet", "wt", "rev-branch", ".pi", "fleet", "review-context.md");
      const content = await readFile(revCtxPath, "utf8");

      await h.runCommand('resume rev-branch "Re-check after feedback"');
      await h.runCommand("stop --all");
      const contentAfterResume = await readFile(revCtxPath, "utf8");

      await h.runTool({
        action: "spawn",
        name: "rev-branch",
        role: "reviewer",
        task: "Fresh reviewer task without --over",
      });
      await h.runCommand("stop --all");
      const contentAfterRespawnWithoutOver = await readFile(revCtxPath, "utf8");

      assert.deepEqual(
        {
          coderHasReviewContext: existsSync(coderCtxPath),
          hasTarget: content.includes("Target: `fleet/api`"),
          hasDiffBase: content.includes(`Diff base: \`${apiMember.baseRef}\``),
          hasAssignment: content.includes("## Assignment\n\nCheck api changes for regressions"),
          hasCommit: content.includes("work by api"),
          hasDiff: content.includes("api.txt"),
          preservedOnResume: contentAfterResume.includes("Target: `fleet/api`") && contentAfterResume.includes("api.txt"),
          refreshedOnRespawnWithoutOver:
            contentAfterRespawnWithoutOver.includes("## Assignment\n\nFresh reviewer task without --over") &&
            !contentAfterRespawnWithoutOver.includes("Target: `fleet/api`"),
        },
        {
          coderHasReviewContext: false,
          hasTarget: true,
          hasDiffBase: true,
          hasAssignment: true,
          hasCommit: true,
          hasDiff: true,
          preservedOnResume: true,
          refreshedOnRespawnWithoutOver: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("writes review-context.md when spawning a reviewer without --over", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "rev-default",
        role: "reviewer",
        task: "Audit current HEAD state",
      });
      await h.runCommand("stop --all");

      const man = await loadManifest(h.root);
      const revCtxPath = path.join(h.root, ".pi", "fleet", "wt", "rev-default", ".pi", "fleet", "review-context.md");
      const exists = existsSync(revCtxPath);
      const content = exists ? await readFile(revCtxPath, "utf8") : "";

      assert.deepEqual(
        {
          exists,
          hasTarget: content.includes(`Target: \`${man.members["rev-default"].baseRef}\``),
          hasDiffBase: content.includes("Diff base: `HEAD`"),
          hasAssignment: content.includes("## Assignment\n\nAudit current HEAD state"),
          hasNoCommits: content.includes("## Commits\n\n(no commits)"),
        },
        {
          exists: true,
          hasTarget: true,
          hasDiffBase: true,
          hasAssignment: true,
          hasNoCommits: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("supports two-dot and three-dot commit ranges in --over for reviewer members", async () => {
    const h = await createHarness();
    try {
      await git(h.root, "checkout", "-b", "feature");
      await writeFile(path.join(h.root, "v1.txt"), "v1\n", "utf8");
      await git(h.root, "add", "v1.txt");
      await git(h.root, "commit", "-m", "add v1");
      const v1Rev = await headRev(h.root, "HEAD");

      await writeFile(path.join(h.root, "v2.txt"), "v2\n", "utf8");
      await git(h.root, "add", "v2.txt");
      await git(h.root, "commit", "-m", "add v2");
      const featureHead = await headRev(h.root, "HEAD");

      await git(h.root, "checkout", "main");
      await writeFile(path.join(h.root, "main-only.txt"), "main\n", "utf8");
      await git(h.root, "add", "main-only.txt");
      await git(h.root, "commit", "-m", "advance main");

      const twoDotRes = await h.runTool({
        action: "spawn",
        name: "rev-two-dot",
        role: "reviewer",
        over: `${v1Rev}..feature`,
        task: "Review v2 commit range",
      });
      const threeDotRes = await h.runTool({
        action: "spawn",
        name: "rev-three-dot",
        role: "reviewer",
        over: "main...feature",
        task: "Review feature branch against main merge-base",
      });
      const badBaseRes = await h.runTool({
        action: "spawn",
        name: "rev-bad-base",
        role: "reviewer",
        over: "nonexistent-ref..feature",
        task: "Should reject unknown base ref",
      });
      await h.runCommand("stop --all");

      await h.runTool({
        action: "spawn",
        name: "rev-default-then-range",
        role: "reviewer",
        task: "Initial review at main",
      });
      await h.runCommand("stop rev-default-then-range");
      await h.runTool({
        action: "spawn",
        name: "rev-default-then-range",
        role: "reviewer",
        over: `${v1Rev}..feature`,
        task: "Re-spawned reviewer on commit range",
      });
      await h.runCommand("stop --all");

      const twoDotWt = path.join(h.root, ".pi", "fleet", "wt", "rev-two-dot");
      const threeDotWt = path.join(h.root, ".pi", "fleet", "wt", "rev-three-dot");
      const respawnRangeWt = path.join(h.root, ".pi", "fleet", "wt", "rev-default-then-range");
      const twoDotCtx = await readFile(path.join(twoDotWt, ".pi", "fleet", "review-context.md"), "utf8");
      const threeDotCtx = await readFile(path.join(threeDotWt, ".pi", "fleet", "review-context.md"), "utf8");
      const respawnRangeCtx = await readFile(path.join(respawnRangeWt, ".pi", "fleet", "review-context.md"), "utf8");

      assert.deepEqual(
        {
          twoDotError: twoDotRes.isError,
          threeDotError: threeDotRes.isError,
          badBaseError: badBaseRes.isError,
          twoDotHead: await headRev(twoDotWt, "HEAD"),
          threeDotHead: await headRev(threeDotWt, "HEAD"),
          respawnRangeHead: await headRev(respawnRangeWt, "HEAD"),
          respawnRangeHasAssignment: respawnRangeCtx.includes("## Assignment\n\nRe-spawned reviewer on commit range"),
          twoDotDiffBase: twoDotCtx.includes(`Diff base: \`${v1Rev}\``),
          twoDotHasV2Commit: twoDotCtx.includes("add v2"),
          twoDotHasV1Commit: twoDotCtx.includes("add v1"),
          twoDotHasV2Diff: twoDotCtx.includes("v2.txt"),
          twoDotHasV1Diff: twoDotCtx.includes("v1.txt"),
          threeDotDiffBase: threeDotCtx.includes("Diff base: `main`"),
          threeDotHasV1Commit: threeDotCtx.includes("add v1"),
          threeDotHasV2Commit: threeDotCtx.includes("add v2"),
          threeDotHasMainOnlyCommit: threeDotCtx.includes("advance main"),
          threeDotHasV1Diff: threeDotCtx.includes("v1.txt"),
          threeDotHasV2Diff: threeDotCtx.includes("v2.txt"),
          threeDotHasMainOnlyDiff: threeDotCtx.includes("main-only.txt"),
        },
        {
          twoDotError: false,
          threeDotError: false,
          badBaseError: true,
          twoDotHead: featureHead,
          threeDotHead: featureHead,
          respawnRangeHead: featureHead,
          respawnRangeHasAssignment: true,
          twoDotDiffBase: true,
          twoDotHasV2Commit: true,
          twoDotHasV1Commit: false,
          twoDotHasV2Diff: true,
          twoDotHasV1Diff: false,
          threeDotDiffBase: true,
          threeDotHasV1Commit: true,
          threeDotHasV2Commit: true,
          threeDotHasMainOnlyCommit: false,
          threeDotHasV1Diff: true,
          threeDotHasV2Diff: true,
          threeDotHasMainOnlyDiff: false,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("spawns a batch of members concurrently via members array and registers all in manifest.json", async () => {
    const h = await createHarness();
    try {
      const res = await h.runTool({
        action: "spawn",
        members: [
          { name: "rev-standards", role: "reviewer", task: "DELAY_DONE:80:DONE: standards ok" },
          { name: "rev-spec", role: "reviewer", task: "DELAY_DONE:80:DONE: spec ok" },
          { name: "coder-fix", role: "coder", task: "DELAY_DONE:80:DONE: fix applied" },
        ],
      });
      const manAfterSpawn = await loadManifest(h.root);
      const waitRes = await h.runTool({ action: "wait", name: "--all" });
      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          isError: res.isError,
          lines: res.text.split("\n"),
          manifestNames: Object.keys(manAfterSpawn.members).sort(),
          roles: {
            standards: manAfterSpawn.members["rev-standards"]?.role,
            spec: manAfterSpawn.members["rev-spec"]?.role,
            coder: manAfterSpawn.members["coder-fix"]?.role,
          },
          allSettledInWait:
            waitRes.text.includes("DONE: standards ok") &&
            waitRes.text.includes("DONE: spec ok") &&
            waitRes.text.includes("DONE: fix applied"),
        },
        {
          isError: false,
          lines: [
            "fleet: spawned 'rev-standards' (reviewer) on fleet/rev-standards",
            "fleet: spawned 'rev-spec' (reviewer) on fleet/rev-spec",
            "fleet: spawned 'coder-fix' (coder) on fleet/coder-fix",
          ],
          manifestNames: ["coder-fix", "rev-spec", "rev-standards"],
          roles: {
            standards: "reviewer",
            spec: "reviewer",
            coder: "coder",
          },
          allSettledInWait: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("validates the entire spawn batch upfront and rejects without partial spawns when exceeding maxMembers or invalid", async () => {
    const h = await createHarness();
    try {
      const cfgPath = path.join(h.root, ".pi", "fleet", "config.json");
      const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
      await writeFile(cfgPath, JSON.stringify({ ...cfg, maxMembers: 2 }), "utf8");

      const dupRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "m-dup", task: "First" },
          { name: "m-dup", task: "Duplicate" },
        ],
      });

      const invalidSecondRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "valid-first", task: "Should not be created" },
          { name: "INVALID_NAME", task: "Bad name" },
        ],
      });

      const overLimitRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "m1", task: "Task 1" },
          { name: "m2", task: "Task 2" },
          { name: "m3", task: "Task 3 exceeds maxMembers=2" },
        ],
      });

      const badSecondRefRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "rollback-first", task: "Created then rolled back" },
          { name: "bad-second", over: "nonexistent-ref", task: "Fails headRev" },
        ],
      });

      const manAfterRejected = await loadManifest(h.root);
      const validFirstWtExists = existsSync(path.join(h.root, ".pi", "fleet", "wt", "valid-first"));
      const m1WtExists = existsSync(path.join(h.root, ".pi", "fleet", "wt", "m1"));
      const rollbackFirstWtExists = existsSync(path.join(h.root, ".pi", "fleet", "wt", "rollback-first"));
      const rollbackFirstBranchExists = await branchExists(h.root, "fleet/rollback-first");

      await h.seedMember("resumable-done", "done", { result: "DONE: prior result" });
      const resumeThenBadSecondRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "resumable-done", task: "Would re-spawn if batch succeeded" },
          { name: "bad-second-2", over: "nonexistent-ref", task: "Fails validation" },
        ],
      });
      const manAfterResumeRejected = await loadManifest(h.root);
      await h.runTool({ action: "clean", name: "resumable-done", force: true });

      await h.seedMember("existing-active", "running");
      const conflictExistingRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "uncreated-peer", task: "Should not be created" },
          { name: "existing-active", task: "Already running" },
        ],
      });
      const overLimitWithActiveRes = await h.runTool({
        action: "spawn",
        members: [
          { name: "batch-a", task: "Task A" },
          { name: "batch-b", task: "Task B pushes live 1 + 2 > 2" },
        ],
      });
      const manAfterActiveChecks = await loadManifest(h.root);

      assert.deepEqual(
        {
          dupError: dupRes.isError,
          invalidSecondError: invalidSecondRes.isError,
          overLimitError: overLimitRes.isError && overLimitRes.text.includes("fleet is at max members (2)"),
          badSecondRefError: badSecondRefRes.isError,
          resumeThenBadSecondError: resumeThenBadSecondRes.isError,
          resumablePreservedStatus: manAfterResumeRejected.members["resumable-done"]?.status,
          resumablePreservedResult: manAfterResumeRejected.members["resumable-done"]?.result,
          membersAfterRejected: Object.keys(manAfterRejected.members),
          validFirstWtExists,
          m1WtExists,
          rollbackFirstWtExists,
          rollbackFirstBranchExists,
          conflictExistingError:
            conflictExistingRes.isError &&
            conflictExistingRes.text.includes("member 'existing-active' already exists with status 'running'"),
          overLimitWithActiveError:
            overLimitWithActiveRes.isError &&
            overLimitWithActiveRes.text.includes("fleet is at max members (2)"),
          membersAfterActiveChecks: Object.keys(manAfterActiveChecks.members),
        },
        {
          dupError: true,
          invalidSecondError: true,
          overLimitError: true,
          badSecondRefError: true,
          resumeThenBadSecondError: true,
          resumablePreservedStatus: "done",
          resumablePreservedResult: "DONE: prior result",
          membersAfterRejected: [],
          validFirstWtExists: false,
          m1WtExists: false,
          rollbackFirstWtExists: false,
          rollbackFirstBranchExists: false,
          conflictExistingError: true,
          overLimitWithActiveError: true,
          membersAfterActiveChecks: ["existing-active"],
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("leaves resumed members untouched and removes re-attached worktrees when a batch fails during worktree creation", async () => {
    const h = await createHarness();
    try {
      const goneWt = (await h.seedMember("gone-wt", "stopped")).worktree;
      await git(h.root, "worktree", "remove", "--force", goneWt);

      await h.runTool({ action: "spawn", name: "live-done", task: "FINISH_NOW:DONE: first run" });
      await h.runTool({ action: "wait", name: "live-done" });
      const livePid = (await loadManifest(h.root)).members["live-done"]?.pid;

      await git(h.root, "branch", "fleet/collide");
      const res = await h.runTool({
        action: "spawn",
        members: [
          { name: "live-done", task: "Second run" },
          { name: "gone-wt", task: "Re-attached, then rolled back" },
          { name: "collide", task: "addWorktree fails because the branch exists" },
        ],
      });
      const after = (await loadManifest(h.root)).members;
      const actual = {
        error: res.isError,
        liveStatus: after["live-done"]?.status,
        liveResult: after["live-done"]?.result,
        livePidAlive: !!livePid && isPidAlive(livePid),
        goneWtStatus: after["gone-wt"]?.status,
        goneWtReattached: existsSync(goneWt),
        collideInManifest: "collide" in after,
      };
      await h.runCommand("stop --all");

      assert.deepEqual(actual, {
        error: true,
        liveStatus: "done",
        liveResult: "DONE: first run",
        livePidAlive: true,
        goneWtStatus: "stopped",
        goneWtReattached: false,
        collideInManifest: false,
      });
    } finally {
      await h.cleanup();
    }
  });

  it("serializes manifest writes and preserves all members across concurrent spawn calls and status updates", async () => {
    const h = await createHarness();
    try {
      const m1 = await loadManifest(h.root);
      const m2 = await loadManifest(h.root);
      await Promise.all([
        saveManifest(m1),
        saveManifest(m2),
        saveManifest(m1),
        saveManifest(m2),
      ]);

      const spawnResults = await Promise.all([
        h.runTool({
          action: "spawn",
          name: "c1",
          task: "FINISH_NOW:DONE: c1 finished",
        }),
        h.runTool({
          action: "spawn",
          name: "c2",
          task: "FINISH_NOW:DONE: c2 finished",
        }),
        h.runTool({
          action: "spawn",
          name: "c3",
          task: "FINISH_NOW:DONE: c3 finished",
        }),
      ]);

      const waitRes = await h.runTool({ action: "wait", name: "--all" });
      await h.runCommand("stop --all");
      const finalMan = await loadManifest(h.root);

      assert.deepEqual(
        {
          anySpawnError: spawnResults.some((r) => r.isError),
          waitError: waitRes.isError,
          manifestMembers: Object.keys(finalMan.members).sort(),
          results: {
            c1: finalMan.members.c1?.result,
            c2: finalMan.members.c2?.result,
            c3: finalMan.members.c3?.result,
          },
        },
        {
          anySpawnError: false,
          waitError: false,
          manifestMembers: ["c1", "c2", "c3"],
          results: {
            c1: "DONE: c1 finished",
            c2: "DONE: c2 finished",
            c3: "DONE: c3 finished",
          },
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("auto-cleans transient members on DONE (keeping unmerged branch, deleting merged branch), resolves wait, keeps non-transient members, and keeps a transient member with uncommitted work", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "trans-unmerged",
        transient: true,
        task: "Hold for unmerged commit",
      });
      const unmergedWt = path.join(h.root, ".pi", "fleet", "wt", "trans-unmerged");
      await writeFile(path.join(unmergedWt, "feature.txt"), "feature\n", "utf8");
      await git(unmergedWt, "add", "feature.txt");
      await git(unmergedWt, "commit", "-m", "work by trans-unmerged");

      await h.runTool({
        action: "send",
        name: "trans-unmerged",
        message: "DELAY_DONE:60:DONE: unmerged transient finished",
      });
      const inFlightWait = await h.runTool({ action: "wait", name: "trans-unmerged" });
      const postCleanWait = await h.runTool({ action: "wait", name: "trans-unmerged" });

      await h.runCommand('spawn --transient trans-merged "FINISH_NOW:DONE: merged transient finished"');
      const mergedWait = await h.runTool({ action: "wait", name: "trans-merged" });

      await h.runTool({
        action: "spawn",
        name: "persistent-coder",
        task: "FINISH_NOW:DONE: persistent finished",
      });
      const persistentWait = await h.runTool({ action: "wait", name: "persistent-coder" });

      await h.runTool({ action: "spawn", name: "trans-dirty", transient: true, task: "Hold for uncommitted work" });
      const dirtyWt = path.join(h.root, ".pi", "fleet", "wt", "trans-dirty");
      await writeFile(path.join(dirtyWt, "uncommitted.txt"), "work in progress\n", "utf8");
      await h.runTool({
        action: "send",
        name: "trans-dirty",
        message: "DELAY_DONE:60:DONE: dirty transient finished",
      });
      const dirtyWait = await h.runTool({ action: "wait", name: "trans-dirty" });
      await h.runCommand("stop --all");

      const man = await loadManifest(h.root);

      assert.deepEqual(
        {
          unmergedInManifest: "trans-unmerged" in man.members,
          unmergedWorktreeExists: existsSync(unmergedWt),
          unmergedBranchKept: await branchExists(h.root, "fleet/trans-unmerged"),
          inFlightWaitOk:
            !inFlightWait.isError &&
            inFlightWait.text.includes("status=done") &&
            inFlightWait.text.includes("work by trans-unmerged") &&
            inFlightWait.text.includes("DONE: unmerged transient finished"),
          postCleanWaitOk:
            !postCleanWait.isError &&
            postCleanWait.text.includes("status=done") &&
            postCleanWait.text.includes("work by trans-unmerged") &&
            postCleanWait.text.includes("DONE: unmerged transient finished"),
          mergedInManifest: "trans-merged" in man.members,
          mergedWorktreeExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "trans-merged")),
          mergedBranchGone: !(await branchExists(h.root, "fleet/trans-merged")),
          mergedWaitOk:
            !mergedWait.isError &&
            mergedWait.text.includes("status=done") &&
            mergedWait.text.includes("DONE: merged transient finished"),
          persistentInManifest: "persistent-coder" in man.members,
          persistentWorktreeExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "persistent-coder")),
          persistentWaitOk: !persistentWait.isError && persistentWait.text.includes("DONE: persistent finished"),
          dirtyStatus: man.members["trans-dirty"]?.status,
          dirtyWorkKept: existsSync(path.join(dirtyWt, "uncommitted.txt")),
          dirtyWaitOk: !dirtyWait.isError && dirtyWait.text.includes("DONE: dirty transient finished"),
          dirtyCleanFailureNotified: h.errors().some((e) => e.includes("kept transient member 'trans-dirty'")),
        },
        {
          unmergedInManifest: false,
          unmergedWorktreeExists: false,
          unmergedBranchKept: true,
          inFlightWaitOk: true,
          postCleanWaitOk: true,
          mergedInManifest: false,
          mergedWorktreeExists: false,
          mergedBranchGone: true,
          mergedWaitOk: true,
          persistentInManifest: true,
          persistentWorktreeExists: true,
          persistentWaitOk: true,
          dirtyStatus: "done",
          dirtyWorkKept: true,
          dirtyWaitOk: true,
          dirtyCleanFailureNotified: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("preserves transient members when spawn fails, process exits without DONE (code 0 or non-zero), or member reports FAILED", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "trans-exit-0",
        transient: true,
        task: "EXIT_AFTER:60:0",
      });
      const exit0Wait = await h.runTool({ action: "wait", name: "trans-exit-0" });

      const spawnFailRes = await h.runTool({
        action: "spawn",
        name: "spawn-fail-trans",
        transient: true,
        task: "Should fail during startup",
      });

      await h.runTool({
        action: "spawn",
        name: "trans-exit-1",
        transient: true,
        task: "EXIT_AFTER:60:1",
      });
      await h.runTool({ action: "wait", name: "trans-exit-1" });

      await h.runTool({
        action: "spawn",
        name: "trans-failed-msg",
        transient: true,
        task: "DELAY_DONE:60:FAILED: blocker defect found",
      });
      await h.runTool({ action: "wait", name: "trans-failed-msg" });

      const man = await loadManifest(h.root);
      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          exit0WaitStatusFailed: !exit0Wait.isError && exit0Wait.text.includes("status=failed"),
          exit0Status: man.members["trans-exit-0"]?.status,
          exit0WorktreeExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "trans-exit-0")),
          exit0BranchExists: await branchExists(h.root, "fleet/trans-exit-0"),
          spawnFailError: spawnFailRes.isError,
          spawnFailStatus: man.members["spawn-fail-trans"]?.status,
          spawnFailWorktreeExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "spawn-fail-trans")),
          spawnFailBranchExists: await branchExists(h.root, "fleet/spawn-fail-trans"),
          exit1Status: man.members["trans-exit-1"]?.status,
          exit1WorktreeExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "trans-exit-1")),
          exit1BranchExists: await branchExists(h.root, "fleet/trans-exit-1"),
          failedMsgStatus: man.members["trans-failed-msg"]?.status,
          failedMsgWorktreeExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "trans-failed-msg")),
          failedMsgBranchExists: await branchExists(h.root, "fleet/trans-failed-msg"),
        },
        {
          exit0WaitStatusFailed: true,
          exit0Status: "failed",
          exit0WorktreeExists: true,
          exit0BranchExists: true,
          spawnFailError: true,
          spawnFailStatus: "failed",
          spawnFailWorktreeExists: true,
          spawnFailBranchExists: true,
          exit1Status: "failed",
          exit1WorktreeExists: true,
          exit1BranchExists: true,
          failedMsgStatus: "failed",
          failedMsgWorktreeExists: true,
          failedMsgBranchExists: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("applies reviewer autoClean=true by default and allows role config and spawn transient flags to override in both directions", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        members: [
          { name: "rev-auto", role: "reviewer", task: "FINISH_NOW:DONE: rev auto" },
          { name: "tester-keep", role: "tester", task: "FINISH_NOW:DONE: tester keep" },
        ],
      });
      await h.runCommand('spawn --role reviewer --no-transient rev-keep "FINISH_NOW:DONE: rev keep"');
      await h.runTool({ action: "wait", name: "--all" });
      const manDefault = await loadManifest(h.root);
      await h.runCommand("stop --all");

      const hCfg = await createHarness();
      try {
        const cfgPath = path.join(hCfg.root, ".pi", "fleet", "config.json");
        const baseCfg = JSON.parse(await readFile(cfgPath, "utf8"));
        await writeFile(
          cfgPath,
          JSON.stringify({
            ...baseCfg,
            roles: {
              reviewer: { autoClean: false },
              coder: { autoClean: true },
            },
          }),
          "utf8",
        );

        await hCfg.runTool({
          action: "spawn",
          members: [
            { name: "rev-cfg-keep", role: "reviewer", task: "FINISH_NOW:DONE: rev cfg keep" },
            { name: "coder-cfg-auto", role: "coder", task: "FINISH_NOW:DONE: coder cfg auto" },
            {
              name: "coder-cfg-keep",
              role: "coder",
              transient: false,
              task: "FINISH_NOW:DONE: coder cfg keep",
            },
          ],
        });
        await hCfg.runCommand(
          'spawn --role reviewer --transient rev-cfg-trans "FINISH_NOW:DONE: rev cfg trans"',
        );
        await hCfg.runTool({ action: "wait", name: "--all" });
        const manCfg = await loadManifest(hCfg.root);
        await hCfg.runCommand("stop --all");

        assert.deepEqual(
          {
            defaultRevAutoCleaned:
              !("rev-auto" in manDefault.members) &&
              !existsSync(path.join(h.root, ".pi", "fleet", "wt", "rev-auto")),
            defaultTesterKept:
              "tester-keep" in manDefault.members &&
              existsSync(path.join(h.root, ".pi", "fleet", "wt", "tester-keep")),
            defaultRevOptOutKept:
              "rev-keep" in manDefault.members &&
              existsSync(path.join(h.root, ".pi", "fleet", "wt", "rev-keep")),
            cfgRevKeptByDefault:
              "rev-cfg-keep" in manCfg.members &&
              existsSync(path.join(hCfg.root, ".pi", "fleet", "wt", "rev-cfg-keep")),
            cfgRevTransientOverrideCleaned:
              !("rev-cfg-trans" in manCfg.members) &&
              !existsSync(path.join(hCfg.root, ".pi", "fleet", "wt", "rev-cfg-trans")),
            cfgCoderAutoCleanedByDefault:
              !("coder-cfg-auto" in manCfg.members) &&
              !existsSync(path.join(hCfg.root, ".pi", "fleet", "wt", "coder-cfg-auto")),
            cfgCoderOptOutKept:
              "coder-cfg-keep" in manCfg.members &&
              existsSync(path.join(hCfg.root, ".pi", "fleet", "wt", "coder-cfg-keep")),
          },
          {
            defaultRevAutoCleaned: true,
            defaultTesterKept: true,
            defaultRevOptOutKept: true,
            cfgRevKeptByDefault: true,
            cfgRevTransientOverrideCleaned: true,
            cfgCoderAutoCleanedByDefault: true,
            cfgCoderOptOutKept: true,
          },
        );
      } finally {
        await hCfg.cleanup();
      }
    } finally {
      await h.cleanup();
    }
  });

  it("passes --thinking alongside --model unless the model already embeds a thinking suffix", async () => {
    const h = await createHarness();
    try {
      const cfgPath = path.join(h.root, ".pi", "fleet", "config.json");
      const baseCfg = JSON.parse(await readFile(cfgPath, "utf8"));
      await writeFile(
        cfgPath,
        JSON.stringify({
          ...baseCfg,
          roles: {
            reviewer: { model: "anthropic/claude-opus-4-5", thinking: "high", autoClean: false },
            integrator: { model: "ollama/qwen3:32b", thinking: "medium" },
            coder: { thinking: "low" },
          },
        }),
        "utf8",
      );

      await h.runTool({
        action: "spawn",
        members: [
          { name: "rev-think", role: "reviewer", task: "Review with role model and thinking" },
          {
            name: "rev-embedded",
            role: "reviewer",
            model: "anthropic/claude-opus-4-5:xhigh",
            task: "Review with embedded thinking",
          },
          { name: "int-tag", role: "integrator", task: "Integrate with tagged model and thinking" },
          { name: "coder-think", role: "coder", task: "Code with thinking only" },
        ],
      });
      await h.runCommand("stop --all");

      const readArgv = async (name: string): Promise<string[]> =>
        JSON.parse(
          await readFile(path.join(h.root, ".pi", "fleet", "wt", name, ".rpc-argv.json"), "utf8"),
        );
      const hasOption = (argv: string[], flag: string, val: string): boolean => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] === val;
      };

      const revThink = await readArgv("rev-think");
      const revEmbedded = await readArgv("rev-embedded");
      const intTag = await readArgv("int-tag");
      const coderThink = await readArgv("coder-think");

      assert.deepEqual(
        {
          revThinkModel: hasOption(revThink, "--model", "anthropic/claude-opus-4-5"),
          revThinkLevel: hasOption(revThink, "--thinking", "high"),
          revEmbeddedModel: hasOption(revEmbedded, "--model", "anthropic/claude-opus-4-5:xhigh"),
          revEmbeddedHasThinkingFlag: revEmbedded.includes("--thinking"),
          intTagModel: hasOption(intTag, "--model", "ollama/qwen3:32b"),
          intTagLevel: hasOption(intTag, "--thinking", "medium"),
          coderThinkHasModelFlag: coderThink.includes("--model"),
          coderThinkLevel: hasOption(coderThink, "--thinking", "low"),
        },
        {
          revThinkModel: true,
          revThinkLevel: true,
          revEmbeddedModel: true,
          revEmbeddedHasThinkingFlag: false,
          intTagModel: true,
          intTagLevel: true,
          coderThinkHasModelFlag: false,
          coderThinkLevel: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("cleans non-transient and failed reviewer members without --force when .pi/fleet is not gitignored", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "rev-kept",
        role: "reviewer",
        transient: false,
        task: "FINISH_NOW:DONE: clean review",
      });
      await h.runTool({ action: "wait", name: "rev-kept" });
      await h.runCommand("stop rev-kept");
      const cleanKeptRes = await h.runTool({ action: "clean", name: "rev-kept" });

      await h.runTool({
        action: "spawn",
        name: "rev-failed",
        role: "reviewer",
        task: "DELAY_DONE:60:FAILED: blocker",
      });
      await h.runTool({ action: "wait", name: "rev-failed" });
      await h.runCommand("stop rev-failed");
      const cleanFailedRes = await h.runTool({ action: "clean", name: "--done" });

      await h.runTool({
        action: "spawn",
        name: "rev-dirty",
        role: "reviewer",
        transient: false,
        task: "FINISH_NOW:DONE: dirty review",
      });
      await h.runTool({ action: "wait", name: "rev-dirty" });
      await h.runCommand("stop rev-dirty");
      const dirtyWt = path.join(h.root, ".pi", "fleet", "wt", "rev-dirty");
      await writeFile(path.join(dirtyWt, "extra.txt"), "uncommitted\n", "utf8");
      const cleanDirtyRes = await h.runTool({ action: "clean", name: "rev-dirty" });

      const man = await loadManifest(h.root);

      assert.deepEqual(
        {
          cleanKeptOk: !cleanKeptRes.isError,
          keptInManifest: "rev-kept" in man.members,
          keptWtExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "rev-kept")),
          cleanFailedOk: !cleanFailedRes.isError,
          failedInManifest: "rev-failed" in man.members,
          failedWtExists: existsSync(path.join(h.root, ".pi", "fleet", "wt", "rev-failed")),
          cleanDirtyRejected: cleanDirtyRes.isError,
          dirtyWtStillExists: existsSync(dirtyWt),
          dirtyInManifest: "rev-dirty" in man.members,
        },
        {
          cleanKeptOk: true,
          keptInManifest: false,
          keptWtExists: false,
          cleanFailedOk: true,
          failedInManifest: false,
          failedWtExists: false,
          cleanDirtyRejected: true,
          dirtyWtStillExists: true,
          dirtyInManifest: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("stops detached members on stop --all and kills live detached processes on clean <name> and clean --all", async () => {
    const h = await createHarness();
    const sleeperNames = ["det-a", "det-b", "det-direct", "det-all"];
    const sleepers = sleeperNames.map((n) =>
      spawnChild(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc", "--name", `fleet:${n}`],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      ),
    );
    try {
      await h.seedMember("det-a", "detached");
      await h.seedMember("det-b", "detached");
      const man1 = await loadManifest(h.root);
      const [info0, info1, info2, info3] = await Promise.all(sleepers.map((s) => getProcessInfo(s.pid!)));
      assert.equal(info0.status, "ok");
      assert.equal(info1.status, "ok");
      assert.equal(info2.status, "ok");
      assert.equal(info3.status, "ok");
      man1.members["det-a"].pid = sleepers[0].pid;
      man1.members["det-a"].pidStartedAt = info0.info.startedAt;
      man1.members["det-b"].pid = sleepers[1].pid;
      man1.members["det-b"].pidStartedAt = info1.info.startedAt;
      await saveManifest(man1);

      await h.runCommand("stop --all");
      const afterStopAll = await loadManifest(h.root);
      await h.runCommand("clean --done");

      await h.seedMember("det-direct", "detached");
      await h.seedMember("det-all", "detached");
      const man2 = await loadManifest(h.root);
      man2.members["det-direct"].pid = sleepers[2].pid;
      man2.members["det-direct"].pidStartedAt = info2.info.startedAt;
      man2.members["det-all"].pid = sleepers[3].pid;
      man2.members["det-all"].pidStartedAt = info3.info.startedAt;
      await saveManifest(man2);

      const cleanDirectRes = await h.runTool({ action: "clean", name: "det-direct" });
      const afterDirect = await loadManifest(h.root);
      const directPidAlive = isPidAlive(sleepers[2].pid);

      const cleanAllRes = await h.runTool({ action: "clean", name: "--all" });
      const afterAll = await loadManifest(h.root);
      const allPidAlive = isPidAlive(sleepers[3].pid);

      assert.deepEqual(
        {
          detAStatus: afterStopAll.members["det-a"]?.status,
          detBStatus: afterStopAll.members["det-b"]?.status,
          detAPid: afterStopAll.members["det-a"]?.pid,
          detBPid: afterStopAll.members["det-b"]?.pid,
          s0Alive: isPidAlive(sleepers[0].pid),
          s1Alive: isPidAlive(sleepers[1].pid),
          cleanDirectOk: !cleanDirectRes.isError,
          directPidAlive,
          directWtGone: !existsSync(path.join(h.root, ".pi", "fleet", "wt", "det-direct")),
          directInManifest: "det-direct" in afterDirect.members,
          cleanAllOk: !cleanAllRes.isError,
          allPidAlive,
          allWtGone: !existsSync(path.join(h.root, ".pi", "fleet", "wt", "det-all")),
          remainingAfterCleanAll: Object.keys(afterAll.members),
          errors: h.errors(),
        },
        {
          detAStatus: "stopped",
          detBStatus: "stopped",
          detAPid: undefined,
          detBPid: undefined,
          s0Alive: false,
          s1Alive: false,
          cleanDirectOk: true,
          directPidAlive: false,
          directWtGone: true,
          directInManifest: false,
          cleanAllOk: true,
          allPidAlive: false,
          allWtGone: true,
          remainingAfterCleanAll: [],
          errors: [],
        },
      );
    } finally {
      for (const s of sleepers) {
        try {
          s.kill();
        } catch {
          // already killed
        }
      }
      await h.cleanup();
    }
  });

  it("re-activates a done or failed attached member on send so wait blocks for the new result", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "reprompt",
        task: "FINISH_NOW:DONE: first pass",
      });
      const firstWait = await h.runTool({ action: "wait", name: "reprompt" });

      await h.runTool({
        action: "send",
        name: "reprompt",
        message: "DELAY_DONE:120:DONE: second pass",
      });
      const secondWait = await h.runTool({ action: "wait", name: "reprompt" });

      await h.runTool({
        action: "send",
        name: "reprompt",
        message: "DELAY_DONE:100:FAILED: second fail",
      });
      const failWait = await h.runTool({ action: "wait", name: "reprompt" });

      await h.runTool({
        action: "send",
        name: "reprompt",
        message: "DELAY_DONE:100:DONE: recovered",
      });
      const recoverWait = await h.runTool({ action: "wait", name: "reprompt" });

      await h.runTool({
        action: "send",
        name: "reprompt",
        message: "FINISH_NOW:DONE: instant third",
      });
      await new Promise((r) => setTimeout(r, 80));
      const instantWait = await h.runTool({ action: "wait", name: "reprompt" });
      const man = await loadManifest(h.root);
      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          firstOk: !firstWait.isError && firstWait.text.includes("DONE: first pass"),
          secondOk:
            !secondWait.isError &&
            secondWait.text.includes("status=done") &&
            secondWait.text.includes("DONE: second pass") &&
            !secondWait.text.includes("DONE: first pass"),
          failOk:
            !failWait.isError &&
            failWait.text.includes("status=failed") &&
            failWait.text.includes("FAILED: second fail") &&
            !failWait.text.includes("DONE: second pass"),
          recoverOk:
            !recoverWait.isError &&
            recoverWait.text.includes("status=done") &&
            recoverWait.text.includes("DONE: recovered") &&
            !recoverWait.text.includes("FAILED: second fail"),
          instantStatus: man.members.reprompt?.status,
          instantResult: man.members.reprompt?.result,
          instantWaitOk: !instantWait.isError && instantWait.text.includes("DONE: instant third"),
        },
        {
          firstOk: true,
          secondOk: true,
          failOk: true,
          recoverOk: true,
          instantStatus: "done",
          instantResult: "DONE: instant third",
          instantWaitOk: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("reports cleaned transient snapshots once in wait --all without hijacking later wait --all --any while preserving explicit name lookup", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "rev-first",
        role: "reviewer",
        task: "FINISH_NOW:DONE: first review",
      });
      const firstAllWait = await h.runTool({ action: "wait", name: "--all" });
      const secondAllWait = await h.runTool({ action: "wait", name: "--all" });
      const explicitWait = await h.runTool({ action: "wait", name: "rev-first" });

      await h.runTool({
        action: "spawn",
        name: "slow-coder",
        task: "Stay running until prompted",
      });
      const anyWaitAfterFirst = await h.runTool({
        action: "wait",
        name: "--all",
        mode: "any",
        timeout: 0.15,
      });

      await h.runTool({
        action: "spawn",
        name: "rev-second",
        role: "reviewer",
        task: "FINISH_NOW:DONE: second review",
      });
      await h.runTool({ action: "wait", name: "rev-second" });
      const anyWaitAfterSecond = await h.runTool({
        action: "wait",
        name: "--all",
        mode: "any",
        timeout: 0.15,
      });

      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          firstAllOk: !firstAllWait.isError && firstAllWait.text.includes("DONE: first review"),
          secondAllEmpty: !secondAllWait.isError && secondAllWait.text === "fleet: no members to wait for",
          explicitPreserved: !explicitWait.isError && explicitWait.text.includes("DONE: first review"),
          anyTimedOutOnSlowAfterFirst:
            /timed out/i.test(anyWaitAfterFirst.text) &&
            anyWaitAfterFirst.text.includes("running: slow-coder") &&
            !anyWaitAfterFirst.text.includes("rev-first"),
          anyTimedOutOnSlowAfterSecond:
            /timed out/i.test(anyWaitAfterSecond.text) &&
            anyWaitAfterSecond.text.includes("running: slow-coder") &&
            !anyWaitAfterSecond.text.includes("rev-second"),
        },
        {
          firstAllOk: true,
          secondAllEmpty: true,
          explicitPreserved: true,
          anyTimedOutOnSlowAfterFirst: true,
          anyTimedOutOnSlowAfterSecond: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("resolves wait immediately for detached members and completes wait --all once running members settle", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("m-detached", "detached");
      const singleWait = await h.runTool({ action: "wait", name: "m-detached", timeout: 2 });

      await h.runTool({
        action: "spawn",
        name: "m-run",
        task: "DELAY_DONE:100:DONE: finished running",
      });
      const allWait = await h.runTool({ action: "wait", name: "--all", timeout: 2 });
      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          singleOk:
            !singleWait.isError &&
            singleWait.text.includes("status=detached") &&
            !/timed out/i.test(singleWait.text),
          allOk:
            !allWait.isError &&
            !/timed out/i.test(allWait.text) &&
            allWait.text.includes("status=detached") &&
            allWait.text.includes("DONE: finished running"),
        },
        {
          singleOk: true,
          allOk: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("spawns a member when piBin path contains spaces and arguments contain '=' and commas", async () => {
    const h = await createHarness();
    const spacedRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-spaced-"));
    try {
      const spacedBinDir = path.join(spacedRoot, "pi bin dir");
      await mkdir(spacedBinDir, { recursive: true });
      const mjsPath = path.join(spacedBinDir, "fake-pi.mjs");
      await writeFile(mjsPath, FAKE_PI_SCRIPT, "utf8");
      await chmod(mjsPath, 0o755);

      let piBin = mjsPath;
      if (process.platform === "win32") {
        const cmdPath = path.join(spacedBinDir, "fake-pi.cmd");
        await writeFile(cmdPath, `@node "%~dp0fake-pi.mjs" %*\r\n`, "utf8");
        piBin = cmdPath;
      }

      const cfgPath = path.join(h.root, ".pi", "fleet", "config.json");
      const baseCfg = JSON.parse(await readFile(cfgPath, "utf8"));
      await writeFile(cfgPath, JSON.stringify({ ...baseCfg, piBin }), "utf8");

      const spawnRes = await h.runTool({
        action: "spawn",
        name: "spaced-rev",
        role: "reviewer",
        model: "custom/model=v1",
        transient: false,
        task: "FINISH_NOW:DONE: spaced bin ok",
      });
      await h.runTool({ action: "wait", name: "spaced-rev" });
      await h.runCommand("stop --all");

      const argv: string[] = JSON.parse(
        await readFile(
          path.join(h.root, ".pi", "fleet", "wt", "spaced-rev", ".rpc-argv.json"),
          "utf8",
        ),
      );
      const hasOption = (flag: string, val: string): boolean => {
        const idx = argv.indexOf(flag);
        return idx >= 0 && argv[idx + 1] === val;
      };

      assert.deepEqual(
        {
          spawnOk: !spawnRes.isError,
          hasModelEq: hasOption("--model", "custom/model=v1"),
          hasToolsComma: hasOption("--tools", "read,grep,find,ls"),
          errors: h.errors(),
        },
        {
          spawnOk: true,
          hasModelEq: true,
          hasToolsComma: true,
          errors: [],
        },
      );
    } finally {
      await h.cleanup();
      await rm(spacedRoot, { recursive: true, force: true });
    }
  });

  it("validates sessionFile and worktree existence on /fleet open", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("no-sess", "stopped");
      await h.runCommand("open no-sess");
      const missingSessionErr = h
        .errors()
        .some((e) => e.includes("no resumable session recorded for 'no-sess'"));

      const gone = await h.seedMember("gone-wt", "stopped");
      const sessionDir = path.join(h.root, ".pi", "fleet", "sessions");
      await mkdir(sessionDir, { recursive: true });
      const sessionFile = path.join(sessionDir, "gone-wt.json");
      await writeFile(sessionFile, "{}\n", "utf8");
      const man = await loadManifest(h.root);
      man.members["gone-wt"].sessionFile = sessionFile;
      await saveManifest(man);

      await git(h.root, "worktree", "remove", "--force", gone.worktree);
      await h.runCommand("open gone-wt");
      const missingWtErr = h
        .errors()
        .some((e) => e.includes("worktree for 'gone-wt' does not exist"));

      assert.deepEqual(
        {
          missingSessionErr,
          missingWtErr,
        },
        {
          missingSessionErr: true,
          missingWtErr: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("reports actual git error on non-conflict merge failure and rejects flag injection in headRev", async () => {
    const h = await createHarness();
    try {
      const m1 = await h.seedMember("dirty-merge", "done");
      await writeFile(path.join(m1.worktree, "README.md"), "branch edit\n", "utf8");
      await git(m1.worktree, "add", "README.md");
      await git(m1.worktree, "commit", "-m", "edit readme on branch");

      await writeFile(path.join(h.root, "README.md"), "dirty supervisor edit\n", "utf8");
      await h.runCommand("merge dirty-merge");
      const mergeErrors = h.errors();

      await assert.rejects(() => headRev(h.root, "--all"), /invalid git ref/);
      const badOverRes = await h.runTool({
        action: "spawn",
        name: "flag-over",
        over: "--all",
        task: "Should reject flag injection",
      });

      assert.deepEqual(
        {
          hasFailedDetail: mergeErrors.some(
            (e) =>
              e.includes("fleet: merge dirty-merge failed:") &&
              !e.includes("CONFLICTS in:") &&
              /local changes|overwritten/i.test(e),
          ),
          badOverRejected: badOverRes.isError && badOverRes.text.includes("invalid git ref"),
        },
        {
          hasFailedDetail: true,
          badOverRejected: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("reports accurate clean --force branch outcomes and tolerates externally deleted branches", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("unmerged-force", "done", { unmergedCommit: true });
      const forceRes = await h.runTool({ action: "clean", name: "unmerged-force", force: true });

      const absent = await h.seedMember("absent-branch", "stopped");
      await git(absent.worktree, "checkout", "--detach");
      await git(h.root, "branch", "-D", "fleet/absent-branch");
      const absentRes = await h.runTool({ action: "clean", name: "absent-branch", force: true });

      assert.deepEqual(
        {
          forceMsg: forceRes.text,
          absentOk: !absentRes.isError,
          absentMsg: absentRes.text,
        },
        {
          forceMsg: "fleet: cleaned 'unmerged-force' (worktree removed, unmerged branch force-deleted)",
          absentOk: true,
          absentMsg: "fleet: cleaned 'absent-branch' (worktree removed, branch already absent)",
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("preserves model CLI flag across resume and clears stale pid before resume startup", async () => {
    const h = await createHarness();
    const sleeper = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      await h.runTool({
        action: "spawn",
        name: "res-model",
        model: "custom/keep-model",
        task: "Initial work",
      });
      await h.runCommand("stop res-model");
      const argvPath = path.join(h.root, ".pi", "fleet", "wt", "res-model", ".rpc-argv.json");
      await rm(argvPath, { force: true });

      await h.runCommand("resume res-model");
      await h.runCommand("stop res-model");
      const resumedArgv: string[] = JSON.parse(await readFile(argvPath, "utf8"));
      const modelIdx = resumedArgv.indexOf("--model");

      await h.seedMember("spawn-fail-pid", "stopped");
      const manSeed = await loadManifest(h.root);
      manSeed.members["spawn-fail-pid"].pid = sleeper.pid;
      await saveManifest(manSeed);

      await h.runCommand("resume spawn-fail-pid");
      const afterFailMan = await loadManifest(h.root);

      assert.deepEqual(
        {
          resumedModelFlag: modelIdx >= 0 ? resumedArgv[modelIdx + 1] : undefined,
          manifestModel: afterFailMan.members["res-model"]?.model,
          stalePidNotKilled: isPidAlive(sleeper.pid),
          failedStatus: afterFailMan.members["spawn-fail-pid"]?.status,
          failedPidCleared: afterFailMan.members["spawn-fail-pid"]?.pid,
        },
        {
          resumedModelFlag: "custom/keep-model",
          manifestModel: "custom/keep-model",
          stalePidNotKilled: true,
          failedStatus: "failed",
          failedPidCleared: undefined,
        },
      );
    } finally {
      try {
        sleeper.kill();
      } catch {
        // already killed
      }
      await h.cleanup();
    }
  });

  it("aborts wait promptly when AbortSignal fires", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "slow-abort",
        task: "Stay running until prompted",
      });

      const preAborted = await h.runTool(
        { action: "wait", name: "slow-abort" },
        AbortSignal.abort(),
      );

      const ac = new AbortController();
      setTimeout(() => ac.abort(), 80);
      const start = Date.now();
      const midAborted = await h.runTool({ action: "wait", name: "slow-abort" }, ac.signal);
      const elapsed = Date.now() - start;

      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          preAborted: preAborted.isError && preAborted.text.includes("wait aborted"),
          midAborted: midAborted.isError && midAborted.text.includes("wait aborted"),
          fastAbort: elapsed < 1_500,
        },
        {
          preAborted: true,
          midAborted: true,
          fastAbort: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("rejects path traversal and fractional counts on log and unknown members on stop", async () => {
    const h = await createHarness();
    try {
      const traversalRes = await h.runTool({ action: "log", name: "../secret" });
      const fracRes = await h.runTool({ action: "log", name: "m1", n: 0.5 });
      const stopUnknownRes = await h.runTool({ action: "stop", name: "unknown-member" });

      assert.throws(() => parseFleetCommand('spawn a "   "'), /usage: \/fleet spawn/);
      assert.throws(() => parseFleetCommand("spawn --model --role coder a task"), /usage: \/fleet spawn/);
      assert.throws(() => parseFleetCommand("spawn --over --transient a task"), /usage: \/fleet spawn/);
      assert.throws(() => parseFleetCommand('send a "   "'), /usage: \/fleet send/);
      assert.throws(() => parseFleetCommand("log a 0.5"), /usage: \/fleet log/);
      assert.throws(() => parseFleetCommand("log a 5 extra"), /usage: \/fleet log/);
      assert.throws(() => toolParamsToCommand({ action: "spawn", name: "   ", task: "ok" }), /spawn requires/);
      assert.throws(() => toolParamsToCommand({ action: "send", name: "a", message: "   " }), /send requires/);

      assert.deepEqual(
        {
          traversalRejected: traversalRes.isError && traversalRes.text.includes("invalid member name"),
          fracRejected: fracRes.isError && fracRes.text.includes("usage: /fleet log"),
          stopUnknownRejected: stopUnknownRes.isError && stopUnknownRes.text.includes("no such member 'unknown-member'"),
        },
        {
          traversalRejected: true,
          fracRejected: true,
          stopUnknownRejected: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("clears pid when an attached done member exits naturally and steers busy members on send", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "done-exit",
        task: "DONE_AND_EXIT:60:DONE: finished cleanly",
      });
      await h.runTool({ action: "wait", name: "done-exit" });
      await new Promise((r) => setTimeout(r, 150));
      const manAfterExit = await loadManifest(h.root);

      await h.runTool({
        action: "spawn",
        name: "busy-steer",
        task: "BUSY_NOW",
      });
      await new Promise((r) => setTimeout(r, 80));
      const steerRes = await h.runTool({
        action: "send",
        name: "busy-steer",
        message: "Adjust plan",
      });
      await h.runCommand("stop --all");

      assert.deepEqual(
        {
          doneStatus: manAfterExit.members["done-exit"]?.status,
          donePid: manAfterExit.members["done-exit"]?.pid,
          steerText: steerRes.text,
        },
        {
          doneStatus: "done",
          donePid: undefined,
          steerText: "fleet: sent to 'busy-steer' (steer)",
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("renders status glyphs for stopped, detached, stale, and merged members while keeping '·' for non-live done", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("g-stopped", "stopped", { createdAt: 1 });
      await h.seedMember("g-detached", "detached", { createdAt: 2 });
      await h.seedMember("g-stale", "stale", { createdAt: 3 });
      await h.seedMember("g-merged", "merged", { createdAt: 4 });
      await h.seedMember("g-done", "done", { createdAt: 5 });

      const statusRes = await h.runTool({ action: "status" });
      const lines = statusRes.text.split("\n");

      assert.deepEqual(
        {
          stopped: lines.some((l) => l.startsWith(" ■ g-stopped ")),
          detached: lines.some((l) => l.startsWith(" △ g-detached ")),
          stale: lines.some((l) => l.startsWith(" ✗ g-stale ")),
          merged: lines.some((l) => l.startsWith(" ✔ g-merged ")),
          doneNonLive: lines.some((l) => l.startsWith(" · g-done ")),
        },
        {
          stopped: true,
          detached: true,
          stale: true,
          merged: true,
          doneNonLive: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("uses dynamic backtick fence in review-context.md and preserves diff --stat leading alignment", async () => {
    const h = await createHarness();
    try {
      const m = await h.seedMember("fence-src", "done");
      await writeFile(
        path.join(m.worktree, "doc.md"),
        "example\n```ts\nconst x = 1;\n```\n",
        "utf8",
      );
      await git(m.worktree, "add", "doc.md");
      await git(m.worktree, "commit", "-m", "add fenced doc");

      const rawDiff = await diffForReview(h.root, m.baseRef, m.branch);
      await h.runTool({
        action: "spawn",
        name: "rev-fence",
        role: "reviewer",
        over: m.branch,
        transient: false,
        task: "Check fenced diff",
      });
      await h.runCommand("stop --all");

      const ctx = await readFile(
        path.join(h.root, ".pi", "fleet", "wt", "rev-fence", ".pi", "fleet", "review-context.md"),
        "utf8",
      );

      assert.deepEqual(
        {
          statLeadingSpace: rawDiff.startsWith(" doc.md "),
          usesFourBacktickFence: ctx.includes("````diff\n") && ctx.includes("\n````\n"),
        },
        {
          statLeadingSpace: true,
          usesFourBacktickFence: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("reconciles unattached active members into stale (dead pid) and detached (live pid)", async () => {
    const h = await createHarness();
    const sleeper = spawnChild(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc", "--name", "fleet:rec-live"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      await h.seedMember("rec-dead", "running");
      await h.seedMember("rec-live", "idle");
      const man = await loadManifest(h.root);
      const sleeperInfo = await getProcessInfo(sleeper.pid!);
      assert.equal(sleeperInfo.status, "ok");
      man.members["rec-live"].pid = sleeper.pid;
      man.members["rec-live"].pidStartedAt = sleeperInfo.info.startedAt;
      await saveManifest(man);

      await h.reconcileSession();
      const after = await loadManifest(h.root);

      assert.deepEqual(
        {
          deadStatus: after.members["rec-dead"]?.status,
          liveStatus: after.members["rec-live"]?.status,
          warnedDead: h.notifications.some(
            (n) => n.level === "warn" && n.text.includes("'rec-dead' is stale"),
          ),
          warnedLive: h.notifications.some(
            (n) => n.level === "warn" && n.text.includes("'rec-live' is detached"),
          ),
        },
        {
          deadStatus: "stale",
          liveStatus: "detached",
          warnedDead: true,
          warnedLive: true,
        },
      );
    } finally {
      try {
        sleeper.kill();
      } catch {
        // already killed
      }
      await h.cleanup();
    }
  });

  it("transitions running members to idle on agent_settled", async () => {
    const h = await createHarness();
    try {
      await h.runTool({
        action: "spawn",
        name: "settle-test",
        task: "SETTLED_NOW",
      });
      await new Promise((r) => setTimeout(r, 120));
      const man = await loadManifest(h.root);
      await h.runCommand("stop --all");

      assert.equal(man.members["settle-test"]?.status, "idle");
    } finally {
      await h.cleanup();
    }
  });

  it("sets isError on single-member merge conflict and emits single notifications for status, log, and wait", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("conf", "done", { conflictingCommit: true });
      const mergeToolRes = await h.runTool({ action: "merge", name: "conf" });

      await h.seedMember("s1", "done", { unmergedCommit: true });
      const logPath = path.join(h.root, ".pi", "fleet", "logs", "s1.jsonl");
      await mkdir(path.dirname(logPath), { recursive: true });
      await writeFile(
        logPath,
        [
          JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
          JSON.stringify({ type: "message_end", message: { role: "assistant", content: "DONE: ok" } }),
        ].join("\n") + "\n",
        "utf8",
      );

      h.notifications.length = 0;
      await h.runCommand("status");
      await h.runCommand("log s1 5");
      await h.runCommand("wait");

      assert.deepEqual(
        {
          mergeIsError: mergeToolRes.isError,
          mergeHasConflict: mergeToolRes.text.includes("CONFLICTS in: README.md"),
          notificationCount: h.notifications.length,
          statusHasTwoMembers: h.notifications[0]?.text.includes("s1") && h.notifications[0]?.text.includes("conf"),
          logHasBothLines: h.notifications[1]?.text.includes("tool: read") && h.notifications[1]?.text.includes("DONE: ok"),
          waitHasBothMembers: h.notifications[2]?.text.includes("s1") && h.notifications[2]?.text.includes("conf"),
        },
        {
          mergeIsError: true,
          mergeHasConflict: true,
          notificationCount: 3,
          statusHasTwoMembers: true,
          logHasBothLines: true,
          waitHasBothMembers: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("does not match a member named 'main' when spawning a reviewer with --over main", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("main", "done", { unmergedCommit: true });
      await writeFile(path.join(h.root, "main-advance.txt"), "advanced main\n", "utf8");
      await git(h.root, "add", "main-advance.txt");
      await git(h.root, "commit", "-m", "advance main branch");

      await h.runTool({
        action: "spawn",
        name: "rev-main",
        role: "reviewer",
        over: "main",
        transient: false,
        task: "Review main",
      });
      await h.runCommand("stop --all");

      const ctx = await readFile(
        path.join(h.root, ".pi", "fleet", "wt", "rev-main", ".pi", "fleet", "review-context.md"),
        "utf8",
      );

      assert.deepEqual(
        {
          hasTarget: ctx.includes("Target: `main`"),
          hasDiffBaseHead: ctx.includes("Diff base: `HEAD`"),
          excludesAdvanceDiff: !ctx.includes("main-advance.txt"),
        },
        {
          hasTarget: true,
          hasDiffBaseHead: true,
          excludesAdvanceDiff: true,
        },
      );
    } finally {
      await h.cleanup();
    }
  });

  it("reads the bounded tail chunk of logs larger than 2 MiB", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("big-log", "done");
      const logPath = path.join(h.root, ".pi", "fleet", "logs", "big-log.jsonl");
      await mkdir(path.dirname(logPath), { recursive: true });
      const fillerLine = `${JSON.stringify({ type: "tool_execution_start", toolName: "bash-filler-0123456789" })}\n`;
      const repeatCount = Math.ceil((2.2 * 1024 * 1024) / fillerLine.length);
      const payload =
        fillerLine.repeat(repeatCount) +
        `${JSON.stringify({ type: "tool_execution_start", toolName: "tail-marker" })}\n` +
        `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "DONE: big log tail" } })}\n`;
      await writeFile(logPath, payload, "utf8");

      const logRes = await h.runTool({ action: "log", name: "big-log", n: 2 });

      assert.deepEqual(
        {
          ok: !logRes.isError,
          hasMarker: logRes.text.includes("tool: tail-marker"),
          hasDone: logRes.text.includes("assistant: DONE: big log tail"),
          lineCount: logRes.text.split("\n").length,
        },
        {
          ok: true,
          hasMarker: true,
          hasDone: true,
          lineCount: 2,
        },
      );
    } finally {
      await h.cleanup();
    }
  });
});

describe("roleAppend", () => {
  it("instructs coder, tester, reviewer, and integrator when to emit DONE: versus FAILED:", () => {
    const coder = roleAppend("coder");
    const tester = roleAppend("tester");
    const reviewer = roleAppend("reviewer");
    const integrator = roleAppend("integrator");

    assert.deepEqual(
      {
        coderHasDoneAndFailed: coder.includes("DONE:") && coder.includes("FAILED:"),
        testerHasDoneAndFailed: tester.includes("DONE:") && tester.includes("FAILED:"),
        reviewerHasDoneAndFailed:
          reviewer.includes("DONE:") && reviewer.includes("FAILED:") && /blocker/i.test(reviewer),
        integratorHasDoneAndFailed: integrator.includes("DONE:") && integrator.includes("FAILED:"),
      },
      {
        coderHasDoneAndFailed: true,
        testerHasDoneAndFailed: true,
        reviewerHasDoneAndFailed: true,
        integratorHasDoneAndFailed: true,
      },
    );
  });
});

describe("winQuote", () => {
  it("quotes whitespace, '=', commas, empty strings, and trailing backslashes while rejecting cmd metacharacters", () => {
    assert.deepEqual(
      {
        safe: winQuote("simple_path/file-1.ts:high"),
        winPath: winQuote("C:\\pi\\pi.cmd"),
        empty: winQuote(""),
        spaced: winQuote("C:\\Program Files\\pi\\pi.cmd"),
        equals: winQuote("custom/model=v1"),
        commas: winQuote("read,grep,find,ls"),
        semicolon: winQuote("a;b"),
        trailingSlash: winQuote("C:\\dir with space\\"),
      },
      {
        safe: "simple_path/file-1.ts:high",
        winPath: "C:\\pi\\pi.cmd",
        empty: '""',
        spaced: '"C:\\Program Files\\pi\\pi.cmd"',
        equals: '"custom/model=v1"',
        commas: '"read,grep,find,ls"',
        semicolon: '"a;b"',
        trailingSlash: '"C:\\dir with space\\\\"',
      },
    );

    for (const bad of ["a&b", "a|b", "a<b", "a>b", "a^b", "%PATH%", "!VAR!", 'say "hi"', "a\rb", "a\nb"]) {
      assert.throws(() => winQuote(bad), /Refusing to pass unsafe argument/);
    }
  });
});

describe("planOpenLaunch", () => {
  it("builds safe launch plans per platform and rejects unsafe Windows paths", () => {
    const winPlan = planOpenLaunch({
      platform: "win32",
      piBin: "C:\\Program Files\\pi\\pi.cmd",
      worktree: "C:\\repo\\wt",
      sessionFile: "C:\\repo\\session file.json",
      env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
    });
    const tmuxPlan = planOpenLaunch({
      platform: "linux",
      piBin: "/custom/bin/pi",
      worktree: "/repo/wt",
      sessionFile: "/repo/session.json",
      env: { TMUX: "/tmp/tmux-1000/default,1,0" },
    });
    const manualPlan = planOpenLaunch({
      platform: "darwin",
      piBin: "/my bin/pi",
      worktree: "/repo/my wt",
      sessionFile: "/repo/it's.json",
      env: {},
    });

    assert.deepEqual(
      {
        winPlan,
        tmuxPlan,
        manualPlan,
      },
      {
        winPlan: {
          kind: "spawn",
          command: "C:\\Windows\\System32\\cmd.exe",
          args: [
            "/d",
            "/c",
            "start",
            '""',
            "cmd.exe",
            "/s",
            "/k",
            '"\"C:\\Program Files\\pi\\pi.cmd\" --session \"C:\\repo\\session file.json\""',
          ],
          windowsVerbatimArguments: true,
          windowsHide: true,
        },
        tmuxPlan: {
          kind: "spawn",
          command: "tmux",
          args: ["new-window", "-c", "/repo/wt", "/custom/bin/pi", "--session", "/repo/session.json"],
        },
        manualPlan: {
          kind: "manual",
          command: "cd '/repo/my wt' && '/my bin/pi' --session '/repo/it'\\''s.json'",
        },
      },
    );

    assert.throws(
      () =>
        planOpenLaunch({
          platform: "win32",
          piBin: "pi",
          worktree: "C:\\repo\\wt",
          sessionFile: "C:\\repo\\a&b.json",
        }),
      /Refusing to pass unsafe argument/,
    );
  });
});

describe("RpcMember", () => {
  it("fails fast in waitReady on spawn error, sets exited, fires onExit once, and closes log on exit", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-rpc-"));
    try {
      const mjsPath = path.join(tmpRoot, "fake-pi.mjs");
      await writeFile(mjsPath, FAKE_PI_SCRIPT, "utf8");
      await chmod(mjsPath, 0o755);
      let piBin = mjsPath;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpRoot, "fake-pi.cmd");
        await writeFile(cmdPath, `@node "%~dp0fake-pi.mjs" %*\r\n`, "utf8");
        piBin = cmdPath;
      }

      const missingCwd = path.join(tmpRoot, "does-not-exist");
      const errLogFile = path.join(tmpRoot, "err.jsonl");
      const failedClient = await RpcMember.create({
        piBin,
        cwd: missingCwd,
        args: [],
        logFile: errLogFile,
      });
      let exitCallbacks = 0;
      failedClient.onExit(() => {
        exitCallbacks++;
      });

      const start = Date.now();
      let readyErr: unknown;
      try {
        await failedClient.waitReady(5_000);
      } catch (err) {
        readyErr = err;
      }
      const elapsedMs = Date.now() - start;
      await new Promise((r) => setTimeout(r, 50));

      let sendErr: unknown;
      try {
        await failedClient.send({ type: "get_state" });
      } catch (err) {
        sendErr = err;
      }

      const exitLogFile = path.join(tmpRoot, "exit.jsonl");
      const shortClient = await RpcMember.create({
        piBin,
        cwd: tmpRoot,
        args: ["--name", "fleet:spawn-fail"],
        logFile: exitLogFile,
      });
      await new Promise<void>((resolve) => {
        shortClient.onExit(() => resolve());
      });
      await rm(exitLogFile);

      assert.deepEqual(
        {
          readyRejected: readyErr instanceof Error && /failed to start|ENOENT/i.test(readyErr.message),
          fastFailure: elapsedMs < 2_000,
          exited: failedClient.exited,
          exitCallbacks,
          sendRejected: sendErr instanceof Error && /exited/i.test(sendErr.message),
          exitLogRemoved: !existsSync(exitLogFile),
        },
        {
          readyRejected: true,
          fastFailure: true,
          exited: true,
          exitCallbacks: 1,
          sendRejected: true,
          exitLogRemoved: true,
        },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("decodes split multi-byte UTF-8 sequences and flushes trailing lines without newline on stdout end", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-utf8-"));
    try {
      const mjsPath = path.join(tmpRoot, "split-utf8.mjs");
      await writeFile(
        mjsPath,
        `#!/usr/bin/env node
const first = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "OK ✓⚙" } }) + "\\n", "utf8");
const splitAt = first.indexOf(0xe2) + 1;
process.stdout.write(first.subarray(0, splitAt));
setTimeout(() => {
  process.stdout.write(first.subarray(splitAt));
  process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: "FINAL_NO_NL" } }));
  process.exit(0);
}, 20);
`,
        "utf8",
      );
      await chmod(mjsPath, 0o755);
      assert.ok((await readFile(mjsPath, "utf8")).startsWith("#!/usr/bin/env node\n"));
      let piBin = mjsPath;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpRoot, "split-utf8.cmd");
        await writeFile(cmdPath, `@node "%~dp0split-utf8.mjs" %*\r\n`, "utf8");
        piBin = cmdPath;
      }

      const logFile = path.join(tmpRoot, "utf8.jsonl");
      const client = await RpcMember.create({
        piBin,
        cwd: tmpRoot,
        args: [],
        logFile,
      });
      const contents: string[] = [];
      client.onEvent((ev) => {
        if (ev.type === "message_end") contents.push(ev.message?.content);
      });
      await new Promise<void>((resolve) => {
        client.onExit(() => resolve());
      });

      assert.deepEqual(contents, ["OK ✓⚙", "FINAL_NO_NL"]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("loadFleetConfig and loadManifest", () => {
  it("warns on malformed/null config values and backs up corrupt manifest while normalizing repoRoot", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-cfg-"));
    try {
      const noCfgWarnings: string[] = [];
      const defaultCfg = await loadFleetConfig(tmpRoot, (w) => noCfgWarnings.push(w));

      await mkdir(path.join(tmpRoot, ".pi", "fleet"), { recursive: true });
      const cfgPath = path.join(tmpRoot, ".pi", "fleet", "config.json");

      await writeFile(cfgPath, "null\n", "utf8");
      const nullWarnings: string[] = [];
      const nullCfg = await loadFleetConfig(tmpRoot, (w) => nullWarnings.push(w));

      await writeFile(cfgPath, "{ bad json", "utf8");
      const syntaxWarnings: string[] = [];
      const syntaxCfg = await loadFleetConfig(tmpRoot, (w) => syntaxWarnings.push(w));

      await writeFile(
        cfgPath,
        JSON.stringify({ maxMembers: 0, defaultRole: "invalid", worktreeRoot: 42 }),
        "utf8",
      );
      const fieldWarnings: string[] = [];
      const fieldCfg = await loadFleetConfig(tmpRoot, (w) => fieldWarnings.push(w));

      const manPath = path.join(tmpRoot, ".pi", "fleet", "manifest.json");
      await writeFile(
        manPath,
        JSON.stringify({ version: 1, repoRoot: "/wrong/root", members: {} }),
        "utf8",
      );
      const normMan = await loadManifest(tmpRoot);

      await writeFile(manPath, "{ corrupt manifest", "utf8");
      const manWarnings: string[] = [];
      const freshMan = await loadManifest(tmpRoot, (w) => manWarnings.push(w));
      const fleetFiles = await readdir(path.join(tmpRoot, ".pi", "fleet"));

      assert.deepEqual(
        {
          noCfgWarnings,
          defaultRole: defaultCfg.defaultRole,
          nullCfgMax: nullCfg.maxMembers,
          nullWarned: nullWarnings.length === 1,
          syntaxWarned: syntaxWarnings.length === 1,
          syntaxCfgMax: syntaxCfg.maxMembers,
          fieldMax: fieldCfg.maxMembers,
          fieldRole: fieldCfg.defaultRole,
          fieldWtRoot: fieldCfg.worktreeRoot,
          fieldWarnCount: fieldWarnings.length,
          normalizedRepoRoot: normMan.repoRoot,
          freshMembers: freshMan.members,
          manWarned: manWarnings.length === 1,
          hasBackupFile: fleetFiles.some((f) => f.startsWith("manifest.json.corrupt.")),
        },
        {
          noCfgWarnings: [],
          defaultRole: "coder",
          nullCfgMax: 6,
          nullWarned: true,
          syntaxWarned: true,
          syntaxCfgMax: 6,
          fieldMax: 6,
          fieldRole: "coder",
          fieldWtRoot: ".pi/fleet/wt",
          fieldWarnCount: 2,
          normalizedRepoRoot: tmpRoot,
          freshMembers: {},
          manWarned: true,
          hasBackupFile: true,
        },
      );
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe("Audit regression tests (F1-F10)", () => {
  it("F1: clean refuses to delete user-created or modified .pi/fleet/review-context.md without --force", async () => {
    const h = await createHarness();
    try {
      // Case 1: Coder worktree with user-created notes at .pi/fleet/review-context.md
      const coder = await h.seedMember("coder-notes", "done");
      const coderNotesFile = path.join(coder.worktree, ".pi", "fleet", "review-context.md");
      await mkdir(path.dirname(coderNotesFile), { recursive: true });
      await writeFile(coderNotesFile, "my private scratch notes\n", "utf8");

      const coderClean = await h.runTool({ action: "clean", name: "coder-notes" });
      assert.equal(coderClean.isError, true);
      assert.equal(existsSync(coderNotesFile), true);
      assert.equal(await readFile(coderNotesFile, "utf8"), "my private scratch notes\n");

      // Case 2: Reviewer whose Fleet-generated review-context.md was later modified by the user
      await h.runTool({
        action: "spawn",
        role: "reviewer",
        transient: false,
        name: "rev-edited",
        task: "DONE: review done",
      });
      await h.runTool({ action: "wait", name: "rev-edited", timeout: 5 });
      await h.runTool({ action: "stop", name: "rev-edited" });

      const man = await loadManifest(h.root);
      const revContext = path.join(man.members["rev-edited"].worktree, ".pi", "fleet", "review-context.md");
      assert.ok(man.members["rev-edited"].reviewContextSha256, "expected generated SHA-256 recorded");
      await writeFile(revContext, "# User edited notes\n", "utf8");

      const revClean = await h.runTool({ action: "clean", name: "rev-edited" });
      assert.equal(revClean.isError, true);
      assert.equal(existsSync(revContext), true);
      assert.equal(await readFile(revContext, "utf8"), "# User edited notes\n");

      // Case 3: Symlink (or non-regular file/directory) at review-context.md must not be followed or deleted.
      const realTarget = path.join(man.members["rev-edited"].worktree, "outside-target.txt");
      const generatedContent = "# Target content\n";
      await writeFile(realTarget, generatedContent, "utf8");
      await rm(revContext, { force: true });
      let testedSymlink = false;
      try {
        await symlink(realTarget, revContext);
        testedSymlink = true;
      } catch (err: any) {
        if (err?.code !== "EPERM" && err?.code !== "EACCES") throw err;
      }
      if (!testedSymlink) {
        // Unprivileged Windows fallback: place a directory at review-context.md.
        await mkdir(revContext, { recursive: true });
        await writeFile(path.join(revContext, "note.txt"), "keep\n", "utf8");
      }
      const nonFileClean = await h.runTool({ action: "clean", name: "rev-edited" });
      assert.equal(nonFileClean.isError, true);
      assert.equal(existsSync(revContext), true);
      assert.equal(existsSync(realTarget), true);
    } finally {
      await h.cleanup();
    }
  });

  it("F2: detached stop/clean refuses to kill unrelated reused PIDs and fails cleanly if a verified process does not exit", async () => {
    const h = await createHarness();
    const unrelated = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const fleetLike = spawnChild(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc", "--name", "fleet:wrong-start"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      // 1. Unrelated process (no fleet CLI identity): stop must NOT kill it; reconcile marks stale.
      const m1 = await h.seedMember("reused-pid", "running");
      const man1 = await loadManifest(h.root);
      man1.members[m1.name].pid = unrelated.pid;
      man1.members[m1.name].pidStartedAt = "2025-01-01T00:00:00.0000000Z";
      await saveManifest(man1);

      await h.reconcileSession();
      const afterReconcile = await loadManifest(h.root);
      assert.equal(afterReconcile.members["reused-pid"]?.status, "stale");
      assert.equal(afterReconcile.members["reused-pid"]?.pid, undefined);
      assert.equal(isPidAlive(unrelated.pid), true, "unrelated process must stay alive on reconcile");

      // Also test direct stop on detached member pointing to unrelated PID.
      const m2 = await h.seedMember("reused-det", "detached");
      const man2 = await loadManifest(h.root);
      man2.members[m2.name].pid = unrelated.pid;
      man2.members[m2.name].pidStartedAt = "2025-01-01T00:00:00.0000000Z";
      await saveManifest(man2);

      const stopRes = await h.runTool({ action: "stop", name: "reused-det" });
      assert.equal(stopRes.isError, false);
      assert.equal(isPidAlive(unrelated.pid), true, "unrelated process must NOT be killed by stop");
      assert.ok(
        h.notifications.some((n) => n.level === "warn" && /refusing to terminate/i.test(n.text)),
        "expected warning when refusing to terminate reused PID",
      );

      // 2. Matching command line but mismatched pidStartedAt -> must NOT kill.
      const m3 = await h.seedMember("wrong-start", "detached");
      const man3 = await loadManifest(h.root);
      man3.members[m3.name].pid = fleetLike.pid;
      man3.members[m3.name].pidStartedAt = "1999-01-01T00:00:00.0000000Z";
      await saveManifest(man3);

      const stopWrongStart = await h.runTool({ action: "stop", name: "wrong-start" });
      assert.equal(stopWrongStart.isError, false);
      assert.equal(isPidAlive(fleetLike.pid), true, "process with mismatched start time must NOT be killed");

      // 3. Verified detached process that refuses to exit -> clean must fail and keep worktree + pid.
      const stubborn = await h.seedMember("stubborn-det", "detached");
      const man4 = await loadManifest(h.root);
      man4.members[stubborn.name].pid = 424242;
      man4.members[stubborn.name].pidStartedAt = "2026-01-01T00:00:00Z";
      await saveManifest(man4);

      const uiNotes: Array<{ text: string; level?: NotifyLevel }> = [];
      const stubbornFleet = new Fleet(
        h.root,
        {
          notify: (text, level) => uiNotes.push({ text, level }),
          setWidget: () => undefined,
        },
        {
          processOps: {
            isAlive: () => true,
            inspectProcess: async () => ({
              status: "ok",
              info: { commandLine: "pi --mode rpc --name fleet:stubborn-det", startedAt: "2026-01-01T00:00:00Z" },
            }),
            terminateProcess: async () => false,
          },
        },
      );
      await assert.rejects(
        () => stubbornFleet.execute({ action: "clean", target: { kind: "member", name: "stubborn-det" } }),
        /still running/i,
      );
      assert.equal(existsSync(stubborn.worktree), true, "worktree must remain if detached process is still alive");
      const afterStubborn = await loadManifest(h.root);
      assert.equal(afterStubborn.members["stubborn-det"]?.pid, 424242);

      // 4. Uninspectable process -> must fail cleanly without killing or deleting worktree.
      const uninspectableFleet = new Fleet(
        h.root,
        {
          notify: () => undefined,
          setWidget: () => undefined,
        },
        {
          processOps: {
            isAlive: () => true,
            inspectProcess: async () => ({ status: "unavailable", reason: "EPERM" }),
            terminateProcess: async () => {
              throw new Error("terminateProcess must not be called when identity is unavailable");
            },
          },
        },
      );
      await assert.rejects(
        () => uninspectableFleet.execute({ action: "clean", target: { kind: "member", name: "stubborn-det" } }),
        /cannot verify process start time and identity/i,
      );
      assert.equal(existsSync(stubborn.worktree), true);

      // Direct unit check on hasFleetCommandIdentity boundary matching.
      assert.equal(hasFleetCommandIdentity("pi --mode rpc --name fleet:alpha", "alpha"), true);
      assert.equal(hasFleetCommandIdentity("pi --mode rpc --name fleet:alpha-2", "alpha"), false);
      assert.equal(hasFleetCommandIdentity("node -e setInterval", "alpha"), false);
      const selfInfo = await getProcessInfo(process.pid);
      assert.equal(selfInfo.status, "ok");
    } finally {
      for (const proc of [unrelated, fleetLike]) {
        try {
          proc.kill();
        } catch {
          // already gone
        }
      }
      await h.cleanup();
    }
  });

  it("F3: send does not mark an exited member running and an older failed send cannot overwrite a newer accepted send", async () => {
    const h = await createHarness();
    try {
      const m = await h.seedMember("send-race", "done", { result: "DONE: initial" });
      const fleet = new Fleet(h.root, {
        notify: () => undefined,
        setWidget: () => undefined,
      });

      // Part A: Client exits while send is between mustClient and status update.
      let rejectPrompt1!: (e: Error) => void;
      const fakeClient1: any = {
        exited: false,
        busy: false,
        prompt: () =>
          new Promise((_res, rej) => {
            rejectPrompt1 = rej;
          }),
        steer: async () => undefined,
        detach: () => undefined,
        kill: async () => undefined,
        abort: async () => undefined,
      };
      (fleet as any).clients.set(m.name, fakeClient1);

      // Overlap: send #1 transitions done -> running (gen 1) and hangs on prompt;
      // send #2 runs while send #1 is in flight (gen 2) and succeeds;
      // then send #1 rejects -> manifest MUST stay running (NOT rolled back to done).
      const send1 = fleet.execute({ action: "send", name: m.name, message: "first" });
      // Wait for send #1 to reach prompt()
      await new Promise((r) => setTimeout(r, 40));

      let prompt2Called = false;
      fakeClient1.prompt = async () => {
        prompt2Called = true;
        return {};
      };
      const send2Res = await fleet.execute({ action: "send", name: m.name, message: "second" });
      assert.equal(prompt2Called, true);
      assert.match(send2Res.messages[0]?.text ?? "", /sent to 'send-race'/);

      rejectPrompt1(new Error("first prompt rejected"));
      await assert.rejects(() => send1, /first prompt rejected/);

      const afterOverlap = await loadManifest(h.root);
      assert.equal(afterOverlap.members[m.name]?.status, "running");
      assert.equal(afterOverlap.members[m.name]?.result, undefined);

      // Part B: Member marked done; client exits right as manifest() resolves before status flip.
      const m2 = await h.seedMember("send-exited", "done", { result: "DONE: done" });
      const fleet2 = new Fleet(h.root, {
        notify: () => undefined,
        setWidget: () => undefined,
      });
      const dyingClient: any = {
        exited: false,
        busy: false,
        prompt: async () => undefined,
        steer: async () => undefined,
        detach: () => undefined,
        kill: async () => undefined,
        abort: async () => undefined,
      };
      (fleet2 as any).clients.set(m2.name, dyingClient);
      const origManifest = (fleet2 as any).manifest.bind(fleet2);
      (fleet2 as any).manifest = async () => {
        const res = await origManifest();
        dyingClient.exited = true;
        return res;
      };

      await assert.rejects(
        () => fleet2.execute({ action: "send", name: m2.name, message: "too late" }),
        /not attached/i,
      );
      const afterExited = await loadManifest(h.root);
      assert.equal(afterExited.members[m2.name]?.status, "done");
      assert.equal(afterExited.members[m2.name]?.result, "DONE: done");
    } finally {
      await h.cleanup();
    }
  });

  it("F4: loadManifest propagates non-ENOENT read errors and fails if corrupt-manifest backup fails", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-f4-"));
    try {
      const fDir = path.join(tmpRoot, ".pi", "fleet");
      const manPath = path.join(fDir, "manifest.json");

      // Non-ENOENT read error (manifest.json is a directory -> EISDIR).
      await mkdir(manPath, { recursive: true });
      await assert.rejects(() => loadManifest(tmpRoot), (err: any) => err?.code === "EISDIR");
      await rm(manPath, { recursive: true, force: true });

      // Corrupt manifest whose backup fails must throw and NOT emit a false backup warning.
      await writeFile(manPath, "{ broken json", "utf8");
      const warnings: string[] = [];
      await assert.rejects(
        () =>
          loadManifest(tmpRoot, (w) => warnings.push(w), {
            copyBackup: async () => {
              throw new Error("ENOSPC: disk full");
            },
          }),
        /backup.*failed.*ENOSPC/i,
      );
      assert.deepEqual(warnings, []);
      assert.equal(await readFile(manPath, "utf8"), "{ broken json");
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("F5: aborting wait during initial syncAsks rejects cleanly with 'wait aborted' instead of ReferenceError", async () => {
    const h = await createHarness();
    try {
      const m = await h.seedMember("abort-early", "running");
      const fleet = new Fleet(h.root, {
        notify: () => undefined,
        setWidget: () => undefined,
      });

      const controller = new AbortController();
      // Abort while initial readAsk() runs during syncAsks() before poll is initialized.
      await writeFile(path.join(m.worktree, "FLEET_ASK.md"), "", "utf8");
      const origReadAsk = (fleet as any).readAsk.bind(fleet);
      (fleet as any).readAsk = async (name: string) => {
        controller.abort();
        return origReadAsk(name);
      };

      await assert.rejects(
        () => fleet.execute({ action: "wait", target: { kind: "members", names: ["abort-early"] } }, controller.signal),
        (err: unknown) => err instanceof Error && err.message === "wait aborted" && !(err instanceof ReferenceError),
      );
    } finally {
      await h.cleanup();
    }
  });

  it("F6: active wait a b retains transient member a's result even after 64+ other completions", async () => {
    const h = await createHarness();
    try {
      await h.seedMember("member-a", "done", { result: "DONE: result from A" });
      await h.seedMember("member-b", "running");
      const fleet = new Fleet(h.root, {
        notify: () => undefined,
        setWidget: () => undefined,
      });

      // Seed member-a as a completed transient snapshot (removed from manifest like transient auto-clean).
      const man = await loadManifest(h.root);
      delete man.members["member-a"];
      await saveManifest(man);
      (fleet as any).completedTransient.set("member-a", {
        createdAt: 1,
        lines: ["member-a [reviewer] status=done branch=fleet/member-a", "  result: DONE: result from A"],
        reported: false,
      });

      const waitPromise = fleet.execute({
        action: "wait",
        target: { kind: "members", names: ["member-a", "member-b"] },
        mode: "all",
        timeout: 5,
      });

      // Wait a tick so waitForMembers has pinned member-a and member-b.
      await new Promise((r) => setTimeout(r, 30));

      // Simulate 70 other transient completions and invoke eviction.
      for (let i = 0; i < 70; i++) {
        (fleet as any).completedTransient.set(`other-${i}`, {
          createdAt: 100 + i,
          lines: [`other-${i} [reviewer] status=done`],
          reported: false,
        });
        (fleet as any).trimCompletedTransient();
      }
      assert.equal((fleet as any).completedTransient.has("member-a"), true, "pinned member-a must not be evicted");

      // Now settle member-b.
      const loaded = await (fleet as any).manifest();
      loaded.members["member-b"].status = "done";
      loaded.members["member-b"].result = "DONE: result from B";
      await (fleet as any).save();

      const res = await waitPromise;
      const text = res.messages.map((msg) => msg.text).join("\n");
      assert.match(text, /DONE: result from A/);
      assert.match(text, /DONE: result from B/);
      assert.ok((fleet as any).completedTransient.size <= 64, "cache trims back to cap after wait ends");
    } finally {
      await h.cleanup();
    }
  });

  it("F7: RpcMember resolves a valid final RPC response without a trailing newline even when process exits immediately", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-f7-"));
    try {
      const mjsPath = path.join(tmpRoot, "no-nl-rpc.mjs");
      await writeFile(
        mjsPath,
        `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  const idx = buf.indexOf("\\n");
  if (idx < 0) return;
  const req = JSON.parse(buf.slice(0, idx).replace(/\\r$/, ""));
  // Write valid JSON response with NO trailing newline and exit immediately.
  process.stdout.write(JSON.stringify({
    type: "response",
    id: req.id,
    command: req.type,
    success: true,
    data: { finalNoNewline: true },
  }), () => {
    process.exit(0);
  });
});
`,
        "utf8",
      );
      await chmod(mjsPath, 0o755);
      let piBin = mjsPath;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpRoot, "no-nl-rpc.cmd");
        await writeFile(cmdPath, `@node "%~dp0no-nl-rpc.mjs" %*\r\n`, "utf8");
        piBin = cmdPath;
      }

      const client = await RpcMember.create({
        piBin,
        cwd: tmpRoot,
        args: [],
        logFile: path.join(tmpRoot, "rpc.jsonl"),
      });
      const response = await client.getState();
      assert.deepEqual(response, { finalNoNewline: true });

      // Grandchild inheriting stdout after member exits must still reject pending RPC promptly.
      const childMjs = path.join(tmpRoot, "grandchild-stdout.mjs");
      const grandchildPidFile = path.join(tmpRoot, "grandchild.pid");
      await writeFile(
        childMjs,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
process.stdin.once("data", () => {
  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    cwd: tmpdir(),
    stdio: ["ignore", "inherit", "ignore"],
    detached: true,
    windowsHide: true,
  });
  writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid), "utf8");
  gc.unref();
  process.exit(0);
});
`,
        "utf8",
      );
      await chmod(childMjs, 0o755);
      let gcBin = childMjs;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpRoot, "grandchild-stdout.cmd");
        await writeFile(cmdPath, `@node "%~dp0grandchild-stdout.mjs" %*\r\n`, "utf8");
        gcBin = cmdPath;
      }
      const gcClient = await RpcMember.create({
        piBin: gcBin,
        cwd: tmpRoot,
        args: [],
        logFile: path.join(tmpRoot, "gc-rpc.jsonl"),
      });
      try {
        const started = Date.now();
        await assert.rejects(() => gcClient.getState(), /member process exited/i);
        assert.ok(Date.now() - started < 3_000, "pending RPC must reject promptly via drain timer");
      } finally {
        gcClient.detach();
        if (existsSync(grandchildPidFile)) {
          const gcPid = Number((await readFile(grandchildPidFile, "utf8")).trim());
          if (gcPid > 0) {
            try {
              process.kill(gcPid);
            } catch {
              // already exited
            }
          }
        }
      }
    } finally {
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("F8: readLogTailEntries scans sparse logs backward in bounded chunks across multi-byte UTF-8 boundaries", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-f8-"));
    try {
      const logFile = path.join(tmpRoot, "sparse.jsonl");
      const filler = JSON.stringify({ type: "agent_heartbeat", pad: "x".repeat(400) }) + "\n";
      const lines: string[] = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: "EARLY_1 ✓⚙🌱" } }) + "\n",
        JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\n",
        filler.repeat(40),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: "MID_2 ✓⚙🌱" } }) + "\n",
        filler.repeat(40),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: "DONE: FINAL_3 ✓⚙🌱" } }),
      ];
      await writeFile(logFile, lines.join(""), "utf8");

      // Use a tiny chunk size (137 bytes — prime, guaranteed to split mid-line and mid-UTF-8!)
      const res = await readLogTailEntries(logFile, 4, 137);
      assert.deepEqual(res.items, [
        { kind: "assistant", text: "EARLY_1 ✓⚙🌱" },
        { kind: "tool", toolName: "read" },
        { kind: "assistant", text: "MID_2 ✓⚙🌱" },
        { kind: "assistant", text: "DONE: FINAL_3 ✓⚙🌱" },
      ]);
      assert.equal(res.lastResultIdx, 3);

      // Requesting only last 2 entries stops early without needing earlier entries.
      const res2 = await readLogTailEntries(logFile, 2, 137);
      assert.deepEqual(res2.items, [
        { kind: "assistant", text: "MID_2 ✓⚙🌱" },
        { kind: "assistant", text: "DONE: FINAL_3 ✓⚙🌱" },
      ]);
      assert.equal(res2.lastResultIdx, 1);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("F9: validates nested manifest members and config role fields without truthy coercion on autoClean='false'", async () => {
    const h = await createHarness();
    try {
      // 1. Null member in manifest.json -> backed up, warned, and /fleet status does not crash.
      const manPath = path.join(h.root, ".pi", "fleet", "manifest.json");
      await mkdir(path.dirname(manPath), { recursive: true });
      await writeFile(
        manPath,
        JSON.stringify({ version: 1, repoRoot: h.root, members: { broken: null } }),
        "utf8",
      );
      const statusRes = await h.runTool({ action: "status" });
      assert.equal(statusRes.isError, false);
      assert.match(statusRes.text, /no members/i);
      const fleetFiles = await readdir(path.join(h.root, ".pi", "fleet"));
      assert.ok(fleetFiles.some((f) => f.startsWith("manifest.json.corrupt.")));

      // 1b. Prototype-polluting "__proto__" key with otherwise valid member shape must be rejected as corrupt.
      const protoMember = {
        name: "__proto__",
        role: "coder",
        task: "pollute",
        branch: "fleet/proto",
        worktree: h.root,
        baseRef: "HEAD",
        status: "done",
        createdAt: 1,
        updatedAt: 1,
      };
      await writeFile(
        manPath,
        `{"version":1,"repoRoot":${JSON.stringify(h.root)},"members":{"__proto__":${JSON.stringify(protoMember)}}}`,
        "utf8",
      );
      const protoWarnings: string[] = [];
      const recovered = await loadManifest(h.root, (w) => protoWarnings.push(w));
      assert.deepEqual(recovered.members, {});
      assert.equal(Object.getPrototypeOf(recovered.members), Object.prototype);
      assert.equal(protoWarnings.length, 1);

      // 2. Role configured with autoClean: "false" (truthy string) must NOT enable autoClean.
      const cfgPath = path.join(h.root, ".pi", "fleet", "config.json");
      const existingCfg = JSON.parse(await readFile(cfgPath, "utf8"));
      await writeFile(
        cfgPath,
        JSON.stringify({
          ...existingCfg,
          roles: {
            coder: { autoClean: "false", thinking: "bogus", model: 123 },
            reviewer: { autoClean: "false" },
            unknownRole: { autoClean: true },
          },
        }),
        "utf8",
      );
      const cfgWarnings: string[] = [];
      const cfg = await loadFleetConfig(h.root, (w) => cfgWarnings.push(w));
      assert.equal(resolveRoleSpec(cfg, "coder").autoClean, undefined);
      assert.equal(resolveRoleSpec(cfg, "coder").thinking, undefined);
      assert.equal(resolveRoleSpec(cfg, "coder").model, undefined);
      assert.equal(resolveRoleSpec(cfg, "reviewer").autoClean, true); // built-in default preserved when override invalid
      assert.ok(cfgWarnings.some((w) => /roles\.coder\.autoClean must be a boolean/i.test(w)));
      assert.ok(cfgWarnings.some((w) => /roles\.unknownRole is not a known role/i.test(w)));
    } finally {
      await h.cleanup();
    }
  });

  it("P1: rejects reserved prototype member names before creating worktrees and uses own-key lookups", async () => {
    const h = await createHarness();
    try {
      for (const badName of ["prototype", "constructor", "__proto__"]) {
        const res = await h.runTool({ action: "spawn", name: badName, task: "DONE: bad" });
        assert.equal(res.isError, true, `spawn '${badName}' must fail`);
        assert.match(res.text, /invalid member name/i);
        assert.equal(
          existsSync(path.join(h.root, ".pi", "fleet", "wt", badName)),
          false,
          `worktree must not be created for '${badName}'`,
        );
      }

      // Prototype property names must never resolve as existing members on lookup commands.
      for (const action of ["stop", "clean", "resume", "send", "merge", "open"] as const) {
        const params: Record<string, unknown> =
          action === "send"
            ? { action, name: "toString", message: "hi" }
            : { action, name: "constructor" };
        const res = await h.runTool(params);
        assert.equal(res.isError, true, `${action} on prototype key must fail`);
      }

      // Valid spawn -> reload manifest round-trip preserves members cleanly with zero warnings.
      const okSpawn = await h.runTool({ action: "spawn", name: "valid-one", task: "DONE: all good" });
      assert.equal(okSpawn.isError, false);
      await h.runTool({ action: "wait", name: "valid-one", timeout: 5 });
      await h.runTool({ action: "stop", name: "valid-one" });

      const reloadWarnings: string[] = [];
      const reloaded = await loadManifest(h.root, (w) => reloadWarnings.push(w));
      assert.deepEqual(reloadWarnings, []);
      assert.ok(Object.hasOwn(reloaded.members, "valid-one"));
    } finally {
      await h.cleanup();
    }
  });

  it("P2: detached stop and clean refuse termination when pidStartedAt is missing even if command line matches", async () => {
    const h = await createHarness();
    const sleeper = spawnChild(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--mode", "rpc", "--name", "fleet:missing-start"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    try {
      const m = await h.seedMember("missing-start", "detached");
      const man = await loadManifest(h.root);
      man.members[m.name].pid = sleeper.pid;
      man.members[m.name].pidStartedAt = undefined;
      await saveManifest(man);

      const stopRes = await h.runTool({ action: "stop", name: "missing-start" });
      assert.equal(stopRes.isError, true);
      assert.match(stopRes.text, /start time/i);
      assert.equal(isPidAlive(sleeper.pid), true, "process without pidStartedAt must NOT be killed");

      const cleanRes = await h.runTool({ action: "clean", name: "missing-start" });
      assert.equal(cleanRes.isError, true);
      assert.match(cleanRes.text, /start time/i);
      assert.equal(isPidAlive(sleeper.pid), true, "clean must NOT kill process without pidStartedAt");
      assert.equal(existsSync(m.worktree), true, "worktree must remain intact when termination is refused");

      const after = await loadManifest(h.root);
      assert.equal(after.members["missing-start"]?.pid, sleeper.pid);
      assert.equal(after.members["missing-start"]?.status, "detached");
    } finally {
      try {
        sleeper.kill();
      } catch {
        // already exited
      }
      await h.cleanup();
    }
  });

  it("P3: finalizes exited member after bounded drain even with inherited stdout/stderr and zero pending RPCs", async () => {
    const h = await createHarness();
    const tmpBin = await mkdtemp(path.join(tmpdir(), "pi-fleet-p3-"));
    const grandchildPidFile = path.join(tmpBin, "grandchild.pid");
    try {
      const mjsPath = path.join(tmpBin, "gc-exit.mjs");
      await writeFile(
        mjsPath,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "get_state") {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: msg.id,
        command: "get_state",
        success: true,
        data: { isStreaming: false },
      }) + "\\n");
    } else if (msg.type === "prompt") {
      // Respond to prompt (so ZERO pending RPCs remain), spawn detached grandchild
      // inheriting BOTH stdout and stderr, and exit immediately.
      process.stdout.write(JSON.stringify({
        type: "response",
        id: msg.id,
        command: "prompt",
        success: true,
        data: {},
      }) + "\\n");
      const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
        cwd: tmpdir(),
        stdio: ["ignore", "inherit", "inherit"],
        detached: true,
        windowsHide: true,
      });
      writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid), "utf8");
      gc.unref();
      setTimeout(() => process.exit(1), 40);
    }
  }
});
`,
        "utf8",
      );
      await chmod(mjsPath, 0o755);
      let piBin = mjsPath;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpBin, "gc-exit.cmd");
        await writeFile(cmdPath, `@node "%~dp0gc-exit.mjs" %*\r\n`, "utf8");
        piBin = cmdPath;
      }

      const cfgPath = path.join(h.root, ".pi", "fleet", "config.json");
      const existingCfg = JSON.parse(await readFile(cfgPath, "utf8"));
      await writeFile(cfgPath, JSON.stringify({ ...existingCfg, piBin }), "utf8");

      const fleet = new Fleet(h.root, {
        notify: () => undefined,
        setWidget: () => undefined,
      });
      await fleet.execute({ action: "spawn", name: "gc-member", task: "trigger grandchild" });

      const started = Date.now();
      const waitRes = await fleet.execute({
        action: "wait",
        target: { kind: "members", names: ["gc-member"] },
        mode: "all",
        timeout: 5,
      });
      const elapsed = Date.now() - started;
      const waitText = waitRes.messages.map((m) => m.text).join("\n");
      assert.doesNotMatch(waitText, /timed out/i);
      assert.match(waitText, /status=failed/);
      assert.ok(elapsed < 4_000, `wait must resolve promptly via exit drain timer (took ${elapsed}ms)`);

      const after = await loadManifest(h.root);
      assert.equal(after.members["gc-member"]?.status, "failed");
      assert.equal(after.members["gc-member"]?.pid, undefined);
      assert.equal(after.members["gc-member"]?.pidStartedAt, undefined);

      // Verify log stream was closed by removing the log file cleanly (Windows fails if open).
      const logFile = path.join(h.root, ".pi", "fleet", "logs", "gc-member.jsonl");
      if (existsSync(logFile)) {
        await rm(logFile, { force: true, maxRetries: 5, retryDelay: 30 });
        assert.equal(existsSync(logFile), false);
      }
    } finally {
      if (existsSync(grandchildPidFile)) {
        const gcPid = Number((await readFile(grandchildPidFile, "utf8")).trim());
        if (gcPid > 0) {
          try {
            process.kill(gcPid);
          } catch {
            // already exited
          }
        }
      }
      await rm(tmpBin, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      await h.cleanup();
    }
  });

  it("P4: readLogTailEntries bounds per-line retention on oversized and unfinished lines while preserving valid neighbors", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-p4-"));
    try {
      const logFile = path.join(tmpRoot, "oversized.jsonl");
      const cap = 512;
      assert.ok(MAX_LOG_LINE_BYTES >= 64 * 1024);
      const hugeValid = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: "HUGE_" + "A".repeat(cap * 4) },
      });
      const hugeUnfinished = '{"type":"message_end","pad":"' + "B".repeat(cap * 4);
      const content = [
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: "BEFORE_HUGE ✓" } }),
        hugeValid,
        JSON.stringify({ type: "tool_execution_start", toolName: "bash" }),
        JSON.stringify({ type: "message_end", message: { role: "assistant", content: "DONE: AFTER_HUGE ⚙" } }),
        hugeUnfinished, // no trailing newline and exceeds cap
      ].join("\n");
      await writeFile(logFile, content, "utf8");

      const res = await readLogTailEntries(logFile, 5, 97, cap);
      assert.deepEqual(res.items, [
        { kind: "assistant", text: "BEFORE_HUGE ✓" },
        { kind: "omitted", maxBytes: cap },
        { kind: "tool", toolName: "bash" },
        { kind: "assistant", text: "DONE: AFTER_HUGE ⚙" },
        { kind: "omitted", maxBytes: cap },
      ]);
      assert.equal(res.lastResultIdx, 3);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("P6: loadManifest preserves valid members when dropping legacy reserved, null, or __proto__ entries after backup", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-p6-"));
    try {
      const fDir = path.join(tmpRoot, ".pi", "fleet");
      const manPath = path.join(fDir, "manifest.json");
      await mkdir(fDir, { recursive: true });

      const makeMember = (name: string) => ({
        name,
        role: "coder",
        task: `task for ${name}`,
        branch: `fleet/${name}`,
        worktree: path.join(tmpRoot, ".pi", "fleet", "wt", name),
        baseRef: "HEAD",
        status: "done",
        createdAt: 1,
        updatedAt: 2,
      });

      // 1. Legacy 'prototype' member alongside valid 'coder-a' -> backs up, warns, preserves 'coder-a'.
      await writeFile(
        manPath,
        JSON.stringify({
          version: 1,
          repoRoot: tmpRoot,
          members: { prototype: makeMember("prototype"), "coder-a": makeMember("coder-a") },
        }),
        "utf8",
      );
      const legacyWarnings: string[] = [];
      const legacyLoaded = await loadManifest(tmpRoot, (w) => legacyWarnings.push(w));
      assert.deepEqual(Object.keys(legacyLoaded.members), ["coder-a"]);
      assert.equal(legacyLoaded.members["coder-a"]?.task, "task for coder-a");
      assert.equal(legacyWarnings.length, 1);
      assert.match(legacyWarnings[0], /prototype/);
      assert.match(legacyWarnings[0], /manifest\.json\.corrupt\./);

      // 2. Null member alongside valid 'coder-b' -> preserves 'coder-b', and fails if backup fails (F4).
      await writeFile(
        manPath,
        JSON.stringify({
          version: 1,
          repoRoot: tmpRoot,
          members: { broken: null, "coder-b": makeMember("coder-b") },
        }),
        "utf8",
      );
      const nullBackupWarnings: string[] = [];
      await assert.rejects(
        () =>
          loadManifest(tmpRoot, (w) => nullBackupWarnings.push(w), {
            copyBackup: async () => {
              throw new Error("EACCES: backup denied");
            },
          }),
        /backup.*failed.*EACCES/i,
      );
      assert.deepEqual(nullBackupWarnings, []);

      const nullWarnings: string[] = [];
      const nullLoaded = await loadManifest(tmpRoot, (w) => nullWarnings.push(w));
      assert.deepEqual(Object.keys(nullLoaded.members), ["coder-b"]);
      assert.equal(nullWarnings.length, 1);
      assert.match(nullWarnings[0], /broken/);

      // 3. Raw JSON '__proto__' own property alongside valid 'coder-c' -> no prototype pollution, preserves 'coder-c'.
      const rawProtoJson = `{"version":1,"repoRoot":${JSON.stringify(tmpRoot)},"members":{"__proto__":${JSON.stringify(makeMember("__proto__"))},"coder-c":${JSON.stringify(makeMember("coder-c"))}}}`;
      await writeFile(manPath, rawProtoJson, "utf8");
      const protoWarnings: string[] = [];
      const protoLoaded = await loadManifest(tmpRoot, (w) => protoWarnings.push(w));
      assert.equal(Object.getPrototypeOf(protoLoaded.members), Object.prototype);
      assert.deepEqual(Object.keys(protoLoaded.members), ["coder-c"]);
      assert.equal(protoWarnings.length, 1);
      assert.match(protoWarnings[0], /__proto__/);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("P7: detach rejects in-flight RPC calls promptly and still finalizes exit when exit already began", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-p7-"));
    const grandchildPidFile = path.join(tmpRoot, "grandchild.pid");
    try {
      // Fixture 1: answers get_state, hangs on prompt so detach() runs mid-flight.
      const hangMjs = path.join(tmpRoot, "hang-prompt.mjs");
      await writeFile(
        hangMjs,
        `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx).replace(/\\r$/, "");
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === "get_state") {
      process.stdout.write(JSON.stringify({
        type: "response",
        id: req.id,
        command: "get_state",
        success: true,
        data: { ok: true },
      }) + "\\n");
    }
    // Intentionally never respond to 'prompt' while staying alive.
  }
});
setInterval(() => {}, 1000);
`,
        "utf8",
      );
      await chmod(hangMjs, 0o755);
      let hangBin = hangMjs;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpRoot, "hang-prompt.cmd");
        await writeFile(cmdPath, `@node "%~dp0hang-prompt.mjs" %*\r\n`, "utf8");
        hangBin = cmdPath;
      }

      const client = await RpcMember.create({
        piBin: hangBin,
        cwd: tmpRoot,
        args: [],
        logFile: path.join(tmpRoot, "hang.jsonl"),
      });
      try {
        // Attached RPC call resolves normally.
        assert.deepEqual(await client.getState(), { ok: true });

        // Start an in-flight prompt (60s timeout) and detach immediately -> must reject promptly.
        const started = Date.now();
        const inFlight = client.prompt("never answered");
        await new Promise((r) => setTimeout(r, 20));
        client.detach();
        await assert.rejects(() => inFlight, /member detached/i);
        assert.ok(Date.now() - started < 2_000, "detach must reject in-flight RPC promptly");
        await assert.rejects(() => client.getState(), /member detached/i);
      } finally {
        await client.kill();
      }

      // Fixture 2: spawns detached grandchild inheriting stdout and exits; calling detach()
      // while exit drain timer is pending must still complete bounded exit finalization.
      const exitGcMjs = path.join(tmpRoot, "exit-gc.mjs");
      await writeFile(
        exitGcMjs,
        `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
process.stdin.once("data", () => {
  const gc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    cwd: tmpdir(),
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
    windowsHide: true,
  });
  writeFileSync(${JSON.stringify(grandchildPidFile)}, String(gc.pid), "utf8");
  gc.unref();
  process.exit(0);
});
`,
        "utf8",
      );
      await chmod(exitGcMjs, 0o755);
      let exitGcBin = exitGcMjs;
      if (process.platform === "win32") {
        const cmdPath = path.join(tmpRoot, "exit-gc.cmd");
        await writeFile(cmdPath, `@node "%~dp0exit-gc.mjs" %*\r\n`, "utf8");
        exitGcBin = cmdPath;
      }

      const exitLogFile = path.join(tmpRoot, "exit-gc.jsonl");
      const gcClient = await RpcMember.create({
        piBin: exitGcBin,
        cwd: tmpRoot,
        args: [],
        logFile: exitLogFile,
      });
      let exitCalls = 0;
      gcClient.onExit(() => {
        exitCalls += 1;
      });
      const pendingCall = gcClient.getState();
      // Wait for child 'exit' event to fire (before the 250ms drain timer completes).
      const waitDeadline = Date.now() + 3_000;
      while (!gcClient.exited && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(gcClient.exited, true);
      gcClient.detach();
      await assert.rejects(() => pendingCall, /member process exited/i);
      assert.equal(exitCalls, 1, "detach after exit must complete exit finalization once");
    } finally {
      if (existsSync(grandchildPidFile)) {
        const gcPid = Number((await readFile(grandchildPidFile, "utf8")).trim());
        if (gcPid > 0) {
          try {
            process.kill(gcPid);
          } catch {
            // already exited
          }
        }
      }
      await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("P8: exact maxLineBytes CRLF record produces identical results across 17-byte and 4096-byte chunks", async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "pi-fleet-p8-"));
    try {
      const logFile = path.join(tmpRoot, "exact-crlf.jsonl");
      const cap = 256;
      const prefix = '{"type":"message_end","message":{"role":"assistant","content":"';
      const suffix = '"}}';
      const padLen = cap - Buffer.byteLength(prefix, "utf8") - Buffer.byteLength(suffix, "utf8");
      const exactLine = `${prefix}${"Z".repeat(padLen)}${suffix}`;
      assert.equal(Buffer.byteLength(exactLine, "utf8"), cap);

      const overLine = `${prefix}${"Y".repeat(padLen + 1)}${suffix}`;
      assert.equal(Buffer.byteLength(overLine, "utf8"), cap + 1);

      // Write both exact-cap and cap+1 records with CRLF endings.
      const raw = `${exactLine}\r\n${overLine}\r\n${exactLine}\r\n`;
      await writeFile(logFile, raw, "utf8");

      const largeChunk = await readLogTailEntries(logFile, 5, 4096, cap);
      const tinyChunk = await readLogTailEntries(logFile, 5, 17, cap);

      assert.deepEqual(tinyChunk, largeChunk);
      assert.deepEqual(largeChunk.items, [
        { kind: "assistant", text: "Z".repeat(padLen) },
        { kind: "omitted", maxBytes: cap },
        { kind: "assistant", text: "Z".repeat(padLen) },
      ]);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("P9: production defaults (2 MiB chunk, 256 KiB cap) visibly report an omitted oversized final log record in /fleet log", async () => {
    const h = await createHarness();
    try {
      const logDir = path.join(h.root, ".pi", "fleet", "logs");
      await mkdir(logDir, { recursive: true });
      const logFile = path.join(logDir, "big-done.jsonl");

      const earlier = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: "Working on task" },
      });
      const oversizedDone = JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: "DONE: " + "X".repeat(MAX_LOG_LINE_BYTES + 1024) },
      });
      await writeFile(logFile, `${earlier}\n${oversizedDone}\n`, "utf8");

      const parsed = await readLogTailEntries(logFile, 5);
      assert.deepEqual(parsed.items, [
        { kind: "assistant", text: "Working on task" },
        { kind: "omitted", maxBytes: MAX_LOG_LINE_BYTES },
      ]);

      const logRes = await h.runTool({ action: "log", name: "big-done", n: 5 });
      assert.equal(logRes.isError, false);
      assert.match(logRes.text, /assistant: Working on task/);
      assert.match(logRes.text, /\[omitted oversized log record \(>256 KiB\)\]/);
    } finally {
      await h.cleanup();
    }
  });
});
