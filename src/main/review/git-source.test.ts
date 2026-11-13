import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNumstatLine, parseUntrackedLine, REVIEW_DIFF_MAX_LINES } from "../../shared/review.ts";
import {
  gitReviewDiff,
  gitReviewList,
  gitRunnerWithTimeout,
  GitTimeoutError,
  gitWorkdirChanges,
  realDiffRunner,
  realGitRunner,
  type GitRunner,
} from "./git-source.ts";
import type { UntrackedProbe } from "./untracked-lines.ts";

/** 假读盘面：read 给出每个路径的内容（null = 不存在），mtime 恒定；按块读就是从内容里拷一段 */
function fakeProbe(read: (path: string) => Buffer | null): UntrackedProbe {
  return {
    async lstat(path) {
      const bytes = read(path);
      return bytes === null ? null : { kind: "file", size: bytes.length, mtimeMs: 1 };
    },
    async readlink() {
      return null;
    },
    async open(path) {
      const bytes = read(path);
      if (bytes === null) return null;
      return {
        async read(buffer, length, position) {
          return bytes.copy(buffer, 0, position, Math.min(position + length, bytes.length));
        },
        async close() {},
      };
    },
  };
}

/** 假 git：args → 预设输出。没预设到的 args 抛（测试写错立刻暴露）。 */
function fakeGit(scripts: Record<string, { code?: number; stdout: string; truncated?: boolean }>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const hit = scripts[key];
    if (hit === undefined) throw new Error(`fake git: unexpected args "${key}"`);
    return { code: hit.code ?? 0, stdout: hit.stdout, ...(hit.truncated === true ? { truncated: true } : {}) };
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
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": { stdout: "? new.txt\n? bin.dat\n# branch.oid abc\n" },
      "diff --no-renames --relative --numstat": { stdout: "2\t1\tsrc/a.ts\n0\t5\tgone.md\n" },
    });
    // 假读盘：new.txt 两行文本；bin.dat 带 NUL → binary；读不到的路径跳过
    const probe = fakeProbe((path) => {
      if (path.endsWith("new.txt")) return Buffer.from("one\ntwo\n", "utf8");
      if (path.endsWith("bin.dat")) return Buffer.from([0, 1, 2]);
      return null;
    });
    const list = await gitReviewList(runner, "/w", "unstaged", probe);
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
      "diff --cached --no-renames --relative --numstat": { stdout: "1\t1\ta.ts\n" },
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
      "diff --no-renames --relative --numstat origin/main...HEAD": { stdout: "4\t0\tb.ts\n" },
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
      "diff --cached --no-renames --relative --numstat": { stdout: "" },
    });
    assert.deepEqual(await gitReviewList(runner, "/w", "staged"), { kind: "empty", reason: "no-changes", cwd: "/w" });
  });

  test("unstaged：工作区之外的路径（../ 前缀）不进列表——与 diff --relative 的排除口径一致", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": {
        stdout: "? ../outside-new.txt\n? inside.txt\n",
      },
      "diff --no-renames --relative --numstat": { stdout: "1\t0\tinside.ts\n" },
    });
    const probe = fakeProbe((path) => Buffer.from(`disk:${path}`, "utf8"));
    const list = await gitReviewList(runner, "/repo/sub", "unstaged", probe);
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    assert.deepEqual(list.entries.map((entry) => entry.path), ["inside.ts", "inside.txt"]);
  });

  test("diff 参数一律带 --relative：两套路径基准（status 的工作区相对 / diff 的仓库根相对）必须统一", async () => {
    const calls: string[] = [];
    const outputs: Record<string, string> = {
      "rev-parse --show-toplevel": "/w\n",
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": "",
      "rev-parse --abbrev-ref @{upstream}": "origin/main\n",
    };
    const runner: GitRunner = async (args) => {
      const key = args.join(" ");
      if (key.startsWith("diff ")) calls.push(key);
      return { code: 0, stdout: outputs[key] ?? "" };
    };
    await gitReviewList(runner, "/w", "unstaged");
    await gitReviewList(runner, "/w", "staged");
    await gitReviewList(runner, "/w", "branch");
    await gitReviewDiff(runner, "/w", "unstaged", "a.ts");
    await gitReviewDiff(runner, "/w", "staged", "a.ts");
    await gitReviewDiff(runner, "/w", "branch", "a.ts");
    assert.equal(calls.length, 6, `应发出 6 次 diff：${JSON.stringify(calls)}`);
    for (const call of calls) {
      assert.ok(call.split(" ").includes("--relative"), `diff 参数缺 --relative：${call}`);
    }
  });
});

describe("gitReviewDiff", () => {
  test("按来源拼对参数，unified diff 原样返回；空输出 = restored", async () => {
    const runner = fakeGit({
      "diff --no-renames --relative -- src/a.ts": { stdout: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n" },
      "diff --cached --no-renames --relative -- a.ts": { stdout: "" },
      "rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main\n" },
      "diff --no-renames --relative origin/main...HEAD -- b.ts": { stdout: "@@\n+line\n" },
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
      "diff --no-renames --relative -- new.txt": { stdout: "" },
      "ls-files -- new.txt": { stdout: "" },
      "diff --no-renames --relative -- bin.dat": { stdout: "" },
      "ls-files -- bin.dat": { stdout: "" },
      // 已跟踪且无改动：ls-files 有输出 → 不走未跟踪分支，照旧 restored
      "diff --no-renames --relative -- a.ts": { stdout: "" },
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

// ————————————————————————————————————————————————
// 真 git × 仓库子目录工作区：status 给的是工作区相对路径，diff 默认给仓库根相对路径
// ——两套基准混进同一份列表，U/M 会全丢（A1），按列表里的路径拉 diff 会拉空、
// 误显「已还原」（C7）。这里用真 git 钉死修复后的行为。
// ————————————————————————————————————————————————
describe("git 来源 × 子目录工作区（真 git）", () => {
  let repo: string | null = null;
  let sub = "";

  before(async () => {
    const hasGit = await realGitRunner(["--version"], tmpdir()).then(
      () => true,
      () => false,
    );
    if (!hasGit) return;
    repo = await mkdtemp(join(tmpdir(), "orbita-git-subdir-"));
    sub = join(repo, "sub");
    await mkdir(sub, { recursive: true });
    await realGitRunner(["init"], repo);
    await realGitRunner(["config", "user.email", "test@orbita.local"], repo);
    await realGitRunner(["config", "user.name", "orbita-test"], repo);
    await realGitRunner(["config", "core.autocrlf", "false"], repo);
    // 用户可能把 status.relativePaths 设成 false：status 会退回仓库根相对路径。
    // 两条 status 命令必须用 `-c status.relativePaths=true` 钉死，否则子目录工作区
    // 会与 `diff --relative` 的两套路径打架（2026-10-25 合作者实测）。
    await realGitRunner(["config", "status.relativePaths", "false"], repo);
    await writeFile(join(sub, "a.txt"), "x\n", "utf8");
    await writeFile(join(repo, "outside.txt"), "o\n", "utf8");
    await realGitRunner(["add", "-A"], repo);
    await realGitRunner(["commit", "-m", "init"], repo);
    // 工作区内：已改 + 未跟踪 + 暂存新增；工作区外：已改 + 未跟踪
    await writeFile(join(sub, "a.txt"), "x\n2\n", "utf8");
    await writeFile(join(sub, "new.txt"), "n1\nn2\n", "utf8");
    await writeFile(join(sub, "staged.txt"), "s\n", "utf8");
    await realGitRunner(["add", "staged.txt"], sub);
    await writeFile(join(repo, "outside.txt"), "o\n2\n", "utf8");
    await writeFile(join(repo, "outside-new.txt"), "z\n", "utf8");
  });

  after(async () => {
    const target = repo;
    if (target !== null) await rm(target, { recursive: true, force: true });
  });

  test("unstaged（cwd = 子目录）：路径为工作区相对，已改 M 行数正确、未跟踪进列表，工作区之外不出现", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const list = await gitReviewList(realGitRunner, sub, "unstaged");
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const byPath = new Map(list.entries.map((entry) => [entry.path, entry]));
    // 修复前：diff 给 `sub/a.txt`，status 给 `a.txt`，同一列表里两套基准
    assert.deepEqual([...byPath.keys()].sort(), ["a.txt", "new.txt"]);
    assert.deepEqual(
      { added: byPath.get("a.txt")?.added, removed: byPath.get("a.txt")?.removed },
      { added: 1, removed: 0 },
    );
    assert.equal(byPath.get("new.txt")?.added, 2);
  });

  test("staged（cwd = 子目录）：新增文件路径也是工作区相对", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const list = await gitReviewList(realGitRunner, sub, "staged");
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    assert.deepEqual(list.entries.map((entry) => [entry.path, entry.added]), [["staged.txt", 1]]);
  });

  test("unstaged diff（cwd = 子目录）：按列表里的同一路径拿得到正文，不是「已还原」", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const result = await gitReviewDiff(realGitRunner, sub, "unstaged", "a.txt");
    // 修复前：`git diff -- a.txt` 在子目录里找不到 `sub/a.txt` → 空正文 → restored
    assert.equal(result.restored, false);
    assert.ok(result.diff !== null && result.diff.includes("+2"), `diff 正文应含新增行：${result.diff}`);
    const fresh = await gitReviewDiff(realGitRunner, sub, "unstaged", "new.txt");
    assert.equal(fresh.restored, false);
    assert.ok(fresh.diff !== null && fresh.diff.includes("+n2"), `未跟踪文件应给全量新增：${fresh.diff}`);
  });

  test("工作区就是仓库根（回归）：路径仍为仓库根相对，diff 照常拿到正文", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const list = await gitReviewList(realGitRunner, repo, "unstaged");
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const paths = list.entries.map((entry) => entry.path).sort();
    assert.deepEqual(paths, ["outside-new.txt", "outside.txt", "sub/a.txt", "sub/new.txt"]);
    const result = await gitReviewDiff(realGitRunner, repo, "unstaged", "sub/a.txt");
    assert.equal(result.restored, false);
    assert.ok(result.diff?.includes("+2"), `根工作区的 diff 应照旧有正文：${result.diff}`);
  });
});

// ————————————————————————————————————————————————
// 读盘边界（审查报告 R06 的两个探针）：review:diff 的 path 是 renderer 传来的。主进程只认
// 「相对路径、resolve 后仍在工作区里」，realpath 后再判一次；未跟踪的符号链接不跟到目标
// 读正文——列表与正文都只报「这是个链接、指向哪」。拒绝要有明确回执，不能显示成「二进制」。
// ————————————————————————————————————————————————

/** 建链接；这台机器建不了（Windows 未开开发者模式建文件 symlink 会 EPERM）返回 false，那几格跳过 */
async function trySymlink(target: string, path: string, type: "file" | "junction"): Promise<boolean> {
  try {
    await symlink(target, path, type);
    return true;
  } catch {
    return false;
  }
}

describe("git 来源 × 读盘边界（真 git）", () => {
  let repo: string | null = null;
  let outside = "";
  let sub = "";
  let fileLink = false;
  let dirLink = false;

  before(async () => {
    const hasGit = await realGitRunner(["--version"], tmpdir()).then(
      () => true,
      () => false,
    );
    if (!hasGit) return;
    repo = await mkdtemp(join(tmpdir(), "orbita-review-bound-"));
    outside = await mkdtemp(join(tmpdir(), "orbita-review-outside-"));
    sub = join(repo, "sub");
    await mkdir(sub);
    await realGitRunner(["init"], repo);
    // 仓库根（工作区之外）有一个未跟踪文件；工作区（sub）里一个普通未跟踪文件当对照
    await writeFile(join(repo, "secret.txt"), "ROOT-SECRET\n", "utf8");
    await writeFile(join(sub, "visible.txt"), "visible\n", "utf8");
    await writeFile(join(outside, "outside.txt"), "OUTSIDE-SECRET\n", "utf8");
    fileLink = await trySymlink(join(outside, "outside.txt"), join(sub, "linked.txt"), "file");
    // 目录链接用 junction：#365 的夹具就是 junction，Windows 上也不要特权；POSIX 上 type 被忽略
    dirLink = await trySymlink(outside, join(sub, "linkdir"), "junction");
  });

  after(async () => {
    if (repo !== null) await rm(repo, { recursive: true, force: true });
    if (outside !== "") await rm(outside, { recursive: true, force: true });
  });

  test("../ 跑出工作区：拒绝并说明原因，读不到仓库里工作区外的文件（R06 探针一）", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const result = await gitReviewDiff(realGitRunner, sub, "unstaged", "../secret.txt");
    assert.ok(!(result.diff ?? "").includes("ROOT-SECRET"), `读到了工作区外的文件：${result.diff}`);
    assert.equal(result.diff, null);
    assert.equal(result.error?.reason, "outside-workspace");
    // 拒绝不能伪装成「二进制」或「已还原」
    assert.equal(result.binary, false);
    assert.equal(result.restored, false);
  });

  test("绝对路径、空路径、resolve 回工作区本身：三个 git 来源一律拒绝", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    for (const source of ["unstaged", "staged", "branch"] as const) {
      for (const path of [join(repo, "secret.txt"), join(sub, "visible.txt"), "", ".", "a/../../secret.txt"]) {
        const result = await gitReviewDiff(realGitRunner, sub, source, path);
        assert.equal(result.error?.reason, "outside-workspace", `${source} ${JSON.stringify(path)} 没被拒：${JSON.stringify(result)}`);
        assert.equal(result.diff, null);
      }
    }
  });

  test("git 的 pathspec 魔法（:(top) / :/）：读不出工作区外（git 输出被 --relative 限在 cwd，我们只读 resolve 后的字面路径）", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    for (const source of ["unstaged", "staged", "branch"] as const) {
      for (const path of [":(top)secret.txt", ":/secret.txt", ":(top,glob)**"]) {
        const result = await gitReviewDiff(realGitRunner, sub, source, path);
        assert.ok(!(result.diff ?? "").includes("ROOT-SECRET"), `${source} ${path} 读到了工作区外：${result.diff}`);
      }
    }
  });

  test("未跟踪的符号链接：不跟到目标读正文，回执标出链接指向哪（R06 探针二）", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    if (!fileLink) return t.skip("这台机器建不了文件符号链接");
    const result = await gitReviewDiff(realGitRunner, sub, "unstaged", "linked.txt");
    assert.ok(!(result.diff ?? "").includes("OUTSIDE-SECRET"), `跟着链接读到了工作区外：${result.diff}`);
    assert.equal(result.diff, null);
    assert.equal(result.symlink, join(outside, "outside.txt"));
    assert.equal(result.binary, false);
    assert.equal(result.restored, false);
  });

  test("链接目录下的路径（列表不会给，renderer 直接传）：realpath 后在工作区外，拒绝", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    if (!dirLink) return t.skip("这台机器建不了目录链接");
    const result = await gitReviewDiff(realGitRunner, sub, "unstaged", "linkdir/outside.txt");
    assert.ok(!(result.diff ?? "").includes("OUTSIDE-SECRET"), `穿过链接目录读到了工作区外：${result.diff}`);
    assert.equal(result.error?.reason, "outside-workspace");
  });

  test("对照：工作区内的普通未跟踪文件照常出全量新增 diff", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const result = await gitReviewDiff(realGitRunner, sub, "unstaged", "visible.txt");
    assert.equal(result.error, undefined);
    assert.ok(result.diff?.includes("+visible"), `正常文件被一起拦掉了：${JSON.stringify(result)}`);
  });

  test("列表（审查 unstaged）：未跟踪的链接标 symlink，行数不算目标的；普通文件照常数行", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    if (!fileLink) return t.skip("这台机器建不了文件符号链接");
    const list = await gitReviewList(realGitRunner, sub, "unstaged");
    assert.equal(list.kind, "ok");
    if (list.kind !== "ok") return;
    const linked = list.entries.find((entry) => entry.path === "linked.txt");
    assert.deepEqual(
      { added: linked?.added, binary: linked?.binary, symlink: linked?.symlink },
      { added: 0, binary: false, symlink: join(outside, "outside.txt") },
    );
    assert.equal(list.entries.find((entry) => entry.path === "visible.txt")?.added, 1);
  });

  test("专注左栏（gitWorkdirChanges）走同一条读盘路：链接不跟，行数不算目标的", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    if (!fileLink) return t.skip("这台机器建不了文件符号链接");
    const changes = await gitWorkdirChanges(realGitRunner, sub);
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    const linked = changes.entries.find((entry) => entry.path === "linked.txt");
    assert.deepEqual({ kind: linked?.kind, added: linked?.added }, { kind: "U", added: 0 });
  });
});

describe("gitReviewDiff × 读盘边界（假 git）", () => {
  test("被拒的路径不跑 git、不读盘", async () => {
    const calls: string[] = [];
    const runner: GitRunner = async (args) => {
      calls.push(args.join(" "));
      return { code: 0, stdout: "" };
    };
    const reads: string[] = [];
    const readUntracked = async (path: string): Promise<Buffer | null> => {
      reads.push(path);
      return Buffer.from("SECRET\n", "utf8");
    };
    for (const path of ["../x.txt", "/etc/hosts", "C:\\Windows\\win.ini", "\\\\server\\share\\x", "a\u0000b"]) {
      const result = await gitReviewDiff(runner, "/w/sub", "unstaged", path, readUntracked);
      assert.equal(result.error?.reason, "outside-workspace", `${JSON.stringify(path)} 没被拒`);
    }
    assert.deepEqual(calls, []);
    assert.deepEqual(reads, []);
  });
});

// ————————————————————————————————————————————————
// 两处 status 同一组参数；git 卡死有时限，超时如实报错、不冒充「没有改动」
// ————————————————————————————————————————————————
describe("status 参数与 git 超时", () => {
  test("审查面板（unstaged）与专注左栏发的 status 是同一组参数（以前审查那边少 --no-renames）", async () => {
    const statusCalls: string[] = [];
    const runner: GitRunner = async (args, cwd) => {
      if (args.includes("status")) statusCalls.push(`${cwd}: ${args.join(" ")}`);
      return { code: 0, stdout: args[0] === "rev-parse" && args[1] === "--show-toplevel" ? "/w\n" : "" };
    };
    await gitReviewList(runner, "/w", "unstaged", fakeProbe(() => null));
    await gitWorkdirChanges(runner, "/w", fakeProbe(() => null));
    assert.equal(statusCalls.length, 2);
    assert.equal(statusCalls[0], statusCalls[1]);
    assert.ok(statusCalls[0]?.includes("--no-renames"));
  });

  test("真 git 卡住：到点被杀，抛 GitTimeoutError，不挂死", { timeout: 20_000 }, async (t) => {
    // 「卡住」的样本是 git 别名跑 `sleep 3`：卡得有上限。曾用等 stdin 的 hash-object，时限一被删掉
    // （回归），git 永远不退、整个测试进程跟着挂住；换成这个，回归时 3 秒后 git 自己退出，这条测试报红
    const nap = await realGitRunner(["-c", "alias.orbita-nap=!sleep 0", "orbita-nap"], tmpdir()).catch(() => null);
    if (nap === null || nap.code !== 0) return t.skip("环境没有 git，或 git 别名跑不了 sleep");
    const started = Date.now();
    await assert.rejects(
      gitRunnerWithTimeout(300)(["-c", "alias.orbita-slow=!sleep 3", "orbita-slow"], tmpdir()),
      (cause: unknown) => {
        assert.ok(cause instanceof GitTimeoutError, String(cause));
        assert.match(cause.message, /git orbita-slow timed out/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_500, "应在时限附近返回，而不是等 sleep 跑完");
  });

  test("应用里的 runner 有时限：一个正常命令照常返回（时限没把正常调用拦掉）", async (t) => {
    const version = await realGitRunner(["--version"], tmpdir()).catch(() => null);
    if (version === null) return t.skip("环境没有 git");
    assert.equal(version.code, 0);
    assert.match(version.stdout, /git version/);
  });

  test("status / rev-parse 超时：列表与专注左栏都抛出去（IPC 层报错），不当成「没有 git」「没有改动」", async () => {
    const timingOut = (which: string): GitRunner => async (args) => {
      if (args.includes(which)) throw new GitTimeoutError(`git ${which} timed out after 60 s`);
      return { code: 0, stdout: args[1] === "--show-toplevel" ? "/w\n" : "" };
    };
    for (const which of ["status", "rev-parse"]) {
      await assert.rejects(gitWorkdirChanges(timingOut(which), "/w", fakeProbe(() => null)), GitTimeoutError);
      await assert.rejects(gitReviewList(timingOut(which), "/w", "unstaged", fakeProbe(() => null)), GitTimeoutError);
    }
  });
});

// ————————————————————————————————————————————————
// code 非 0 / maxBuffer 截断：如实报错，不再静默把半份输出当完整结果
// ————————————————————————————————————————————————
describe("gitReviewList × code 非 0 / 截断", () => {
  test("status 退出码非 0：error 回执说明原因，不当「没有改动」", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": { code: 128, stdout: "" },
    });
    const list = await gitReviewList(runner, "/w", "unstaged");
    assert.equal(list.kind, "error");
    if (list.kind === "error") assert.match(list.message, /status exited with code 128/);
  });

  test("numstat 输出撞 maxBuffer 被截断：error 说明被截断，不给半份清单（G4 回归）", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "diff --cached --no-renames --relative --numstat": { code: 1, stdout: "1\t1\ta.ts\n", truncated: true },
    });
    const list = await gitReviewList(runner, "/w", "staged");
    assert.equal(list.kind, "error");
    if (list.kind === "error") assert.match(list.message, /cut short/);
  });

  test("branch 的 numstat 退出码非 0：同样如实报错", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "rev-parse --abbrev-ref @{upstream}": { stdout: "origin/main\n" },
      "diff --no-renames --relative --numstat origin/main...HEAD": { code: 1, stdout: "" },
    });
    const list = await gitReviewList(runner, "/w", "branch");
    assert.equal(list.kind, "error");
  });

  test("rev-parse 128 仍是 not-repo 空态（退出码在这里是语义，不是错误）", async () => {
    const runner = fakeGit({ "rev-parse --show-toplevel": { code: 128, stdout: "" } });
    assert.deepEqual(await gitReviewList(runner, "/w", "staged"), { kind: "empty", reason: "not-repo", cwd: "/w" });
  });

  test("真 runner：maxBuffer 溢出折成 truncated，不再伪装成普通 code 1（溢出发信号时 killed 也是 true）", { timeout: 20_000 }, async (t) => {
    const probe = await realGitRunner(["--version"], tmpdir()).catch(() => null);
    if (probe === null) return t.skip("环境没有 git");
    // git 别名跑 seq：输出 ~588 KB，远超这里给的 4 KB maxBuffer
    const outcome = await gitRunnerWithTimeout(60_000, 4096)(["-c", "alias.orbita-spam=!seq 1 100000", "orbita-spam"], tmpdir());
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.code, 1);
    assert.ok(outcome.stdout.length > 0 && outcome.stdout.length < 4096 * 2, "stdout 应只有被截断的前半份");
  });
});

// ————————————————————————————————————————————————
// 先判断再生成：超过上限（5000 行 / 1 MB）不读盘、不生成正文，回「改动太大」
// ————————————————————————————————————————————————
describe("gitReviewDiff × 上限", () => {
  const bigLinesDiff = (): string => {
    const head = "--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1 @@\n";
    return head + Array.from({ length: REVIEW_DIFF_MAX_LINES + 1 }, (_, i) => `+line${i}`).join("\n") + "\n";
  };

  test("已跟踪：diff 增删行超上限 → tooLarge(lines)，不再往下走", async () => {
    const runner = fakeGit({ "diff --no-renames --relative -- a.ts": { stdout: bigLinesDiff() } });
    const result = await gitReviewDiff(runner, "/w", "unstaged", "a.ts");
    assert.equal(result.tooLarge?.exceeded, "lines");
    assert.equal(result.diff, null);
    assert.equal(result.binary, false);
    assert.equal(result.restored, false);
    assert.equal(result.error, undefined);
  });

  test("已跟踪：diff 字节超上限（单条超长行）→ tooLarge(bytes)", async () => {
    const diff = `--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-${"x".repeat(600 * 1024)}\n+${"y".repeat(600 * 1024)}\n`;
    const runner = fakeGit({ "diff --no-renames --relative -- a.ts": { stdout: diff } });
    const result = await gitReviewDiff(runner, "/w", "unstaged", "a.ts");
    assert.equal(result.tooLarge?.exceeded, "bytes");
  });

  test("已跟踪：输出撞 maxBuffer 被截断 → tooLarge(bytes)，不把半份当正文（G3/G4 回归）", async () => {
    const runner = fakeGit({ "diff --no-renames --relative -- a.ts": { code: 1, stdout: "--- a\n+++ b\n", truncated: true } });
    const result = await gitReviewDiff(runner, "/w", "unstaged", "a.ts");
    assert.equal(result.tooLarge?.exceeded, "bytes");
    assert.equal(result.diff, null);
  });

  test("已跟踪：diff 退出码非 0 → error(failed)，不再伪装成 restored / 二进制", async () => {
    const runner = fakeGit({ "diff --no-renames --relative -- a.ts": { code: 128, stdout: "" } });
    const result = await gitReviewDiff(runner, "/w", "unstaged", "a.ts");
    assert.equal(result.error?.reason, "failed");
    assert.match(result.error?.message ?? "", /exited with code 128/);
    assert.equal(result.diff, null);
    assert.equal(result.restored, false);
  });

  test("未跟踪：读盘面报 tooLarge（文件超 1 MB，只嗅探过开头）→ tooLarge(bytes)，主进程不整读", async () => {
    const runner = fakeGit({
      "diff --no-renames --relative -- big.bin": { stdout: "" },
      "ls-files -- big.bin": { stdout: "" },
    });
    const reads: string[] = [];
    const readUntracked = async (path: string) => {
      reads.push(path);
      return { tooLarge: true } as const;
    };
    const result = await gitReviewDiff(runner, "/w", "unstaged", "big.bin", readUntracked);
    assert.equal(result.tooLarge?.exceeded, "bytes");
    assert.deepEqual(reads, ["/w/big.bin"]);
  });

  test("未跟踪：超限的文件是二进制（开头有 NUL）→ 如实报 binary，不报「太大」", async () => {
    const runner = fakeGit({
      "diff --no-renames --relative -- video.mp4": { stdout: "" },
      "ls-files -- video.mp4": { stdout: "" },
    });
    const readUntracked = async () => ({ binary: true } as const);
    const result = await gitReviewDiff(runner, "/w", "unstaged", "video.mp4", readUntracked);
    assert.deepEqual([result.diff, result.binary, result.restored, result.tooLarge], [null, true, false, undefined]);
  });

  test("未跟踪：字节没超但行数超（极短行文件）→ tooLarge(lines)，不造 patch", async () => {
    const runner = fakeGit({
      "diff --no-renames --relative -- tiny-lines.txt": { stdout: "" },
      "ls-files -- tiny-lines.txt": { stdout: "" },
    });
    const readUntracked = async () => Buffer.from("a\n".repeat(REVIEW_DIFF_MAX_LINES + 1), "utf8");
    const result = await gitReviewDiff(runner, "/w", "unstaged", "tiny-lines.txt", readUntracked);
    assert.equal(result.tooLarge?.exceeded, "lines");
  });

  test("未跟踪：行数在限内、字节在限内（含单条近 1 MB 的长行）→ 正常出全量新增正文", async () => {
    const runner = fakeGit({
      "diff --no-renames --relative -- one-line.txt": { stdout: "" },
      "ls-files -- one-line.txt": { stdout: "" },
    });
    // 单条 ~900 KB 的长行：行数 1、字节 < 1 MB，必须打得开
    const readUntracked = async () => Buffer.from("x".repeat(900 * 1024), "utf8");
    const result = await gitReviewDiff(runner, "/w", "unstaged", "one-line.txt", readUntracked);
    assert.equal(result.error, undefined);
    assert.equal(result.tooLarge, undefined);
    assert.ok(result.diff !== null && result.diff.length > 900 * 1024, `应保留完整正文：${result.diff?.length}`);
  });

  test("ls-files 退出码非 0：判不了跟踪状态就如实报错，不折成空正文误显 restored", async () => {
    const runner = fakeGit({
      "diff --no-renames --relative -- a.ts": { stdout: "" },
      "ls-files -- a.ts": { code: 128, stdout: "" },
    });
    await assert.rejects(gitReviewDiff(runner, "/w", "unstaged", "a.ts"), /ls-files exited with code 128/);
  });
});

// ————————————————————————————————————————————————
// 上限 × 真 git + 真盘：未跟踪的超限文件不整读；已跟踪的大改动在 2 MB 缓冲就被拦下
// ————————————————————————————————————————————————
describe("gitReviewDiff × 上限（真 git + 真盘）", () => {
  let repo: string | null = null;

  before(async () => {
    const hasGit = await realGitRunner(["--version"], tmpdir()).then(
      () => true,
      () => false,
    );
    if (!hasGit) return;
    repo = await mkdtemp(join(tmpdir(), "orbita-git-too-large-"));
    await realGitRunner(["init"], repo);
    await realGitRunner(["config", "user.email", "test@orbita.local"], repo);
    await realGitRunner(["config", "user.name", "orbita-test"], repo);
    await realGitRunner(["config", "core.autocrlf", "false"], repo);
    await writeFile(join(repo, "base.txt"), "one\ntwo\n", "utf8");
    // 1 MB 的极短行文件（已提交、只改一行）：文件大 ≠ 改动大，必须照常展开
    await writeFile(join(repo, "big-unchanged.txt"), `${"x".repeat(200)}\n`.repeat(5120), "utf8");
    await realGitRunner(["add", "-A"], repo);
    await realGitRunner(["commit", "-m", "init"], repo);
  });

  after(async () => {
    if (repo !== null) await rm(repo, { recursive: true, force: true });
  });

  test("未跟踪的超限文本：tooLarge(bytes)，不把文件读进内存", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const big = join(repo, "big-fresh.txt");
    await writeFile(big, `${"x".repeat(120)}\n`.repeat(10_000), "utf8"); // ~1.2 MB
    try {
      const result = await gitReviewDiff(realDiffRunner, repo, "unstaged", "big-fresh.txt");
      assert.equal(result.tooLarge?.exceeded, "bytes", JSON.stringify(result).slice(0, 200));
      assert.equal(result.diff, null);
    } finally {
      await rm(big, { force: true });
    }
  });

  test("未跟踪的超限二进制：如实报 binary（只嗅探了开头 8000 字节）", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const big = join(repo, "big-fresh.bin");
    await writeFile(big, Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.alloc(2 * 1024 * 1024, 7)]));
    try {
      const result = await gitReviewDiff(realDiffRunner, repo, "unstaged", "big-fresh.bin");
      assert.deepEqual([result.diff, result.binary, result.tooLarge], [null, true, undefined]);
    } finally {
      await rm(big, { force: true });
    }
  });

  test("已跟踪的大改动：diff 输出撞 2 MB 缓冲被截断 → tooLarge(bytes)，不攒 32 MB 再回头", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    // 追加 3 MB 的改动行：正常文本（每行 120 字节），numstat 语义上是几万行
    const lines = Array.from({ length: 30_000 }, (_, i) => `appended line ${i} ${"y".repeat(100)}`).join("\n");
    await writeFile(join(repo, "base.txt"), `one\ntwo\n${lines}\n`, "utf8");
    const result = await gitReviewDiff(realDiffRunner, repo, "unstaged", "base.txt");
    assert.equal(result.tooLarge?.exceeded, "bytes", JSON.stringify(result).slice(0, 200));
    assert.equal(result.diff, null);
  });

  test("1 MB 的已跟踪文件只改一行：照常出正文（判的是 diff 不是文件大小）", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    await writeFile(join(repo, "big-unchanged.txt"), `${"x".repeat(200)}\n`.repeat(5120) + "CHANGED\n", "utf8");
    const result = await gitReviewDiff(realDiffRunner, repo, "unstaged", "big-unchanged.txt");
    assert.equal(result.tooLarge, undefined, JSON.stringify(result).slice(0, 200));
    assert.equal(result.error, undefined);
    assert.ok(result.diff?.includes("+CHANGED"), `大文件的小改动应有正文：${result.diff?.slice(0, 120)}`);
  });
});
