/**
 * gitWorkdirChanges 的测试（focus:changes 的 git 侧）。假 git 与假读盘注入，
 * 同 git-source.test.ts 的既有模式。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseStatusChangedLine } from "../../shared/review.ts";
import { gitWorkdirChanges, type GitRunner } from "./git-source.ts";

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
      "diff --no-renames --numstat": { stdout: "3\t1\twork.ts\n2\t2\tboth.ts\n4\t0\tgone.md\n" },
      "diff --cached --no-renames --numstat": { stdout: "5\t0\tstaged.ts\n1\t1\tboth.ts\n" },
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
      "diff --no-renames --numstat": { stdout: "" },
      "diff --cached --no-renames --numstat": { stdout: "" },
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
});
