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
import { GIT_BINARY_SNIFF_BYTES, UNTRACKED_LINE_COUNT_MAX_BYTES, type UntrackedProbe } from "./untracked-lines.ts";

interface FakeFile {
  bytes: Buffer;
  /** 改这个值 / 换 bytes 就能模拟「文件变了」——真实磁盘上缓存键就是 size + mtime */
  mtimeMs: number;
  /** 声明的 size（不填 = bytes.length）：模拟几百 MB 而不真分配；读到 bytes 末尾就是 EOF */
  size?: number;
}

/** 假读盘面（键是绝对路径）：io 记打开次数与读到的字节数，断言「没有重新读盘」「只读了开头」 */
function fakeProbe(files: Map<string, FakeFile>, io?: { opens: number; bytes: number }): UntrackedProbe {
  return {
    async lstat(path) {
      const file = files.get(path);
      return file === undefined ? null : { kind: "file", size: file.size ?? file.bytes.length, mtimeMs: file.mtimeMs };
    },
    async readlink() {
      return null;
    },
    async open(path) {
      const file = files.get(path);
      if (file === undefined) return null;
      if (io !== undefined) io.opens += 1;
      return {
        async read(buffer, length, position) {
          const got = file.bytes.copy(buffer, 0, position, Math.min(position + length, file.bytes.length));
          if (io !== undefined) io.bytes += got;
          return got;
        },
        async close() {},
      };
    },
  };
}

/** 只有一个未跟踪文件列表时的假 git（U/M 之外的输出全空） */
function untrackedRunner(statusLines: readonly string[]): GitRunner {
  return fakeGit({
    "rev-parse --show-toplevel": { stdout: "/w\n" },
    "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": { stdout: statusLines.join("\n") },
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
    const counter = { opens: 0, bytes: 0 };
    const probe = fakeProbe(files, counter);
    const runner = untrackedRunner(["? hit.txt"]);

    const first = await gitWorkdirChanges(runner, "/w-cache-a", probe);
    assert.equal(first.kind, "ok");
    if (first.kind !== "ok") return;
    assert.deepEqual(first.entries, [{ path: "hit.txt", kind: "U", added: 3, removed: 0, binary: false }]);
    assert.equal(counter.opens, 1);

    const second = await gitWorkdirChanges(runner, "/w-cache-a", probe);
    assert.equal(second.kind, "ok");
    if (second.kind !== "ok") return;
    assert.deepEqual(second.entries, first.entries);
    // 第二次只 stat、不读盘——轮询不该把没变的文件再读一遍
    assert.equal(counter.opens, 1);
  });

  test("文件变了（size 或 mtime 变）→ 缓存失效、重新计数", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-cache-b/f.txt", { bytes: Buffer.from("a\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const counter = { opens: 0, bytes: 0 };
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
    assert.equal(counter.opens, 2);

    // 只改 size（mtime 退回旧值）：也必须失效
    files.set("/w-cache-b/f.txt", { bytes: Buffer.from("a\nb\n", "utf8"), mtimeMs: 2000 });
    const third = await gitWorkdirChanges(runner, "/w-cache-b", probe);
    assert.equal(third.kind, "ok");
    if (third.kind !== "ok") return;
    assert.equal(third.entries[0]?.added, 2);
    assert.equal(counter.opens, 3);
  });

  test("超过计数上限：只读开头 8000 字节，非二进制 → 行数未知（不显示 +0）", async () => {
    // 声明 size 刚过上限；内容只备开头一段（够判二进制），计数器不该往后读
    const head = Buffer.from("x\n".repeat(10_000), "utf8");
    const files = new Map<string, FakeFile>([
      ["/w-oversize/big.txt", { bytes: head, size: UNTRACKED_LINE_COUNT_MAX_BYTES + 1, mtimeMs: 1000 }],
    ]);
    const counter = { opens: 0, bytes: 0 };
    const changes = await gitWorkdirChanges(untrackedRunner(["? big.txt"]), "/w-oversize", fakeProbe(files, counter));
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(changes.entries, [
      { path: "big.txt", kind: "U", added: 0, removed: 0, binary: false, lineCountUnknown: true },
    ]);
    // 只读了判二进制的那 8000 字节，不读全文
    assert.deepEqual([counter.opens, counter.bytes], [1, GIT_BINARY_SNIFF_BYTES]);
  });

  test("1 MB 到上限之间的文本照数（以前 1 MB 以上一律「行数未知」）", async () => {
    const text = Buffer.from("x\n".repeat(600_000) + "y\n", "utf8"); // 1.2 MB，600001 行
    assert.ok(text.length > 1024 * 1024);
    const files = new Map<string, FakeFile>([["/w-mid/mid.txt", { bytes: text, mtimeMs: 1000 }]]);
    const changes = await gitWorkdirChanges(untrackedRunner(["? mid.txt"]), "/w-mid", fakeProbe(files));
    assert.equal(changes.kind, "ok");
    if (changes.kind !== "ok") return;
    assert.deepEqual(changes.entries, [{ path: "mid.txt", kind: "U", added: 600_001, removed: 0, binary: false }]);
  });

  test("超过上限且开头含 NUL → 二进制，行数 0（与审查面板同口径）", async () => {
    const blob = Buffer.concat([Buffer.from([0x41, 0x00, 0x42]), Buffer.alloc(16 * 1024, 0x41)]);
    const files = new Map<string, FakeFile>([
      ["/w-binary-big/blob.bin", { bytes: blob, size: UNTRACKED_LINE_COUNT_MAX_BYTES + 1, mtimeMs: 1000 }],
    ]);
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

  // ————————————————————————————————
  // 缓存跟着上一轮走 + 每轮数行的预算
  // ————————————————————————————————

  /** n 个小未跟踪文件（各两行）：返回假盘与 status 行 */
  function manyFiles(cwd: string, total: number): { files: Map<string, FakeFile>; lines: string[] } {
    const files = new Map<string, FakeFile>();
    const lines: string[] = [];
    for (let i = 0; i < total; i++) {
      files.set(`${cwd}/data/f-${i}.txt`, { bytes: Buffer.from(`l${i}\nsecond\n`, "utf8"), mtimeMs: 1000 });
      lines.push(`? data/f-${i}.txt`);
    }
    return { files, lines };
  }

  test("2001 个未跟踪文件：第二轮一次都不读盘（原来 LRU 容量 2000，每轮全部落空）", async () => {
    const { files, lines } = manyFiles("/w-cliff", 2001);
    const counter = { opens: 0, bytes: 0 };
    const probe = fakeProbe(files, counter);
    const first = await gitWorkdirChanges(untrackedRunner(lines), "/w-cliff", probe);
    assert.equal(first.kind, "ok");
    if (first.kind !== "ok") return;
    assert.equal(first.entries.length, 2001);
    assert.ok(first.entries.every((entry) => entry.added === 2));
    assert.equal(counter.opens, 2001);

    const second = await gitWorkdirChanges(untrackedRunner(lines), "/w-cliff", probe);
    assert.equal(second.kind, "ok");
    if (second.kind !== "ok") return;
    assert.deepEqual(second.entries, first.entries);
    assert.equal(counter.opens, 2001, "第二轮应全部命中缓存");
  });

  test("缓存只留上一轮问到的：这一轮没出现的文件被忘掉（不无界增长）", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-forget/a.txt", { bytes: Buffer.from("a\n", "utf8"), mtimeMs: 1000 }],
      ["/w-forget/b.txt", { bytes: Buffer.from("b\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const counter = { opens: 0, bytes: 0 };
    const probe = fakeProbe(files, counter);
    await gitWorkdirChanges(untrackedRunner(["? a.txt", "? b.txt"]), "/w-forget", probe);
    assert.equal(counter.opens, 2);
    // a.txt 被删了（或被加进 .gitignore）：这一轮只有 b
    await gitWorkdirChanges(untrackedRunner(["? b.txt"]), "/w-forget", probe);
    assert.equal(counter.opens, 2, "b 没变，命中");
    // a.txt 又出现：缓存里已经没有它，重新数
    await gitWorkdirChanges(untrackedRunner(["? a.txt", "? b.txt"]), "/w-forget", probe);
    assert.equal(counter.opens, 3);
  });

  test("每轮最多数 5000 个：超出的这一轮报「行数未知」、不进缓存，下一轮接着数", async () => {
    const { files, lines } = manyFiles("/w-cap-files", 6000);
    const counter = { opens: 0, bytes: 0 };
    const probe = fakeProbe(files, counter);
    const unknownOf = (changes: Awaited<ReturnType<typeof gitWorkdirChanges>>) =>
      changes.kind === "ok" ? changes.entries.filter((entry) => entry.lineCountUnknown === true).length : -1;

    const first = await gitWorkdirChanges(untrackedRunner(lines), "/w-cap-files", probe);
    // 列表照样是全的（6000 个 U），只是后 1000 个这一轮没数
    assert.equal(first.kind === "ok" ? first.entries.length : -1, 6000);
    assert.deepEqual([counter.opens, unknownOf(first)], [5000, 1000]);

    const second = await gitWorkdirChanges(untrackedRunner(lines), "/w-cap-files", probe);
    assert.deepEqual([counter.opens, unknownOf(second)], [6000, 0]);

    const third = await gitWorkdirChanges(untrackedRunner(lines), "/w-cap-files", probe);
    assert.deepEqual([counter.opens, unknownOf(third)], [6000, 0]);
  });

  test("每轮最多读 256 MB：第五个 60 MB 的文件留到下一轮", async () => {
    const files = new Map<string, FakeFile>();
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      // 声明 60 MB（在计数上限之内）；内容只备一小段，读到 EOF 就停
      files.set(`/w-cap-bytes/big-${i}.log`, { bytes: Buffer.from("x\n", "utf8"), size: 60 * 1024 * 1024, mtimeMs: 1000 });
      lines.push(`? big-${i}.log`);
    }
    const counter = { opens: 0, bytes: 0 };
    const probe = fakeProbe(files, counter);
    const first = await gitWorkdirChanges(untrackedRunner(lines), "/w-cap-bytes", probe);
    assert.equal(first.kind, "ok");
    if (first.kind !== "ok") return;
    assert.equal(counter.opens, 4);
    assert.deepEqual(
      first.entries.map((entry) => entry.lineCountUnknown === true),
      [false, false, false, false, true],
    );
    const second = await gitWorkdirChanges(untrackedRunner(lines), "/w-cap-bytes", probe);
    assert.equal(second.kind, "ok");
    if (second.kind !== "ok") return;
    assert.equal(counter.opens, 5, "前四个命中缓存，预算留给第五个");
    assert.ok(second.entries.every((entry) => entry.lineCountUnknown !== true));
  });

  test("只记最近 8 个工作区的上一轮：第 9 个挤掉最早的那个", async () => {
    const counter = { opens: 0, bytes: 0 };
    const files = new Map<string, FakeFile>();
    for (let i = 0; i < 9; i++) files.set(`/w-ws-${i}/f.txt`, { bytes: Buffer.from("f\n", "utf8"), mtimeMs: 1000 });
    const probe = fakeProbe(files, counter);
    for (let i = 0; i < 9; i++) await gitWorkdirChanges(untrackedRunner(["? f.txt"]), `/w-ws-${i}`, probe);
    assert.equal(counter.opens, 9);
    // 最近的第 9 个还在
    await gitWorkdirChanges(untrackedRunner(["? f.txt"]), "/w-ws-8", probe);
    assert.equal(counter.opens, 9);
    // 最早的第 1 个已被挤掉：重新数
    await gitWorkdirChanges(untrackedRunner(["? f.txt"]), "/w-ws-0", probe);
    assert.equal(counter.opens, 10);
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
