import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNumstatLine, parseUntrackedLine } from "../../shared/review.ts";
import { gitReviewDiff, gitReviewList, realGitRunner, type GitRunner } from "./git-source.ts";

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
      "diff --no-renames --numstat": { stdout: "2\t1\tsrc/a.ts\n0\t5\tgone.md\n" },
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
      "diff --cached --no-renames --numstat": { stdout: "1\t1\ta.ts\n" },
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
      "diff --no-renames --numstat origin/main...HEAD": { stdout: "4\t0\tb.ts\n" },
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
      "diff --cached --no-renames --numstat": { stdout: "" },
    });
    assert.deepEqual(await gitReviewList(runner, "/w", "staged"), { kind: "empty", reason: "no-changes", cwd: "/w" });
  });
});

describe("gitReviewDiff", () => {
  test("按来源拼对参数，unified diff 原样返回；空输出 = restored", async () => {
    const runner = fakeGit({
      "diff --no-renames -- src/a.ts": { stdout: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      "diff --cached --no-renames -- a.ts": { stdout: "" },
      "rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main\n" },
      "diff --no-renames origin/main...HEAD -- b.ts": { stdout: "@@\n+line\n" },
    });
    const unstaged = await gitReviewDiff(runner, "/w", "unstaged", "src/a.ts");
    assert.equal(unstaged.diff?.includes("+new"), true);
    const staged = await gitReviewDiff(runner, "/w", "staged", "a.ts");
    assert.equal(staged.diff, null);
    assert.equal(staged.restored, true);
    const branch = await gitReviewDiff(runner, "/w", "branch", "b.ts");
    assert.equal(branch.diff, "@@\n+line");
  });

  test("未跟踪文件：不再被空 git diff 误标已还原——读盘对空文件造全量新增 diff；带 NUL → binary", async () => {
    const runner = fakeGit({
      "diff --no-renames -- new.txt": { stdout: "" },
      "ls-files -- new.txt": { stdout: "" },
      "diff --no-renames -- bin.dat": { stdout: "" },
      "ls-files -- bin.dat": { stdout: "" },
      // 已跟踪且无改动：ls-files 有输出 → 不走未跟踪分支，照旧 restored
      "diff --no-renames -- a.ts": { stdout: "" },
      "ls-files -- a.ts": { stdout: "a.ts\n" },
    });
    const readUntracked = async (path: string): Promise<Buffer | null> =>
      path.endsWith("new.txt") ? Buffer.from("one\ntwo\n", "utf8") : Buffer.from([0, 1]);
    const fresh = await gitReviewDiff(runner, "/w", "unstaged", "new.txt", readUntracked);
    assert.equal(fresh.restored, false);
    assert.ok(fresh.diff?.includes("+++ new.txt"));
    assert.ok(fresh.diff?.includes("+one"));
    const bin = await gitReviewDiff(runner, "/w", "unstaged", "bin.dat", readUntracked);
    assert.deepEqual([bin.diff, bin.binary, bin.restored], [null, true, false]);
    const clean = await gitReviewDiff(runner, "/w", "unstaged", "a.ts", readUntracked);
    assert.deepEqual([clean.diff, clean.restored], [null, true]);
  });
});

// ————————————————————————————————————————————————
// 真 git 回归：中文路径 + 改名（假 runner 仿不了 realGitRunner 的 -c 注入与真实输出）
// ————————————————————————————————————————————————
describe("gitReviewList / gitReviewDiff × 真 git", () => {
  /** 没有给 git 的环境（罕见）整组跳过；dir 为 null 即跳过信号。 */
  let dir: string | null = null;

  before(async () => {
    const hasGit = await realGitRunner(["--version"], tmpdir()).then(
      () => true,
      () => false,
    );
    if (!hasGit) return;
    dir = await mkdtemp(join(tmpdir(), "orbita-git-src-"));
    await realGitRunner(["init"], dir);
    await realGitRunner(["config", "user.email", "test@orbita.local"], dir);
    await realGitRunner(["config", "user.name", "orbita-test"], dir);
    // 关掉 autocrlf：行数统计不被换行符转换干扰（Windows 默认 true）
    await realGitRunner(["config", "core.autocrlf", "false"], dir);
    await writeFile(join(dir, "中文已改.txt"), "一\n二\n", "utf8");
    await writeFile(join(dir, "旧名.txt"), "甲\n", "utf8");
    await realGitRunner(["add", "-A"], dir);
    await realGitRunner(["commit", "-m", "init"], dir);
    await writeFile(join(dir, "中文已改.txt"), "一\n二\n三\n", "utf8");
    await writeFile(join(dir, "中文未跟踪.txt"), "新\n", "utf8");
    await realGitRunner(["mv", "旧名.txt", "新名.txt"], dir);
  });

  after(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
  });

  test("unstaged：中文路径原样列出，未跟踪文件不静默消失（quotepath 回归）", async (t) => {
    if (dir === null) return t.skip("环境没有 git");
    const list = await gitReviewList(realGitRunner, dir, "unstaged");
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const paths = list.entries.map((entry) => entry.path);
    // 修复前：未跟踪文件路径是 C 转义串 → 读盘 ENOENT → 静默消失；已改文件路径是转义乱码
    assert.ok(paths.includes("中文已改.txt"), `已改中文文件应在列：${JSON.stringify(paths)}`);
    assert.ok(paths.includes("中文未跟踪.txt"), `未跟踪中文文件应在列：${JSON.stringify(paths)}`);
    for (const p of paths) {
      assert.ok(!p.includes("\\") && !p.startsWith('"'), `路径仍是 C 引用 / 转义形态：${p}`);
    }
  });

  test("unstaged：按中文名拉 diff 有正文，不再误显「与基线一致」", async (t) => {
    if (dir === null) return t.skip("环境没有 git");
    const result = await gitReviewDiff(realGitRunner, dir, "unstaged", "中文已改.txt");
    assert.equal(result.restored, false);
    assert.ok(result.diff !== null && result.diff.includes("+三"), `diff 正文应含新增行：${result.diff}`);
  });

  test("staged：改名拆成删旧 + 增新两条真实路径（no-renames 回归）", async (t) => {
    if (dir === null) return t.skip("环境没有 git");
    const list = await gitReviewList(realGitRunner, dir, "staged");
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const paths = list.entries.map((entry) => entry.path);
    // 修复前：numstat 开着改名检测输出 `旧名.txt => 新名.txt` 一行怪路径
    assert.ok(paths.includes("旧名.txt") && paths.includes("新名.txt"), `应拆成两条真实路径：${JSON.stringify(paths)}`);
    assert.ok(!paths.some((p) => p.includes("=>")), `不应出现 old => new 形态：${JSON.stringify(paths)}`);
  });
});
