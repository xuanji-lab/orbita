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
import { gitWorkdirChanges, realGitRunner, type GitRunner, type UntrackedProbe } from "./git-source.ts";

interface FakeFile {
  bytes: Buffer;
  /** 改这个值 / 换 bytes 就能模拟「文件变了」——真实磁盘上缓存键就是 size + mtime */
  mtimeMs: number;
}

/** 假读盘面（键是绝对路径）：counter 用来断言「没有重新读盘」 */
function fakeProbe(files: Map<string, FakeFile>, counter?: { reads: number; headBytes: number[] }): UntrackedProbe {
  return {
    async stat(path) {
      const file = files.get(path);
      return file === undefined ? null : { size: file.bytes.length, mtimeMs: file.mtimeMs };
    },
    async read(path, maxBytes) {
      const file = files.get(path);
      if (file === undefined) return null;
      if (counter !== undefined) {
        counter.reads += 1;
        if (maxBytes !== null) counter.headBytes.push(maxBytes);
      }
      return maxBytes === null ? file.bytes : file.bytes.subarray(0, maxBytes);
    },
  };
}

/** 只有一个未跟踪文件列表时的假 git（U/M 之外的输出全空） */
function untrackedRunner(statusLines: readonly string[]): GitRunner {
  return fakeGit({
    "rev-parse --show-toplevel": { stdout: "/w\n" },
    "status --porcelain=v2 --untracked-files=all --no-renames": { stdout: statusLines.join("\n") },
    "diff --no-renames --relative --numstat": { stdout: "" },
    "diff --cached --no-renames --relative --numstat": { stdout: "" },
    "rev-parse --abbrev-ref HEAD": { stdout: "main\n" },
  });
}

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
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": {
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
    const files = new Map<string, FakeFile>([
      ["/w/new.txt", { bytes: Buffer.from("one\ntwo\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const changes = await gitWorkdirChanges(runner, "/w", fakeProbe(files));
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
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": { stdout: "? gone-new.txt\n" },
      "diff --no-renames --relative --numstat": { stdout: "" },
      "diff --cached --no-renames --relative --numstat": { stdout: "" },
      "rev-parse --abbrev-ref HEAD": { code: 128, stdout: "" },
    });
    const changes = await gitWorkdirChanges(runner, "/w", fakeProbe(new Map()));
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
      "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": {
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
    const files = new Map<string, FakeFile>([
      ["/repo/sub/inside-new.txt", { bytes: Buffer.from("n1\nn2\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const changes = await gitWorkdirChanges(runner, "/repo/sub", fakeProbe(files));
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

  // ————————————————————————————————
  // 未跟踪文件的行数缓存与单文件上限（专注左栏 30 秒一轮，读盘量在这条路径上最贵）
  // ————————————————————————————————

  test("未跟踪文件行数按 (路径, size, mtime) 缓存：文件没变就不再读盘", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-cache-a/hit.txt", { bytes: Buffer.from("one\ntwo\nthree\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const counter = { reads: 0, headBytes: [] as number[] };
    const probe = fakeProbe(files, counter);
    const runner = untrackedRunner(["? hit.txt"]);

    const first = await gitWorkdirChanges(runner, "/w-cache-a", probe);
    assert.equal(first.kind, "ok");
    if (first.kind !== "ok") return;
    assert.deepEqual(first.entries, [{ path: "hit.txt", kind: "U", added: 3, removed: 0, binary: false }]);
    assert.equal(counter.reads, 1);

    const second = await gitWorkdirChanges(runner, "/w-cache-a", probe);
    assert.equal(second.kind, "ok");
    if (second.kind !== "ok") return;
    assert.deepEqual(second.entries, first.entries);
    // 第二次只 stat、不读盘——轮询不该把没变的文件再读一遍
    assert.equal(counter.reads, 1);
  });

  test("文件变了（size 或 mtime 变）→ 缓存失效、重新计数", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-cache-b/f.txt", { bytes: Buffer.from("a\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const counter = { reads: 0, headBytes: [] as number[] };
    const probe = fakeProbe(files, counter);
    const runner = untrackedRunner(["? f.txt"]);

    const first = await gitWorkdirChanges(runner, "/w-cache-b", probe);
    assert.equal(first.kind, "ok");
    if (first.kind !== "ok") return;
    assert.equal(first.entries[0]?.added, 1);

    // 只改 mtime（内容一样）：键变了就重读，不猜「内容没变」
    files.set("/w-cache-b/f.txt", { bytes: Buffer.from("a\nb\nc\n", "utf8"), mtimeMs: 2000 });
    const second = await gitWorkdirChanges(runner, "/w-cache-b", probe);
    assert.equal(second.kind, "ok");
    if (second.kind !== "ok") return;
    assert.equal(second.entries[0]?.added, 3);
    assert.equal(counter.reads, 2);

    // 只改 size（mtime 退回旧值）：也必须失效
    files.set("/w-cache-b/f.txt", { bytes: Buffer.from("a\nb\n", "utf8"), mtimeMs: 2000 });
    const third = await gitWorkdirChanges(runner, "/w-cache-b", probe);
    assert.equal(third.kind, "ok");
    if (third.kind !== "ok") return;
    assert.equal(third.entries[0]?.added, 2);
    assert.equal(counter.reads, 3);
  });

  test("超过 1 MB：只读头 8 KB，非二进制 → 行数未知（不显示 +0）", async () => {
    const big = Buffer.from("x\n".repeat(600_000) + "y\n", "utf8"); // 1.2 MB 文本
    assert.ok(big.length > 1024 * 1024);
    const files = new Map<string, FakeFile>([["/w-oversize/big.txt", { bytes: big, mtimeMs: 1000 }]]);
    const counter = { reads: 0, headBytes: [] as number[] };
    const changes = await gitWorkdirChanges(untrackedRunner(["? big.txt"]), "/w-oversize", fakeProbe(files, counter));
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(changes.entries, [
      { path: "big.txt", kind: "U", added: 0, removed: 0, binary: false, lineCountUnknown: true },
    ]);
    // 只请求开头 8 KB，不读全文
    assert.deepEqual(counter.headBytes, [8 * 1024]);
    assert.equal(counter.reads, 1);
  });

  test("超过 1 MB 且开头含 NUL → 二进制，行数 0（与审查面板同口径）", async () => {
    const blob = Buffer.concat([Buffer.from([0x41, 0x00, 0x42]), Buffer.alloc(1024 * 1024, 0x41)]);
    const files = new Map<string, FakeFile>([["/w-binary-big/blob.bin", { bytes: blob, mtimeMs: 1000 }]]);
    const changes = await gitWorkdirChanges(untrackedRunner(["? blob.bin"]), "/w-binary-big", fakeProbe(files));
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(changes.entries, [{ path: "blob.bin", kind: "U", added: 0, removed: 0, binary: true }]);
  });

  test("小文件含 NUL → 二进制，行数 0", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-binary-small/small.bin", { bytes: Buffer.from([0x61, 0x00, 0x62]), mtimeMs: 1000 }],
    ]);
    const changes = await gitWorkdirChanges(untrackedRunner(["? small.bin"]), "/w-binary-small", fakeProbe(files));
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(changes.entries, [{ path: "small.bin", kind: "U", added: 0, removed: 0, binary: true }]);
  });

  test("缓存容量上限 2000：超了淘汰最旧，不无界增长", async () => {
    const total = 2001;
    const files = new Map<string, FakeFile>();
    const statusLines: string[] = [];
    for (let i = 0; i < total; i++) {
      const name = `f-${i}.txt`;
      files.set(`/w-evict/${name}`, { bytes: Buffer.from("l\n", "utf8"), mtimeMs: 1000 });
      statusLines.push(`? ${name}`);
    }
    const counter = { reads: 0, headBytes: [] as number[] };
    const probe = fakeProbe(files, counter);

    const all = await gitWorkdirChanges(untrackedRunner(statusLines), "/w-evict", probe);
    assert.equal(all.kind, "ok");
    if (all.kind !== "ok") return;
    assert.equal(all.entries.length, total);
    assert.equal(counter.reads, total);

    // 最先插入的 f-0 已被挤出：再问它必须重新读盘
    const again = await gitWorkdirChanges(untrackedRunner(["? f-0.txt"]), "/w-evict", probe);
    assert.equal(again.kind, "ok");
    if (again.kind !== "ok") return;
    assert.equal(again.entries[0]?.added, 1);
    assert.equal(counter.reads, total + 1);

    // 刚问过的又进了缓存：再问一次不再读
    const cached = await gitWorkdirChanges(untrackedRunner(["? f-0.txt"]), "/w-evict", probe);
    assert.equal(cached.kind, "ok");
    if (cached.kind !== "ok") return;
    assert.equal(counter.reads, total + 1);
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
    // 钉死 false 配置：status 必须被 -c status.relativePaths=true 拉回工作区相对路径。
    await realGitRunner(["config", "status.relativePaths", "false"], repo);
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
