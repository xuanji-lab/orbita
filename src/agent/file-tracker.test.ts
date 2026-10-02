import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveToCwd } from "@earendil-works/pi-coding-agent";
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

// Windows 上 resolve("/w") 会折到当前盘符根（如 C:\w），与工具实际行为一致；期望值一律用同一函数算
const CWD = resolve("/w");

describe("resolveToolPath", () => {
  test("@ 前缀剥离 + cwd 相对解析", () => {
    assert.equal(resolveToolPath("@src/a.ts", CWD), join(CWD, "src/a.ts"));
    assert.equal(resolveToolPath("a.ts", CWD), join(CWD, "a.ts"));
    // 平台原生绝对路径：已归一，原样返回
    assert.equal(resolveToolPath(join(CWD, "x/a.ts"), CWD), join(CWD, "x/a.ts"));
  });

  test("~ 展开与绝对路径", () => {
    assert.equal(resolveToolPath("~/x/a.ts", CWD), join(homedir(), "x", "a.ts"));
  });

  test("与 pi 的 resolveToCwd 是同一个函数（回退 / 撤销正确性的前提）", () => {
    // 手抄一份曾在 Windows 上与工具算出不同路径（MSYS / ~\ / file:// 三处缺口），
    // 回退静默失效。这里锁死「tracker 用的就是 pi write/edit 落盘用的那个函数」。
    assert.equal(resolveToolPath, resolveToCwd);
    const forms = [
      "a.ts",
      "src/deep/../b.ts",
      "@src/a.ts",
      "~",
      "~/x/a.ts",
      pathToFileURL(join(CWD, "f.ts")).href, // file:// URL
      join(CWD, "abs.txt"), // 平台原生绝对路径
      "/c/Users/x/a.ts", // win32 上折算成 C:\Users\x\a.ts；其它平台按 POSIX 绝对路径处理
      "/w/a.ts",
    ];
    for (const form of forms) {
      assert.equal(resolveToolPath(form, CWD), resolveToCwd(form, CWD), `form: ${form}`);
    }
  });
});

describe("TurnFileTracker", () => {
  test("正常路径：write 新文件，before absent → after 全量新增", async () => {
    let disk: Record<string, string> = {};
    const tracker = new TurnFileTracker(CWD, fakeFsProxy(() => disk));
    await tracker.noteAllowed("c1", "write", { path: "a.ts", content: "one\ntwo\nthree\n" });
    disk = { [join(CWD, "a.ts")]: "one\ntwo\nthree\n" };
    await tracker.noteExecutionEnd("c1");
    const changes = await tracker.finalize();
    assert.equal(changes.length, 1);
    const change = changes[0];
    assert.equal(change?.path, join(CWD, "a.ts"));
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
    const tracker = new TurnFileTracker(CWD, fakeFs({ [join(CWD, "a.ts")]: "same\n" }));
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
    const tracker = new TurnFileTracker(CWD, fakeFs({ [join(CWD, "big.txt")]: big, [join(CWD, "bin.png")]: "\u0000\u0001" }));
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
});

describe("字节口径：BOM 与 CRLF 原样进出快照", () => {
  // 自带路径与读盘闭包，避免与其它测试的 fakeFs / CWD 纠缠。
  // ROOT/FILE 必须经 resolve/join 归一：win32 上 resolveToCwd 会把 "/byte-snap/a.cs"
  // 折成当前盘符根的 "C:\\byte-snap\\a.cs"，与字面 POSIX 串永不相等，闭包就永远读不到文件
  const ROOT = resolve("/byte-snap");
  const FILE = join(ROOT, "a.cs");

  /** 可变单文件读盘：模拟 agent 改盘前后两次读。 */
  function mutableFile(initial: string): { read: (path: string) => Promise<ReadOutcome>; set: (next: string) => void } {
    let content = initial;
    return {
      read: async (path) => (path === FILE ? { exists: true, bytes: Buffer.from(content, "utf8") } : { exists: false }),
      set: (next) => {
        content = next;
      },
    };
  }

  test("带 BOM 的文件：快照正文保留开头的 U+FEFF，编码回去仍是 EF BB BF", async () => {
    const disk = mutableFile("\uFEFFold\n");
    const tracker = new TurnFileTracker(ROOT, disk.read);
    await tracker.noteAllowed("c1", "edit", { path: FILE });
    disk.set("\uFEFFagent v1\n");
    await tracker.noteExecutionEnd("c1");
    const changes = await tracker.finalize();
    assert.equal(changes.length, 1);
    const before = changes[0]?.before.kind === "text" ? changes[0].before.content : "";
    const after = changes[0]?.after.kind === "text" ? changes[0].after.content : "";
    assert.equal(before, "\uFEFFold\n");
    assert.equal(after, "\uFEFFagent v1\n");
    // 快照正文 utf8 编码回去必须等于盘上字节（还原写回的依据）
    assert.deepEqual([...Buffer.from(before, "utf8").subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  test("CRLF 行尾：快照原样保留 \\r\\n，行级统计按行算不乱", async () => {
    const disk = mutableFile("a\r\nb\r\n");
    const tracker = new TurnFileTracker(ROOT, disk.read);
    await tracker.noteAllowed("c1", "edit", { path: FILE });
    disk.set("a\r\nX\r\n");
    await tracker.noteExecutionEnd("c1");
    const changes = await tracker.finalize();
    assert.equal(changes.length, 1);
    const change = changes[0];
    assert.equal(change?.before.kind === "text" ? change.before.content : "", "a\r\nb\r\n");
    assert.equal(change?.after.kind === "text" ? change.after.content : "", "a\r\nX\r\n");
    assert.equal(change?.added, 1);
    assert.equal(change?.removed, 1);
  });
});
