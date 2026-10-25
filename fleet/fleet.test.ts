import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseFleetCommand, toolParamsToCommand } from "./fleet.ts";
import { addWorktree, branchExists, git, headRev, mergeBranch } from "./gitw.ts";
import registerFleet from "./index.ts";
import { isPidAlive, loadManifest, saveManifest } from "./manifest.ts";
import { roleAppend } from "./roles.ts";
import type { Member, MemberStatus, NotifyLevel } from "./types.ts";

const FAKE_PI_SCRIPT = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

if (process.argv.some((a) => a.startsWith("fleet:spawn-fail"))) {
  process.exit(0);
}

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
  runTool: (params: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>;
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
  shutdown: () => Promise<void>;
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
    ".rpc-received.jsonl\nsession.json\n",
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
    runTool: async (params: Record<string, unknown>) => {
      assert.ok(toolExecutor);
      const res = await toolExecutor("call-1", params, undefined, undefined, ctx);
      return {
        text: res.content.map((c: any) => c.text).join("\n"),
        isError: !!res.isError,
      };
    },
    seedMember,
    shutdown: async () => {
      for (const fn of shutdownHandlers) await fn();
    },
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
    const sleeper = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    try {
      const m = await h.seedMember("ghost", "detached");
      const man = await loadManifest(h.root);
      man.members[m.name].pid = sleeper.pid;
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
      await h.runTool({ action: "spawn", name: "worker1", task: "Initial task" });
      const sendRes = await h.runTool({
        action: "send",
        name: "worker1",
        message: "Use strict types",
      });

      const logPath = path.join(h.root, ".pi", "fleet", "logs", "worker1.jsonl");
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

      const logRes = await h.runTool({ action: "log", name: "worker1", n: 5 });
      await h.runTool({ action: "stop", name: "--all" });

      assert.deepEqual(
        {
          sendText: sendRes.text,
          hasToolEntry: logRes.text.includes("tool: read"),
          hasAssistantEntry: logRes.text.includes("assistant: DONE: completed checks"),
        },
        {
          sendText: "fleet: sent to 'worker1' (prompt)",
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
    const sleeper = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
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
      manBefore.members["fin-detached"].pid = sleeper.pid;
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
