/**
 * 未跟踪文件行数：专注左栏（gitWorkdirChanges）与审查面板（gitReviewList）共用
 * 同一个计数器 —— 缓存互相命中、超限两边都「未知」、同一文件两边给同一个数。
 *
 * 这里是跨两边的契约测试；计数器自己的字节级行为（口径 / 分块 / 上限 / 链接）在
 * untracked-lines.test.ts，单边的缓存行为在 focus-changes.test.ts。假 git + 假读盘面，不依赖真实磁盘。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gitReviewList, gitWorkdirChanges, type GitRunner } from "./git-source.ts";
import { GIT_BINARY_SNIFF_BYTES, UNTRACKED_LINE_COUNT_MAX_BYTES, type UntrackedProbe } from "./untracked-lines.ts";

interface FakeFile {
  bytes: Buffer;
  mtimeMs: number;
  /** 声明的 size；不填 = bytes.length（模拟几百 MB 不必真分配内存；读到 bytes 末尾就是 EOF） */
  size?: number;
}

/** 假读盘面（键是绝对路径）：io 断言「打开了几次、一共读了多少字节」 */
function probeOf(files: Map<string, FakeFile>, io?: { opens: number; bytes: number }): UntrackedProbe {
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

/** 未跟踪文件清单：同一个仓库同时认专注与审查两条 status 命令形态 */
function untrackedGit(path: string): GitRunner {
  const scripts: Record<string, string> = {
    "rev-parse --show-toplevel": "/w\n",
    "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all --no-renames": `? ${path}`,
    "-c status.relativePaths=true status --porcelain=v2 --untracked-files=all": `? ${path}`,
    "diff --no-renames --relative --numstat": "",
    "diff --cached --no-renames --relative --numstat": "",
    "rev-parse --abbrev-ref HEAD": "main\n",
  };
  return async (args) => {
    const hit = scripts[args.join(" ")];
    if (hit === undefined) throw new Error(`fake git: unexpected args "${args.join(" ")}"`);
    return { code: 0, stdout: hit };
  };
}

describe("未跟踪文件行数：专注与审查共用一份", () => {
  test("专注先数、审查复用缓存：不重新读盘，added 逐个相等", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-shared-focus/f.txt", { bytes: Buffer.from("a\nb\nc\n", "utf8"), mtimeMs: 1000 }],
    ]);
    const counter = { opens: 0, bytes: 0 };
    const probe = probeOf(files, counter);
    const runner = untrackedGit("f.txt");

    const focus = await gitWorkdirChanges(runner, "/w-shared-focus", probe);
    assert.equal(focus.kind, "ok");
    if (focus.kind !== "ok") return;
    assert.equal(focus.entries[0]?.added, 3);
    assert.equal(counter.opens, 1);

    const review = await gitReviewList(runner, "/w-shared-focus", "unstaged", probe);
    assert.equal(review.kind, "ok");
    if (review.kind !== "ok") return;
    // 审查面板不再整份读文件、不再造 diff 数 `+`：直接吃专注已经数好的结论
    assert.equal(review.entries.find((entry) => entry.path === "f.txt")?.added, 3);
    assert.equal(counter.opens, 1, "同一文件第二次问不该再读盘");
  });

  test("审查先数、专注复用缓存：反向同样命中", async () => {
    const files = new Map<string, FakeFile>([
      ["/w-shared-review/f.txt", { bytes: Buffer.from("one\ntwo", "utf8"), mtimeMs: 1000 }],
    ]);
    const counter = { opens: 0, bytes: 0 };
    const probe = probeOf(files, counter);
    const runner = untrackedGit("f.txt");

    const review = await gitReviewList(runner, "/w-shared-review", "unstaged", probe);
    assert.equal(review.kind, "ok");
    if (review.kind !== "ok") return;
    assert.equal(review.entries.find((entry) => entry.path === "f.txt")?.added, 2);
    assert.equal(counter.opens, 1);

    const focus = await gitWorkdirChanges(runner, "/w-shared-review", probe);
    assert.equal(focus.kind, "ok");
    if (focus.kind !== "ok") return;
    assert.equal(focus.entries[0]?.added, 2);
    assert.equal(counter.opens, 1, "专注侧同样复用审查已经数好的结论");
  });

  test("超过计数上限的文本：两边都只读开头 8000 字节、行数未知；第二次刷新零读盘", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/w-shared-50mb/huge.log",
        { bytes: Buffer.from("line one\nline two\n".repeat(1000), "utf8"), size: UNTRACKED_LINE_COUNT_MAX_BYTES + 1, mtimeMs: 1000 },
      ],
    ]);
    const counter = { opens: 0, bytes: 0 };
    const probe = probeOf(files, counter);
    const runner = untrackedGit("huge.log");

    const focus = await gitWorkdirChanges(runner, "/w-shared-50mb", probe);
    assert.equal(focus.kind, "ok");
    if (focus.kind !== "ok") return;
    assert.deepEqual(focus.entries, [
      { path: "huge.log", kind: "U", added: 0, removed: 0, binary: false, lineCountUnknown: true },
    ]);

    const review = await gitReviewList(runner, "/w-shared-50mb", "unstaged", probe);
    assert.equal(review.kind, "ok");
    if (review.kind !== "ok") return;
    assert.deepEqual(review.entries, [
      { path: "huge.log", added: 0, removed: 0, binary: false, lineCountUnknown: true },
    ]);

    // 两边共用一次读盘：只读了判二进制的 8000 字节，行数未知不拿 +0 冒充
    assert.deepEqual([counter.opens, counter.bytes], [1, GIT_BINARY_SNIFF_BYTES]);

    // 审查面板刷新（同一份 50 MB 文件）不再读盘
    const refreshed = await gitReviewList(runner, "/w-shared-50mb", "unstaged", probe);
    assert.equal(refreshed.kind, "ok");
    assert.equal(counter.opens, 1);
  });

  test("600 MB 未跟踪文件：不读全文、不数行，审查面板照样可用", async () => {
    const files = new Map<string, FakeFile>([
      [
        "/w-shared-600mb/dump.binlog",
        { bytes: Buffer.from("prefix\n", "utf8"), size: 600 * 1024 * 1024, mtimeMs: 1000 },
      ],
    ]);
    const counter = { opens: 0, bytes: 0 };
    const probe = probeOf(files, counter);

    const review = await gitReviewList(untrackedGit("dump.binlog"), "/w-shared-600mb", "unstaged", probe);
    assert.equal(review.kind, "ok");
    if (review.kind !== "ok") return;
    const entry = review.entries.find((item) => item.path === "dump.binlog");
    assert.deepEqual([entry?.added, entry?.binary, entry?.lineCountUnknown], [0, false, true]);
    // 内容只备了 7 字节：读到 EOF 就停，总共读进来的就是这 7 字节
    assert.deepEqual([counter.opens, counter.bytes], [1, 7]);
  });

  test("超大二进制：两边都标 binary、不带 unknown（binary 优先）", async () => {
    const head = Buffer.concat([Buffer.from([0x41, 0x00]), Buffer.alloc(256, 0x41)]);
    const files = new Map<string, FakeFile>([
      ["/w-shared-bin/blob.bin", { bytes: head, size: 20 * 1024 * 1024, mtimeMs: 1000 }],
    ]);
    const probe = probeOf(files);
    const runner = untrackedGit("blob.bin");

    const focus = await gitWorkdirChanges(runner, "/w-shared-bin", probe);
    assert.equal(focus.kind, "ok");
    if (focus.kind !== "ok") return;
    assert.deepEqual(focus.entries, [{ path: "blob.bin", kind: "U", added: 0, removed: 0, binary: true }]);

    const review = await gitReviewList(runner, "/w-shared-bin", "unstaged", probe);
    assert.equal(review.kind, "ok");
    if (review.kind !== "ok") return;
    assert.deepEqual(review.entries, [{ path: "blob.bin", added: 0, removed: 0, binary: true }]);
  });
});
