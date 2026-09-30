import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { TurnFileTracker, resolveToolPath, type ReadOutcome } from "./file-tracker.ts";

/** 假文件系统：path → 字节（Buffer.from）；不在表里 = 文件不存在。 */
function fakeFs(files: Record<string, string>): (path: string) => Promise<ReadOutcome> {
  return fakeFsProxy(() => files);
}

/** 可变快照版（模拟「先不在、写完在」的时序）。 */
function fakeFsProxy(current: () => Record<string, string>): (path: string) => Promise<ReadOutcome> {
  return async (path) => {
    const content = Object.entries(current()).find(([key]) => key === path)?.[1];
    if (content === undefined) return { exists: false };
    return { exists: true, bytes: Buffer.from(content, "utf8") };
  };
}

const CWD = "/w";

describe("resolveToolPath", () => {
  test("@ 前缀剥离 + cwd 相对解析", () => {
    assert.equal(resolveToolPath("@src/a.ts", CWD), "/w/src/a.ts");
    assert.equal(resolveToolPath("a.ts", CWD), "/w/a.ts");
    assert.equal(resolveToolPath("/x/a.ts", CWD), "/x/a.ts");
  });
});

describe("TurnFileTracker", () => {
  test("正常路径：write 新文件，before absent → after 全量新增", async () => {
    let disk: Record<string, string> = {};
    const tracker = new TurnFileTracker(CWD, fakeFsProxy(() => disk));
    await tracker.noteAllowed("c1", "write", { path: "a.ts", content: "one\ntwo\nthree\n" });
    disk = { "/w/a.ts": "one\ntwo\nthree\n" };
    await tracker.noteExecutionEnd("c1");
    const changes = await tracker.finalize();
    assert.equal(changes.length, 1);
    const change = changes[0];
    assert.equal(change?.path, "/w/a.ts");
    assert.deepEqual(change?.before, { kind: "absent" });
    assert.deepEqual(change?.after, { kind: "text", content: "one\ntwo\nthree\n" });
    assert.equal(change?.added, 3);
    assert.equal(change?.removed, 0);
  });

  test("同一路径一轮多次改动：before 留最早、after 留最后", async () => {
    let content: string | null = "v0\n";
    const tracker = new TurnFileTracker(CWD, async () => ({
      exists: true,
      bytes: content === null ? null : Buffer.from(content, "utf8"),
    }));
    await tracker.noteAllowed("c1", "edit", { path: "a.ts" });
    content = "v1\n";
    await tracker.noteExecutionEnd("c1");
    await tracker.noteAllowed("c2", "edit", { path: "a.ts" });
    content = "v2 final\n";
    await tracker.noteExecutionEnd("c2");
    const changes = await tracker.finalize();
    assert.deepEqual(changes[0]?.before, { kind: "text", content: "v0\n" });
    assert.deepEqual(changes[0]?.after, { kind: "text", content: "v2 final\n" });
  });

  test("并行批的同文件两个调用：before 只读一次（prepare 顺序）", async () => {
    let reads = 0;
    const tracker = new TurnFileTracker(CWD, async (path) => {
      reads += 1;
      return { exists: true, bytes: Buffer.from("x\n", "utf8") };
    });
    await tracker.noteAllowed("c1", "write", { path: "same.ts" });
    await tracker.noteAllowed("c2", "write", { path: "same.ts" });
    assert.equal(reads, 1);
    await tracker.noteExecutionEnd("c1");
    await tracker.noteExecutionEnd("c2");
    assert.equal((await tracker.finalize()).length, 0); // before == after → 丢弃
  });

  test("before == after 的路径整个丢弃（没有真实改动）", async () => {
    const tracker = new TurnFileTracker(CWD, fakeFs({ "/w/a.ts": "same\n" }));
    await tracker.noteAllowed("c1", "edit", { path: "a.ts" });
    await tracker.noteExecutionEnd("c1");
    assert.deepEqual(await tracker.finalize(), []);
  });

  test("非 write/edit 工具不记；路径缺 target 不记", async () => {
    const tracker = new TurnFileTracker(CWD, fakeFs({}));
    await tracker.noteAllowed("c1", "bash", { command: "echo hi" });
    await tracker.noteAllowed("c2", "write", {});
    assert.deepEqual(await tracker.finalize(), []);
  });

  test(">1MB 或二进制：unrecoverable，照常出现在账里（卡片计数、回退标无法回退）", async () => {
    const big = "a".repeat(1024 * 1024 + 1);
    const tracker = new TurnFileTracker(CWD, fakeFs({ "/w/big.txt": big, "/w/bin.png": "\u0000\u0001" }));
    await tracker.noteAllowed("c1", "write", { path: "big.txt" });
    await tracker.noteExecutionEnd("c1");
    await tracker.noteAllowed("c2", "write", { path: "bin.png" });
    await tracker.noteExecutionEnd("c2");
    const changes = await tracker.finalize();
    assert.equal(changes.length, 2);
    assert.equal(changes[0]?.after.kind, "unrecoverable");
    assert.equal(changes[1]?.before.kind, "unrecoverable");
  });

  test("文件被删除（after absent）：照实记，回退时还原内容", async () => {
    let exists = true;
    const tracker = new TurnFileTracker(CWD, async () => (exists ? { exists: true, bytes: Buffer.from("old\n") } : { exists: false }));
    await tracker.noteAllowed("c1", "write", { path: "gone.txt" });
    exists = false;
    await tracker.noteExecutionEnd("c1");
    const changes = await tracker.finalize();
    assert.deepEqual(changes[0]?.before, { kind: "text", content: "old\n" });
    assert.deepEqual(changes[0]?.after, { kind: "absent" });
    assert.equal(changes[0]?.removed, 1);
  });

  test("~ 展开与绝对路径", () => {
    assert.equal(resolveToolPath("~/x/a.ts", CWD), `${homedir()}/x/a.ts`);
  });
});
