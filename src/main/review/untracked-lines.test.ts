/**
 * 未跟踪文件计数器本身（untracked-lines.ts）：数法与 git numstat 同口径、按块流式读、
 * 二进制只看开头 8000 字节、超过上限只读开头、链接不跟。
 * 假读盘面测字节级行为；真磁盘 + 真 git 再对一遍 `git diff --numstat`。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitReviewList, gitWorkdirChanges, realGitRunner } from "./git-source.ts";
import {
  diskUntrackedProbe,
  GIT_BINARY_SNIFF_BYTES,
  UNTRACKED_LINE_COUNT_MAX_BYTES,
  untrackedLineStat,
  type UntrackedProbe,
} from "./untracked-lines.ts";

interface FakeFile {
  /** 内容：Buffer 原样；{ unit, size } = unit 循环铺到 size 字节（模拟几十 MB 不必真分配） */
  content: Buffer | { unit: string; size: number };
  /** 声明的 size（不填 = 内容长度）：比内容长 = 读的过程中文件变短 */
  size?: number;
  symlink?: string;
  /** 每次 read 最多给这么多字节（模拟网络盘的短读） */
  maxRead?: number;
}

function contentLength(file: FakeFile): number {
  return Buffer.isBuffer(file.content) ? file.content.length : file.content.size;
}

/** unit 铺成一块 ≥ 64 KB 的瓷砖（长度是 unit 的整数倍，从任何偏移接着拷都还是同一个花样） */
function tileOf(unit: string): Buffer {
  const one = Buffer.from(unit, "utf8");
  return Buffer.concat(new Array<Buffer>(Math.ceil(65_536 / one.length)).fill(one));
}

/** 把 [position, position + length) 这段内容拷进 buffer 开头，返回拷了多少 */
function copyOut(file: FakeFile, buffer: Buffer, length: number, position: number): number {
  const end = Math.min(position + length, contentLength(file));
  if (position >= end) return 0;
  if (Buffer.isBuffer(file.content)) return file.content.copy(buffer, 0, position, end);
  const unitLength = Buffer.byteLength(file.content.unit, "utf8");
  const tile = tileOf(file.content.unit);
  const total = end - position;
  let written = 0;
  while (written < total) {
    const at = (position + written) % unitLength;
    written += tile.copy(buffer, written, at, Math.min(tile.length, at + total - written));
  }
  return total;
}

function fakeProbe(files: Map<string, FakeFile>, io: { opens: number; bytes: number; reads: number }): UntrackedProbe {
  return {
    async lstat(path) {
      const file = files.get(path);
      if (file === undefined) return null;
      return { kind: file.symlink !== undefined ? "symlink" : "file", size: file.size ?? contentLength(file), mtimeMs: 1 };
    },
    async readlink(path) {
      return files.get(path)?.symlink ?? null;
    },
    async open(path) {
      const file = files.get(path);
      if (file === undefined || file.symlink !== undefined) return null;
      io.opens += 1;
      return {
        async read(buffer, length, position) {
          io.reads += 1;
          const got = copyOut(file, buffer, Math.min(length, file.maxRead ?? length), position);
          io.bytes += got;
          return got;
        },
        async close() {},
      };
    },
  };
}

/** 参照实现：git numstat 对新文件的口径（换行字节数，最后一行没换行再 +1） */
function referenceLines(bytes: Buffer): number {
  let lines = 0;
  for (const byte of bytes) if (byte === 0x0a) lines += 1;
  return bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a ? lines + 1 : lines;
}

let seq = 0;
/** 每个用例自己的路径（计数器缓存是模块级的，同路径同 size 会命中上一个用例的结论） */
function uniquePath(name: string): string {
  seq += 1;
  return `/w-lines-${seq}/${name}`;
}

async function statOf(file: FakeFile) {
  const path = uniquePath("f");
  const io = { opens: 0, bytes: 0, reads: 0 };
  const stat = await untrackedLineStat(path, fakeProbe(new Map([[path, file]]), io));
  return { stat, io };
}

describe("untrackedLineStat：数法与 git numstat 同口径", () => {
  const cases: Array<[string, Buffer, number]> = [
    ["空文件", Buffer.alloc(0), 0],
    ["只有一个换行", Buffer.from("\n"), 1],
    ["一行、没有结尾换行", Buffer.from("a"), 1],
    ["一行、有结尾换行", Buffer.from("a\n"), 1],
    ["两行、最后一行没换行（wc -l 会说 1）", Buffer.from("a\nb"), 2],
    ["CRLF 算一行", Buffer.from("a\r\nb\r\n"), 2],
    ["单独的 CR 不算换行（同 git）", Buffer.from("a\rb\r"), 1],
    // main 上的旧写法把这三行数成 1：造 diff 后 `++i;` 变成 `+++i;`，被当成文件头跳过
    ["以 ++ / +++ 开头的行", Buffer.from("+++ b/x\n++i;\nplain\n"), 3],
    ["多字节 UTF-8", Buffer.from("中文\n第二行", "utf8"), 2],
  ];
  for (const [name, bytes, expected] of cases) {
    test(name, async () => {
      const { stat } = await statOf({ content: bytes });
      assert.deepEqual(stat, { added: expected, binary: false });
    });
  }

  test("NUL 落在开头 8000 字节里 → 二进制；第 8001 字节才有 NUL → 文本照数（git 只看前 8000）", async () => {
    const atEdge = Buffer.alloc(GIT_BINARY_SNIFF_BYTES + 100, 0x61);
    atEdge[GIT_BINARY_SNIFF_BYTES - 1] = 0;
    assert.deepEqual((await statOf({ content: atEdge })).stat, { added: 0, binary: true });

    // main 上的旧写法对整份文件找 NUL，这种文件被整份当成二进制（git numstat 实测 5002 行）
    const late = Buffer.concat([Buffer.from("a\n".repeat(5000)), Buffer.from([0]), Buffer.from("\nz\n")]);
    assert.ok(late.indexOf(0) >= GIT_BINARY_SNIFF_BYTES);
    assert.deepEqual((await statOf({ content: late })).stat, { added: 5002, binary: false });
  });

  test("跨块：换行落在块边界上、最后一块没有换行，都数得对", async () => {
    // 256 KB 一块：让第一块的最后一个字节恰好是换行，文件以不带换行的半行结尾
    const blockSize = 256 * 1024;
    const body = Buffer.alloc(blockSize * 2 + 37, 0x78);
    for (let i = 99; i < body.length - 10; i += 100) body[i] = 0x0a;
    body[blockSize - 1] = 0x0a;
    const { stat, io } = await statOf({ content: body });
    assert.deepEqual(stat, { added: referenceLines(body), binary: false });
    assert.equal(io.bytes, body.length, "文本要从头读到尾、每个字节只读一次");
  });

  test("read 读得比要的少（网络盘的短读）也数得对，判二进制的窗口照样读满", async () => {
    const text = Buffer.from("abc\n".repeat(5000));
    const { stat } = await statOf({ content: text, maxRead: 1000 });
    assert.deepEqual(stat, { added: 5000, binary: false });
    // NUL 在第 7000 字节：短读时也必须读满 8000 字节的窗口才判得出二进制
    const bin = Buffer.alloc(9000, 0x61);
    bin[7000] = 0;
    assert.deepEqual((await statOf({ content: bin, maxRead: 1000 })).stat, { added: 0, binary: true });
  });

  test("lstat 之后文件变短：数到 EOF 为止，不抛、不卡", async () => {
    const { stat } = await statOf({ content: Buffer.from("a\nb\n"), size: 10_000 });
    assert.deepEqual(stat, { added: 2, binary: false });
  });
});

describe("untrackedLineStat：上限、链接", () => {
  test("正好等于上限照数；多 1 字节就只读开头 8000 字节、行数未知", async () => {
    const unit = "x".repeat(63) + "\n"; // 64 字节一行，上限 64 MB 正好整除
    const atLimit = await statOf({ content: { unit, size: UNTRACKED_LINE_COUNT_MAX_BYTES } });
    assert.deepEqual(atLimit.stat, { added: UNTRACKED_LINE_COUNT_MAX_BYTES / 64, binary: false });

    const over = await statOf({ content: { unit, size: 20_000 }, size: UNTRACKED_LINE_COUNT_MAX_BYTES + 1 });
    assert.deepEqual(over.stat, { added: 0, binary: false, lineCountUnknown: true });
    assert.deepEqual([over.io.opens, over.io.bytes], [1, GIT_BINARY_SNIFF_BYTES]);
  });

  test("600 MB 的二进制：只读开头 8000 字节", async () => {
    const head = Buffer.alloc(GIT_BINARY_SNIFF_BYTES * 2, 0x41);
    head[1] = 0;
    const { stat, io } = await statOf({ content: head, size: 600 * 1024 * 1024 });
    assert.deepEqual(stat, { added: 0, binary: true });
    assert.deepEqual([io.opens, io.bytes], [1, GIT_BINARY_SNIFF_BYTES]);
  });

  test("符号链接：不打开、不数目标，只报链接里写的目标", async () => {
    const { stat, io } = await statOf({ content: Buffer.from("TARGET\n"), symlink: "../outside/secret.txt" });
    assert.deepEqual(stat, { added: 0, binary: false, symlink: "../outside/secret.txt" });
    assert.equal(io.opens, 0);
  });
});

// ————————————————————————————————————————————————
// 真磁盘：读盘面不跟链接；600 MB 稀疏文件只读开头。真 git：行数与 numstat 逐个相等
// ————————————————————————————————————————————————

/** 包一层真读盘面，记打开次数与读到的字节数 */
function countingDiskProbe(io: { opens: number; bytes: number }): UntrackedProbe {
  return {
    lstat: (path) => diskUntrackedProbe.lstat(path),
    readlink: (path) => diskUntrackedProbe.readlink(path),
    async open(path) {
      const handle = await diskUntrackedProbe.open(path);
      if (handle === null) return null;
      io.opens += 1;
      return {
        async read(buffer, length, position) {
          const got = await handle.read(buffer, length, position);
          io.bytes += got;
          return got;
        },
        close: () => handle.close(),
      };
    },
  };
}

describe("diskUntrackedProbe × 真磁盘", () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "orbita-untracked-disk-"));
  });
  after(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });

  test("符号链接：lstat 报 symlink 与目标；open 打不开链接（POSIX 的 O_NOFOLLOW）", async (t) => {
    await writeFile(join(dir, "target.txt"), "TARGET\n");
    try {
      await symlink(join(dir, "target.txt"), join(dir, "link.txt"), "file");
    } catch {
      return t.skip("这台机器建不了文件符号链接");
    }
    assert.equal((await diskUntrackedProbe.lstat(join(dir, "link.txt")))?.kind, "symlink");
    assert.equal(await diskUntrackedProbe.readlink(join(dir, "link.txt")), join(dir, "target.txt"));
    if (process.platform === "win32") return t.skip("Windows 没有 O_NOFOLLOW，靠 lstat 判定");
    assert.equal(await diskUntrackedProbe.open(join(dir, "link.txt")), null);
  });

  test("600 MB 稀疏文件（二进制 / 文本开头各一个）：一轮只读开头 8000 字节", async (t) => {
    // 稀疏文件不真占 600 MB 盘；NTFS 默认不稀疏，Windows 上跳过
    if (process.platform === "win32") return t.skip("NTFS 上 truncate 会真分配空间");
    const repo = await mkdtemp(join(tmpdir(), "orbita-untracked-sparse-"));
    try {
      await realGitRunner(["init"], repo);
      const binary = await open(join(repo, "model.bin"), "w");
      await binary.truncate(600 * 1024 * 1024); // 全是 0 → 开头就有 NUL
      await binary.close();
      const text = await open(join(repo, "dump.log"), "w");
      await text.write(Buffer.from("line\n".repeat(4000)));
      await text.truncate(600 * 1024 * 1024); // 开头 20000 字节是文本，后面是洞
      await text.close();
      const io = { opens: 0, bytes: 0 };
      const changes = await gitWorkdirChanges(realGitRunner, repo, countingDiskProbe(io));
      assert.equal(changes.kind, "ok");
      if (changes.kind !== "ok") return;
      const byPath = new Map(changes.entries.map((entry) => [entry.path, entry]));
      assert.equal(byPath.get("model.bin")?.binary, true);
      assert.deepEqual(
        [byPath.get("dump.log")?.binary, byPath.get("dump.log")?.lineCountUnknown],
        [false, true],
      );
      assert.deepEqual([io.opens, io.bytes], [2, 2 * GIT_BINARY_SNIFF_BYTES]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe("行数与 git diff --numstat 一致（真 git + 真磁盘）", () => {
  let repo: string | null = null;
  const files: Record<string, Buffer> = {
    "plusplus.diff": Buffer.from("+++ b/x\n++i;\nplain\n"),
    "late-nul.txt": Buffer.concat([Buffer.from("a\n".repeat(5000)), Buffer.from([0]), Buffer.from("\nz\n")]),
    "no-eol.txt": Buffer.from("a\nb"),
    "crlf.txt": Buffer.from("a\r\nb\r\n"),
    "only-cr.txt": Buffer.from("a\rb\r"),
    "blank-lines.txt": Buffer.from("\n".repeat(3000)),
    "utf8.md": Buffer.from("# 标题\n正文\n", "utf8"),
    // 1 MB 以上：以前一律「行数未知」，现在照数
    "mid-1_5mb.log": Buffer.from(("x".repeat(98) + "\n").repeat(16_000)),
    "short-lines-3mb.csv": Buffer.from("1\n".repeat(1_500_000)),
    "empty.txt": Buffer.alloc(0),
  };

  before(async () => {
    const hasGit = await realGitRunner(["--version"], tmpdir()).then(
      () => true,
      () => false,
    );
    if (!hasGit) return;
    repo = await mkdtemp(join(tmpdir(), "orbita-untracked-numstat-"));
    await realGitRunner(["init"], repo);
    await realGitRunner(["config", "core.autocrlf", "false"], repo);
    for (const [name, bytes] of Object.entries(files)) await writeFile(join(repo, name), bytes);
  });

  after(async () => {
    if (repo !== null) await rm(repo, { recursive: true, force: true });
  });

  /** git 自己数的：对着空文件 diff --no-index（不碰 index，也不必 add -N） */
  async function gitNumstat(dir: string, name: string): Promise<number | "binary"> {
    await writeFile(join(dir, "..", `orbita-empty-${process.pid}`), "");
    const result = await realGitRunner(
      ["diff", "--no-index", "--numstat", "--", join(dir, "..", `orbita-empty-${process.pid}`), join(dir, name)],
      dir,
    );
    const [added] = result.stdout.trim().split("\t");
    if (added === "-") return "binary";
    return added === undefined || added === "" ? 0 : Number(added);
  }

  test("专注左栏与审查面板：每个可计数的文本文件都等于 git numstat", async (t) => {
    if (repo === null) return t.skip("环境没有 git");
    const changes = await gitWorkdirChanges(realGitRunner, repo);
    const list = await gitReviewList(realGitRunner, repo, "unstaged");
    assert.equal(changes.kind, "ok");
    assert.equal(list.kind, "ok");
    if (changes.kind !== "ok" || list.kind !== "ok") return;
    const focusBy = new Map(changes.entries.map((entry) => [entry.path, entry]));
    const reviewBy = new Map(list.entries.map((entry) => [entry.path, entry]));
    try {
      for (const name of Object.keys(files)) {
        const expected = await gitNumstat(repo, name);
        const focus = focusBy.get(name);
        const review = reviewBy.get(name);
        const actual = (entry: { binary: boolean; added: number } | undefined) =>
          entry === undefined ? "missing" : entry.binary ? "binary" : entry.added;
        assert.equal(actual(focus), expected, `${name}：专注左栏 ${actual(focus)}，git numstat ${expected}`);
        assert.equal(actual(review), expected, `${name}：审查面板 ${actual(review)}，git numstat ${expected}`);
        assert.equal(focus?.lineCountUnknown, undefined, `${name} 不该是「行数未知」`);
      }
    } finally {
      await rm(join(repo, "..", `orbita-empty-${process.pid}`), { force: true });
    }
  });
});
