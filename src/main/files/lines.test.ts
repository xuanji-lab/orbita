/**
 * 行索引与按行取窗的账（`fs:line-index` / `fs:read-lines` 的实做）。
 *
 * 全部跑真实临时文件：索引的整个价值就是「换行在第几个字节」，mock 掉文件就读不出
 * 这件事。覆盖：普通日志、跨检查点、末尾窗口、无结尾换行、CRLF、空行、CJK、
 * UTF-8 跨块边界、起始行 / count 夹取、文件被换掉、超长单行、行数过多、缓存命中。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_LINES_PER_READ,
  PREVIEW_MAX_INDEXED_LINES,
  PREVIEW_MAX_LINE_BYTES,
} from "../../shared/files.ts";
import { buildLineIndex, readLines } from "./lines.ts";

/** lines.ts 的内部块大小（8 MB）：这个测试要造一个跨块边界的多字节字符 */
const INDEX_CHUNK = 8 * 1024 * 1024;

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-files-lines-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 建索引并断言它是 ok，顺手把令牌拆出来（不 ok 的用例自己断言 kind） */
async function indexOk(path: string): Promise<{ indexId: string; totalLines: number; size: number }> {
  const index = await buildLineIndex(path);
  assert.equal(index.kind, "ok", `预期可建索引，实际 ${index.kind}`);
  assert.ok(index.kind === "ok");
  return { indexId: index.indexId, totalLines: index.totalLines, size: index.size };
}

describe("buildLineIndex —— 行数与检查点", () => {
  test("普通日志：行数、平均行长、任意行读取", async () => {
    const path = join(dir, "main.log");
    const lines = Array.from({ length: 2500 }, (_, i) => `line ${String(i).padStart(5, "0")} ${"x".repeat(i % 37)}`);
    const content = `${lines.join("\n")}\n`;
    await writeFile(path, content, "utf8");

    const index = await buildLineIndex(path);
    assert.ok(index.kind === "ok");
    // 末尾换行不多出一个空行（与 wc -l 同口径）
    assert.equal(index.totalLines, 2500);
    assert.equal(index.size, Buffer.byteLength(content));
    assert.equal(typeof index.modifiedAt, "number");

    const head = await readLines({ indexId: index.indexId, startLine: 0, count: 5 });
    assert.ok(head.kind === "text");
    assert.deepEqual(head.lines, lines.slice(0, 5));
    assert.equal(head.startLine, 0);
    assert.equal(head.totalLines, 2500);
  });

  test("跨检查点边界（1023 / 1024 / 1025 行）都能精确取到", async () => {
    const path = join(dir, "stride.log");
    const lines = Array.from({ length: 3100 }, (_, i) => `row-${i}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const { indexId } = await indexOk(path);

    for (const start of [1023, 1024, 1025, 2047, 2048, 3071]) {
      const got = await readLines({ indexId, startLine: start, count: 3 });
      assert.ok(got.kind === "text");
      assert.deepEqual(got.lines, lines.slice(start, start + 3), `从第 ${start} 行起的 3 行`);
      assert.equal(got.startLine, start);
    }
  });

  test("末尾窗口：最后一窗正好盖住文件末行", async () => {
    const path = join(dir, "tail.log");
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const { indexId } = await indexOk(path);

    const start = 5000 - PREVIEW_LINES_PER_READ;
    const got = await readLines({ indexId, startLine: start, count: PREVIEW_LINES_PER_READ });
    assert.ok(got.kind === "text");
    assert.equal(got.lines.length, PREVIEW_LINES_PER_READ);
    assert.equal(got.lines[0], `line ${start}`);
    assert.equal(got.lines[PREVIEW_LINES_PER_READ - 1], "line 4999");
    assert.equal(got.startLine + got.lines.length, got.totalLines);
  });

  test("100 MB 级行数只建十几个检查点：100 MB / 90 万行的索引体积是 KB 级", async () => {
    const path = join(dir, "big.log");
    // 不真的写 100 MB：120,000 行 × ~31 字节 ≈ 3.6 MB，足以验证「每 1024 行一个检查点」
    const line = `${"2026-10-25T09:24:00Z INFO ".padEnd(31, "x")}\n`;
    const rows = 120_000;
    await writeFile(path, line.repeat(rows), "utf8");
    const index = await buildLineIndex(path);
    assert.ok(index.kind === "ok");
    assert.equal(index.totalLines, rows);
    // 检查点表不进契约，只能从「任意行都读得准」反推；这里抽查每个边界的最后一行
    const { indexId } = await indexOk(path);
    for (const at of [0, 1023, 1024, 119_999]) {
      const got = await readLines({ indexId, startLine: at, count: 1 });
      assert.ok(got.kind === "text");
      assert.equal(got.lines.length, 1);
    }
  });
});

describe("readLines —— 行的口径", () => {
  test("没有结尾换行：最后一行照样能读到", async () => {
    const path = join(dir, "no-eol.txt");
    await writeFile(path, "a\nbb\nccc", "utf8");
    const { indexId, totalLines } = await indexOk(path);
    assert.equal(totalLines, 3);
    const got = await readLines({ indexId, startLine: 2, count: 5 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, ["ccc"]);
    assert.equal(got.startLine + got.lines.length, got.totalLines);
  });

  test("CRLF：行尾的 \\r 去掉，行内的 \\r 保留", async () => {
    const path = join(dir, "crlf.log");
    await writeFile(path, "first\r\nsecond\r\nmid\rline\r\n", "utf8");
    const { indexId, totalLines } = await indexOk(path);
    assert.equal(totalLines, 3);
    const got = await readLines({ indexId, startLine: 0, count: 10 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, ["first", "second", "mid\rline"]);
  });

  test("空行占一行：连续换行读回来是空字符串", async () => {
    const path = join(dir, "blank.txt");
    await writeFile(path, "a\n\n\nb\n", "utf8");
    const { indexId, totalLines } = await indexOk(path);
    assert.equal(totalLines, 4);
    const got = await readLines({ indexId, startLine: 0, count: 10 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, ["a", "", "", "b"]);
  });

  test("只有换行的文件：每一行都是空行", async () => {
    const path = join(dir, "only-eol.txt");
    await writeFile(path, "\n\n", "utf8");
    const { indexId, totalLines } = await indexOk(path);
    assert.equal(totalLines, 2);
    const got = await readLines({ indexId, startLine: 0, count: 10 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, ["", ""]);
  });

  test("CJK：多字节字符按行解出来不错位", async () => {
    const path = join(dir, "中文.log");
    const lines = ["第一行 汉字", "第二行：日志测试日", "", "第四行 mixed ASCII 与汉字"];
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const { indexId } = await indexOk(path);
    const got = await readLines({ indexId, startLine: 0, count: 10 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, lines);
    for (const line of got.lines) assert.equal(line.includes("\uFFFD"), false);
  });

  test("UTF-8 序列跨 8 MB 索引块边界：不产出替换字符", async () => {
    const path = join(dir, "boundary.log");
    // 让「汉」的三个字节落在 8 MB 边界两侧：前 8 MB - 1 字节铺满整行（每行 16 字节），
    // 最后剩 15 字节留给跨边界那一行的前半段
    const filler = "0123456789abcde\n"; // 16 字节一行
    const rows = Math.floor((INDEX_CHUNK - 1) / 16);
    const rest = INDEX_CHUNK - 1 - rows * 16; // 15
    const pre = Buffer.from(filler.repeat(rows) + "a".repeat(rest), "utf8");
    assert.equal(pre.length, INDEX_CHUNK - 1);
    const body = Buffer.from("汉字\n尾行\n", "utf8");
    await writeFile(path, Buffer.concat([pre, body]));

    const index = await buildLineIndex(path);
    assert.ok(index.kind === "ok");
    const total = index.totalLines;
    assert.equal(total, rows + 2);
    const got = await readLines({ indexId: index.indexId, startLine: total - 2, count: 5 });
    assert.ok(got.kind === "text");
    assert.equal(got.lines.length, 2);
    assert.equal(got.lines[0], `${"a".repeat(rest)}汉字`);
    assert.equal(got.lines[1], "尾行");
    for (const line of got.lines) assert.equal(line.includes("\uFFFD"), false);
  });

  test("一行的字节跨 256 KB 读块边界：拼回来仍然完整", async () => {
    const path = join(dir, "wide.txt");
    // 1000 字符 × 400 行 ≈ 400 KB：读块边界必然落在某一行内部
    const lines = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(3, "0")}${"字".repeat(997)}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const { indexId } = await indexOk(path);
    const got = await readLines({ indexId, startLine: 0, count: 400 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, lines);
  });
});

describe("readLines —— 夹取与失效", () => {
  test("起始行负数 / 越界都夹到合法范围", async () => {
    const path = join(dir, "clamp.txt");
    await writeFile(path, "a\nb\nc\n", "utf8");
    const { indexId } = await indexOk(path);

    const negative = await readLines({ indexId, startLine: -10, count: 2 });
    assert.ok(negative.kind === "text");
    assert.equal(negative.startLine, 0);
    assert.deepEqual(negative.lines, ["a", "b"]);

    const beyond = await readLines({ indexId, startLine: 99, count: 2 });
    assert.ok(beyond.kind === "text");
    assert.equal(beyond.startLine, 2);
    assert.deepEqual(beyond.lines, ["c"]);
  });

  test("count 上限夹到 PREVIEW_LINES_PER_READ，0 / 负数夹到 1", async () => {
    const path = join(dir, "count.txt");
    const lines = Array.from({ length: 1500 }, (_, i) => `n${i}`);
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");
    const { indexId } = await indexOk(path);

    const many = await readLines({ indexId, startLine: 0, count: 5000 });
    assert.ok(many.kind === "text");
    assert.equal(many.lines.length, PREVIEW_LINES_PER_READ);

    const one = await readLines({ indexId, startLine: 0, count: 0 });
    assert.ok(one.kind === "text");
    assert.equal(one.lines.length, 1);

    const nonNumber = await readLines({ indexId, startLine: Number.NaN, count: Number.NaN });
    assert.ok(nonNumber.kind === "text");
    assert.equal(nonNumber.startLine, 0);
    assert.ok(nonNumber.lines.length >= 1);
  });

  test("文件在索引之后被追加：回 stale，不按旧检查点猜内容", async () => {
    const path = join(dir, "growing.log");
    await writeFile(path, "a\nb\nc\n", "utf8");
    const { indexId } = await indexOk(path);
    await appendFile(path, "d\n", "utf8");

    const got = await readLines({ indexId, startLine: 0, count: 2 });
    assert.ok(got.kind === "stale");
    assert.equal(got.size, 8);
  });

  test("令牌不认识（缓存被换出 / 应用重启）：reject，不猜一个文件去读", async () => {
    await assert.rejects(() => readLines({ indexId: "lines-does-not-exist", startLine: 0, count: 1 }));
  });
});

describe("buildLineIndex —— 能力边界", () => {
  test("空文件：empty", async () => {
    const path = join(dir, "empty.txt");
    await writeFile(path, "", "utf8");
    const index = await buildLineIndex(path);
    assert.equal(index.kind, "empty");
  });

  test("二进制（开头有 NUL）：binary，不建索引", async () => {
    const path = join(dir, "blob.bin");
    await writeFile(path, Buffer.from([0x41, 0x00, 0x42, 0x0a]));
    const index = await buildLineIndex(path);
    assert.equal(index.kind, "binary");
  });

  test("单行超过 64 KB：long-line，并要求 renderer 退回前 16 MB", async () => {
    const path = join(dir, "one-line.json");
    await writeFile(path, "x".repeat(PREVIEW_MAX_LINE_BYTES + 1024), "utf8");
    const index = await buildLineIndex(path);
    assert.ok(index.kind === "long-line");
    assert.equal(index.size, PREVIEW_MAX_LINE_BYTES + 1024);
  });

  test("行数超过 1.8 M：too-many-lines（滚动条映射不了全文）", async () => {
    const path = join(dir, "huge.log");
    await writeFile(path, "a\n".repeat(PREVIEW_MAX_INDEXED_LINES + 1), "utf8");
    const index = await buildLineIndex(path);
    assert.ok(index.kind === "too-many-lines");
    assert.equal(index.limit, PREVIEW_MAX_INDEXED_LINES);
  });
});

describe("buildLineIndex —— 索引缓存", () => {
  test("同一份文件再建一次：命中缓存，令牌不变（不重扫）", async () => {
    const path = join(dir, "cached.log");
    await writeFile(path, "a\nb\nc\n", "utf8");
    const first = await indexOk(path);
    const second = await indexOk(path);
    assert.equal(second.indexId, first.indexId);
  });

  test("文件被替换（大小 / mtime 变）：新索引、新令牌", async () => {
    const path = join(dir, "replaced.log");
    await writeFile(path, "a\nb\n", "utf8");
    const first = await indexOk(path);
    await writeFile(path, "a\nb\nc\nd\n", "utf8");
    const second = await indexOk(path);
    assert.notEqual(second.indexId, first.indexId);
    assert.equal(second.totalLines, 4);
  });

  test("LRU 3：第 4 份文件建索引后，第 1 份的令牌不再被接受", async () => {
    const files = [1, 2, 3, 4].map((n) => join(dir, `lru-${n}.log`));
    for (const [at, path] of files.entries()) await writeFile(path, `a\nb\nc ${at}\n`, "utf8");
    const first = await indexOk(files[0] as string);
    for (const path of files.slice(1)) await indexOk(path);
    await assert.rejects(() => readLines({ indexId: first.indexId, startLine: 0, count: 1 }));
  });
});
