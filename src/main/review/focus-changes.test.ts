/**
 * gitWorkdirChanges 的测试（focus:changes 的 git 侧）。假 git 与假读盘注入，
 * 同 git-source.test.ts 的既有模式。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStatusChangedLine } from "../../shared/review.ts";
import { gitWorkdirChanges, realGitRunner, type GitRunner } from "./git-source.ts";

function fakeGit(scripts: Record<string, { code?: number; stdout: string }>): GitRunner {
  return async (args) => {
    const key = args.join(" ");
    const hit = scripts[key];
    if (hit === undefined) throw new Error(`fake git: unexpected args "${key}"`);
    return { code: hit.code ?? 0, stdout: hit.stdout };
  };
}

describe("parseStatusChangedLine", () => {
  test("1 行常规形态：path 与 XY", () => {
    assert.deepEqual(parseStatusChangedLine("1 .M N... 100644 100644 100644 abc def src/a.ts"), {
      path: "src/a.ts",
      xy: ".M",
    });
    assert.deepEqual(parseStatusChangedLine("1 M. N... 100644 100644 100644 abc def b.ts"), {
      path: "b.ts",
      xy: "M.",
    });
  });
  test("路径含空格：余下全归路径", () => {
    assert.deepEqual(parseStatusChangedLine("1 .M N... 1 2 3 a b my file.ts"), {
      path: "my file.ts",
      xy: ".M",
    });
  });
  test("非 1 行（? / 2 / # / 空行）与缺字段：null", () => {
    assert.equal(parseStatusChangedLine("? a.txt"), null);
    assert.equal(parseStatusChangedLine("2 RM N... 1 2 3 a b S new\told"), null);
    assert.equal(parseStatusChangedLine("# branch.oid abc"), null);
    assert.equal(parseStatusChangedLine(""), null);
    assert.equal(parseStatusChangedLine("1 .M short"), null);
  });
});

describe("gitWorkdirChanges", () => {
  test("not-repo / no-git → 空态说明", async () => {
    const notRepo = await gitWorkdirChanges(
      fakeGit({ "rev-parse --show-toplevel": { code: 128, stdout: "" } }),
      "/w",
    );
    assert.deepEqual(notRepo, { kind: "empty", reason: "not-repo" });
    const throwing: GitRunner = async () => {
      throw new Error("spawn git ENOENT");
    };
    assert.deepEqual(await gitWorkdirChanges(throwing, "/w"), { kind: "empty", reason: "no-git" });
  });

  test("U / M 分类：未跟踪与暂存新增都是 U，修改是 M；两条 numstat 同路径合并", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "status --porcelain=v2 --untracked-files=all --no-renames": {
        stdout: [
          "? new.txt",
          "1 M. N... 1 2 3 a b staged.ts",
          "1 .M N... 1 2 3 a b work.ts",
          "1 A. N... 1 2 3 a b added.ts",
          "1 MM N... 1 2 3 a b both.ts",
          "1 .D N... 1 2 3 a b gone.md",
          "# branch.oid abc",
        ].join("\n"),
      },
      "diff --no-renames --relative --numstat": { stdout: "3\t1\twork.ts\n2\t2\tboth.ts\n4\t0\tgone.md\n" },
      "diff --cached --no-renames --relative --numstat": { stdout: "5\t0\tstaged.ts\n1\t1\tboth.ts\n" },
      "rev-parse --abbrev-ref HEAD": { stdout: "feat/focus-mode\n" },
    });
    const readUntracked = async (path: string): Promise<Buffer | null> =>
      path.endsWith("new.txt") ? Buffer.from("one\ntwo\n", "utf8") : null;
    const changes = await gitWorkdirChanges(runner, "/w", readUntracked);
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.equal(changes.branch, "feat/focus-mode");
    assert.deepEqual(
      changes.entries.map((entry) => [entry.path, entry.kind, entry.added, entry.removed]),
      [
        ["new.txt", "U", 2, 0],
        ["staged.ts", "M", 5, 0],
        ["work.ts", "M", 3, 1],
        ["added.ts", "U", 0, 0],
        ["both.ts", "M", 3, 3],
        ["gone.md", "M", 4, 0],
      ],
    );
  });

  test("读不了盘的未跟踪文件：U 保留、行数 0；分支拿不到 → null", async () => {
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/w\n" },
      "status --porcelain=v2 --untracked-files=all --no-renames": { stdout: "? gone-new.txt\n" },
      "diff --no-renames --relative --numstat": { stdout: "" },
      "diff --cached --no-renames --relative --numstat": { stdout: "" },
      "rev-parse --abbrev-ref HEAD": { code: 128, stdout: "" },
    });
    const changes = await gitWorkdirChanges(runner, "/w", async () => null);
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.equal(changes.branch, null);
    assert.deepEqual(changes.entries, [
      { path: "gone-new.txt", kind: "U", added: 0, removed: 0, binary: false },
    ]);
  });

  test("子目录工作区：status 的 ../ 路径（工作区之外）不进列表，其余保持工作区相对", async () => {
    // 实测：在仓库子目录跑 status --porcelain=v2，工作区之外的改动带 `../` 前缀；
    // 这些不归这棵树管（同 git diff --relative 的排除口径）
    const runner = fakeGit({
      "rev-parse --show-toplevel": { stdout: "/repo\n" },
      "status --porcelain=v2 --untracked-files=all --no-renames": {
        stdout: [
          "1 .M N... 1 2 3 a b ../outside.ts",
          "? ../outside-new.txt",
          "1 .M N... 1 2 3 a b inside.ts",
          "? inside-new.txt",
        ].join("\n"),
      },
      "diff --no-renames --relative --numstat": { stdout: "2\t1\tinside.ts\n" },
      "diff --cached --no-renames --relative --numstat": { stdout: "" },
      "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
    });
    const readUntracked = async (path: string): Promise<Buffer | null> =>
      path.endsWith("inside-new.txt") ? Buffer.from("n1\nn2\n", "utf8") : null;
    const changes = await gitWorkdirChanges(runner, "/repo/sub", readUntracked);
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(
      changes.entries.map((entry) => [entry.path, entry.kind, entry.added, entry.removed]),
      [
        ["inside.ts", "M", 2, 1],
        ["inside-new.txt", "U", 2, 0],
      ],
    );
  });
});

// ————————————————————————————————————————————————
// 真 git：子目录工作区的路径基准（status 工作区相对 / diff --relative 工作区相对）
// ————————————————————————————————————————————————
describe("gitWorkdirChanges × 子目录工作区（真 git）", () => {
  let repo: string | null = null;
  let sub = "";

  before(async () => {
    const hasGit = await realGitRunner(["--version"], tmpdir()).then(
      () => true,
      () => false,
    );
    if (!hasGit) return;
    repo = await mkdtemp(join(tmpdir(), "orbita-focus-subdir-"));
    sub = join(repo, "sub");
    await mkdir(sub, { recursive: true });
    await realGitRunner(["init"], repo);
    await realGitRunner(["config", "user.email", "test@orbita.local"], repo);
    await realGitRunner(["config", "user.name", "orbita-test"], repo);
    await realGitRunner(["config", "core.autocrlf", "false"], repo);
    await writeFile(join(sub, "a.txt"), "x\n", "utf8");
    await writeFile(join(repo, "outside.txt"), "o\n", "utf8");
    await realGitRunner(["add", "-A"], repo);
    await realGitRunner(["commit", "-m", "init"], repo);
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

  test("cwd = 子目录：U / M 全部保留，路径工作区相对，行数正确，工作区之外不出现", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const changes = await gitWorkdirChanges(realGitRunner, sub);
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    // 修复前：已改文件被换算成 `../a.txt` 后丢掉，专注左栏 U/M 全无
    assert.deepEqual(
      changes.entries.map((entry) => [entry.path, entry.kind, entry.added, entry.removed]),
      [
        ["a.txt", "M", 1, 0],
        ["staged.txt", "U", 1, 0],
        ["new.txt", "U", 2, 0],
      ],
    );
  });

  test("cwd = 仓库根（回归）：路径照旧是仓库根相对", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const changes = await gitWorkdirChanges(realGitRunner, repo);
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(
      changes.entries.map((entry) => [entry.path, entry.kind]),
      [
        ["outside.txt", "M"],
        ["sub/a.txt", "M"],
        ["sub/staged.txt", "U"],
        ["outside-new.txt", "U"],
        ["sub/new.txt", "U"],
      ],
    );
  });
});
