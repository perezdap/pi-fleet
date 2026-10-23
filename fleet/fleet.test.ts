import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Fleet, parseFleetCommand, toolParamsToCommand, type FleetUi } from "./fleet.ts";
import type { Manifest, Member, MemberStatus } from "./types.ts";

function makeMember(name: string, status: MemberStatus, overrides: Partial<Member> = {}): Member {
  return {
    name,
    role: "coder",
    task: `Task for ${name}`,
    branch: `fleet/${name}`,
    worktree: `/repo/.pi/fleet/wt/${name}`,
    baseRef: "abc1234",
    status,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

const noopUi: FleetUi = {
  notify: () => {},
  setWidget: () => {},
};

describe("parseFleetCommand", () => {
  it("parses empty input and status/help commands", () => {
    assert.deepEqual(parseFleetCommand(""), { action: "status" });
    assert.deepEqual(parseFleetCommand("   "), { action: "status" });
    assert.deepEqual(parseFleetCommand("status"), { action: "status" });
    assert.deepEqual(parseFleetCommand("help"), { action: "help" });
    assert.deepEqual(parseFleetCommand("--help"), { action: "help" });
    assert.deepEqual(parseFleetCommand("-h"), { action: "help" });
  });

  it("parses spawn with flags and strips matching outer quotes on task", () => {
    assert.deepEqual(
      parseFleetCommand('spawn --role reviewer --model openai/gpt-5 --over fleet/api r1 "Review the auth work"'),
      {
        action: "spawn",
        name: "r1",
        task: "Review the auth work",
        role: "reviewer",
        model: "openai/gpt-5",
        over: "fleet/api",
      },
    );
    assert.deepEqual(parseFleetCommand("spawn api Implement login endpoint"), {
      action: "spawn",
      name: "api",
      task: "Implement login endpoint",
    });
  });

  it("preserves --done and --all targets on clean in any flag order", () => {
    assert.deepEqual(parseFleetCommand("clean --done"), {
      action: "clean",
      target: "--done",
    });
    assert.deepEqual(parseFleetCommand("clean --all"), {
      action: "clean",
      target: "--all",
    });
    assert.deepEqual(parseFleetCommand("clean --done --force"), {
      action: "clean",
      target: "--done",
      force: true,
    });
    assert.deepEqual(parseFleetCommand("clean --force --all"), {
      action: "clean",
      target: "--all",
      force: true,
    });
    assert.deepEqual(parseFleetCommand("clean api --force"), {
      action: "clean",
      target: "api",
      force: true,
    });
  });

  it("parses resume, send, log, merge, stop, and open commands", () => {
    assert.deepEqual(parseFleetCommand("resume api"), {
      action: "resume",
      name: "api",
    });
    assert.deepEqual(parseFleetCommand('resume api "Finish the validation tests"'), {
      action: "resume",
      name: "api",
      extra: "Finish the validation tests",
    });
    assert.deepEqual(parseFleetCommand("send api 'Use SQLite in memory'"), {
      action: "send",
      name: "api",
      message: "Use SQLite in memory",
    });
    assert.deepEqual(parseFleetCommand("log api"), {
      action: "log",
      name: "api",
      n: 20,
    });
    assert.deepEqual(parseFleetCommand("log api 50"), {
      action: "log",
      name: "api",
      n: 50,
    });
    assert.deepEqual(parseFleetCommand("merge --done"), {
      action: "merge",
      target: "--done",
    });
    assert.deepEqual(parseFleetCommand("stop --all"), {
      action: "stop",
      target: "--all",
    });
    assert.deepEqual(parseFleetCommand("open api"), {
      action: "open",
      name: "api",
    });
  });

  it("throws usage errors when required arguments are missing", () => {
    assert.throws(() => parseFleetCommand("spawn onlyname"), /usage: \/fleet spawn/);
    assert.throws(() => parseFleetCommand("spawn --role bogus api task"), /usage: \/fleet spawn/);
    assert.throws(() => parseFleetCommand("resume"), /usage: \/fleet resume/);
    assert.throws(() => parseFleetCommand("send api"), /usage: \/fleet send/);
    assert.throws(() => parseFleetCommand("log"), /usage: \/fleet log/);
    assert.throws(() => parseFleetCommand("merge"), /usage: \/fleet merge/);
    assert.throws(() => parseFleetCommand("stop"), /usage: \/fleet stop/);
    assert.throws(() => parseFleetCommand("clean --force"), /usage: \/fleet clean/);
    assert.throws(() => parseFleetCommand("open"), /usage: \/fleet open/);
  });
});

describe("Fleet.execute batch target selection", () => {
  it("merge --done merges only 'done' members and reports empty batch when none match", async () => {
    const manifest: Manifest = {
      version: 1,
      repoRoot: "/repo",
      members: {
        m1: makeMember("m1", "done"),
        m2: makeMember("m2", "running"),
        m3: makeMember("m3", "merged"),
      },
    };
    const mergedBranches: string[] = [];
    const fleet = new Fleet("/repo", noopUi, {
      loadManifest: async () => manifest,
      saveManifest: async () => {},
      mergeBranch: async (_root, branch) => {
        mergedBranches.push(branch);
        return { ok: true, conflicts: [], output: "" };
      },
    });

    const res = await fleet.execute({ action: "merge", target: "--done" });
    assert.deepEqual(mergedBranches, ["fleet/m1"]);
    assert.deepEqual(res.lines, ["fleet: merged m1"]);
    assert.equal(manifest.members.m1.status, "merged");

    const emptyRes = await fleet.execute({ action: "merge", target: "--done" });
    assert.deepEqual(emptyRes.lines, ["fleet: no matching members to merge"]);
  });

  it("stop --all stops only active members and skips terminal ones", async () => {
    const manifest: Manifest = {
      version: 1,
      repoRoot: "/repo",
      members: {
        active1: makeMember("active1", "running"),
        active2: makeMember("active2", "idle"),
        finished: makeMember("finished", "done"),
        alreadyMerged: makeMember("alreadyMerged", "merged"),
      },
    };
    const fleet = new Fleet("/repo", noopUi, {
      loadManifest: async () => manifest,
      saveManifest: async () => {},
    });

    const res = await fleet.execute({ action: "stop", target: "--all" });
    assert.deepEqual(res.lines, ["fleet: stopped 'active1'", "fleet: stopped 'active2'"]);
    assert.equal(manifest.members.active1.status, "stopped");
    assert.equal(manifest.members.active2.status, "stopped");
    assert.equal(manifest.members.finished.status, "done");
    assert.equal(manifest.members.alreadyMerged.status, "merged");

    const emptyRes = await fleet.execute({ action: "stop", target: "--all" });
    assert.deepEqual(emptyRes.lines, ["fleet: no matching members to stop"]);
  });

  it("clean --done cleans all non-active members while leaving active members intact", async () => {
    const manifest: Manifest = {
      version: 1,
      repoRoot: "/repo",
      members: {
        runningMem: makeMember("runningMem", "running"),
        doneMem: makeMember("doneMem", "done"),
        mergedMem: makeMember("mergedMem", "merged"),
        failedMem: makeMember("failedMem", "failed"),
        stoppedMem: makeMember("stoppedMem", "stopped"),
        staleMem: makeMember("staleMem", "stale"),
      },
    };
    const fleet = new Fleet("/repo", noopUi, {
      loadManifest: async () => manifest,
      saveManifest: async () => {},
      branchMerged: async (_root, branch) => branch === "fleet/mergedMem",
      deleteBranch: async () => ({ ok: true, out: "" }),
      removeWorktree: async () => ({ ok: true, out: "" }),
    });

    const res = await fleet.execute(parseFleetCommand("clean --done"));
    assert.deepEqual(Object.keys(manifest.members), ["runningMem"]);
    assert.equal(res.lines.length, 5);
    assert.match(res.lines[0], /cleaned 'doneMem'/);
    assert.match(res.lines[1], /cleaned 'mergedMem' \(worktree removed, merged branch deleted\)/);

    const emptyRes = await fleet.execute(parseFleetCommand("clean --done"));
    assert.deepEqual(emptyRes.lines, ["fleet: no matching members to clean"]);
  });

  it("resume preserves member.task in manifest while forwarding extra instructions to prompt and system append", async () => {
    const manifest: Manifest = {
      version: 1,
      repoRoot: "/repo",
      members: {
        api: makeMember("api", "stale", { task: "Implement OAuth login" }),
      },
    };
    const promptsSent: string[] = [];
    const promptFilesWritten: string[] = [];
    const fleet = new Fleet("/repo", noopUi, {
      loadConfig: async () => ({ maxMembers: 6 }),
      loadManifest: async () => manifest,
      saveManifest: async () => {},
      branchExists: async () => true,
      attachWorktree: async () => {},
      writePromptFile: async (_file, content) => {
        promptFilesWritten.push(content);
      },
      createClient: async () => ({
        pid: 4321,
        exited: false,
        busy: false,
        onEvent: () => () => {},
        waitReady: async () => {},
        getState: async () => ({ sessionFile: "/repo/.pi/fleet/sessions/api.json" }),
        prompt: async (msg: string) => {
          promptsSent.push(msg);
        },
        steer: async () => {},
        abort: async () => {},
        detach: () => {},
        kill: async () => {},
      }),
    });

    const res = await fleet.execute(
      parseFleetCommand('resume api "Also cover PKCE token refresh"'),
    );
    assert.deepEqual(res.lines, ["fleet: resumed 'api'"]);
    assert.equal(manifest.members.api.task, "Implement OAuth login");
    assert.equal(promptsSent.length, 1);
    assert.match(promptsSent[0], /Original assignment:\nImplement OAuth login/);
    assert.match(promptsSent[0], /Additional instructions from supervisor:\nAlso cover PKCE token refresh/);
    assert.match(promptFilesWritten[0], /Also cover PKCE token refresh/);
  });

  it("status returns all members uncapped while capping the TUI widget at 8 rows", async () => {
    const members: Record<string, Member> = {};
    for (let i = 1; i <= 10; i++) {
      const name = `m${i}`;
      members[name] = makeMember(name, "done", { createdAt: i * 100 });
    }
    let widgetLines: string[] = [];
    const ui: FleetUi = {
      notify: () => {},
      setWidget: (lines) => {
        widgetLines = lines;
      },
    };
    const fleet = new Fleet("/repo", ui, {
      loadManifest: async () => ({ version: 1, repoRoot: "/repo", members }),
      saveManifest: async () => {},
    });

    const res = await fleet.execute({ action: "status" });
    assert.equal(res.lines.length, 11); // 1 header + all 10 members
    assert.match(res.lines[10], /m10 \[coder\] status=done/);
    assert.equal(widgetLines.length, 10); // 1 header + 8 members + "… 2 more"
    assert.equal(widgetLines[9], " … 2 more");
  });
});

describe("toolParamsToCommand", () => {
  it("maps LLM tool parameters to FleetCommand with full headless parity", () => {
    assert.deepEqual(
      toolParamsToCommand({
        action: "spawn",
        name: "rev1",
        task: "Review PR",
        role: "reviewer",
        model: "openai/gpt-5",
        over: "fleet/api",
      }),
      {
        action: "spawn",
        name: "rev1",
        task: "Review PR",
        role: "reviewer",
        model: "openai/gpt-5",
        over: "fleet/api",
      },
    );
    assert.deepEqual(
      toolParamsToCommand({
        action: "resume",
        name: "api",
        message: "Finish edge cases",
      }),
      {
        action: "resume",
        name: "api",
        extra: "Finish edge cases",
      },
    );
    assert.deepEqual(
      toolParamsToCommand({
        action: "clean",
        name: "--done",
        force: true,
      }),
      {
        action: "clean",
        target: "--done",
        force: true,
      },
    );
    assert.deepEqual(
      toolParamsToCommand({
        action: "merge",
        name: "--done",
      }),
      {
        action: "merge",
        target: "--done",
      },
    );
    assert.deepEqual(
      toolParamsToCommand({
        action: "stop",
        name: "--all",
      }),
      {
        action: "stop",
        target: "--all",
      },
    );
    assert.deepEqual(
      toolParamsToCommand({
        action: "log",
        name: "api",
        n: 40,
      }),
      {
        action: "log",
        name: "api",
        n: 40,
      },
    );
  });
});
