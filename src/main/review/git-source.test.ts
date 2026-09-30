import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseNumstatLine, parseUntrackedLine } from "../../shared/review.ts";
import { gitReviewDiff, gitReviewList, type GitRunner } from "./git-source.ts";

/** 假 git：args → 预设输出。没预设到的 args 抛（测试写错立刻暴露）。 */
function fakeGit(scripts: Record<string, { code?: number; stdout: string }>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const hit = scripts[key];
    if (hit === undefined) throw new Error(`fake git: unexpected args "${key}"`);
    return { code: hit.code ?? 0, stdout: hit.stdout };
  };
}

describe("parseNumstatLine", () => {
  test("常规行：added/removed/path", () => {
    assert.deepEqual(parseNumstatLine("3\t1\tsrc/a.ts"), { path: "src/a.ts", added: 3, removed: 1, binary: false });
  });
  test("二进制行：- - path", () => {
    assert.deepEqual(parseNumstatLine("-\t-\tlogo.png"), { path: "logo.png", added: 0, removed: 0, binary: true });
  });
  test("路径含 tab 的形态：余下全归路径（git 不产这种，防御不崩）", () => {
    assert.equal(parseNumstatLine("1\t1\ta\tb")?.path, "a\tb");
  });
  test("空行 / 漂移行：null，调用方跳过", () => {
    assert.equal(parseNumstatLine(""), null);
    assert.equal(parseNumstatLine("no tabs here"), null);
    assert.equal(parseNumstatLine("x\ty\tz"), null);
  });
});

describe("parseUntrackedLine", () => {
  test("? path 与带引号形态", () => {
    assert.equal(parseUntrackedLine("? a.txt"), "a.txt");
    assert.equal(parseUntrackedLine('? "my file.txt"'), "my file.txt");
    assert.equal(parseUntrackedLine("# branch.oid ..."), null);
  });
});

describe("gitReviewList", () => {
  test("not-repo：rev-parse 128 → 空态说明", async () => {
    const runner = fakeGit({ "rev-parse --show-toplevel": { code: 128, stdout: "" } });
    const list = await gitReviewList(runner, "/w", "unstaged");
    assert.deepEqual(list, { kind: "empty", reason: "not-repo", cwd: "/w" });
  });

  test("runner 抛 ENOENT 类错误 → no-git", async () => {
    const runner: GitRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    const list = await gitReviewList(runner, "/w", "unstaged");
    assert.deepEqual(list, { kind: "empty", reason: "no-git", cwd: "/w" });
  });

  test("unstaged：numstat + 未跟踪合并、去重", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "status --porcelain=v2 --untracked-files=all": { stdout: "? new.txt\n? bin.dat\n# branch.oid abc\n" },
      diff: { stdout: "2\t1\tsrc/a.ts\n0\t5\tgone.md\n" },
    });
    // 假读盘：new.txt 两行文本；bin.dat 带 NUL → binary；读不到的路径跳过
    const readUntracked = async (path: string): Promise<Buffer | null> => {
      if (path.endsWith("new.txt")) return Buffer.from("one\ntwo\n", "utf8");
      if (path.endsWith("bin.dat")) return Buffer.from([0, 1, 2]);
      return null;
    };
    const list = await gitReviewList(runner, "/w", "unstaged", readUntracked);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    assert.deepEqual(
      list.entries.map((entry) => entry.path),
      ["src/a.ts", "gone.md", "new.txt", "bin.dat"],
    );
    // 未跟踪文件的行数对着空文件算（new.txt 两行 = +2）；带 NUL 的标 binary
    assert.equal(list.entries[2]?.added, 2);
    assert.equal(list.entries[3]?.binary, true);
  });

  test("staged：--cached 的 numstat", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "diff --cached": { stdout: "1\t1\ta.ts\n" },
    });
    const list = await gitReviewList(runner, "/w", "staged");
    assert.equal(list.kind, "ok");
    if (list.kind === "ok") assert.deepEqual(list.entries.map((entry) => entry.path), ["a.ts"]);
  });

  test("branch：无 upstream → 空态；有 upstream → upstream...HEAD", async () => {
    const noUpstream = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "rev-parse --abbrev-ref @{upstream}": { code: 1, stdout: "" },
    });
    assert.deepEqual(await gitReviewList(noUpstream, "/w", "branch"), {
      kind: "empty",
      reason: "no-upstream",
      cwd: "/w",
    });
    const withUpstream = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main\n" },
      "diff origin/main...HEAD": { stdout: "4\t0\tb.ts\n" },
    });
    const list = await gitReviewList(withUpstream, "/w", "branch");
    assert.equal(list.kind, "ok");
    if (list.kind === "ok") {
      assert.equal(list.upstream, "origin/main");
      assert.deepEqual(list.entries.map((entry) => entry.path), ["b.ts"]);
    }
  });

  test("空输出 → no-changes 空态（不是错误）", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "diff --cached": { stdout: "" },
    });
    assert.deepEqual(await gitReviewList(runner, "/w", "staged"), { kind: "empty", reason: "no-changes", cwd: "/w" });
  });
});

describe("gitReviewDiff", () => {
  test("按来源拼对参数，unified diff 原样返回；空输出 = restored", async () => {
    const runner = fakeGit({
      "diff -- src/a.ts": { stdout: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      "diff --cached -- a.ts": { stdout: "" },
      "rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main\n" },
      "diff origin/main...HEAD -- b.ts": { stdout: "@@\n+line\n" },
    });
    const unstaged = await gitReviewDiff(runner, "/w", "unstaged", "src/a.ts");
    assert.equal(unstaged.diff?.includes("+new"), true);
    const staged = await gitReviewDiff(runner, "/w", "staged", "a.ts");
    assert.equal(staged.diff, null);
    assert.equal(staged.restored, true);
    const branch = await gitReviewDiff(runner, "/w", "branch", "b.ts");
    assert.equal(branch.diff, "@@\n+line");
  });
});
