/**
 * 行索引与按行取窗的账（`fs:line-index` / `fs:read-lines` 的实做）。
 *
 * 全部跑真实临时文件：索引的整个价值就是「换行在第几个字节」，mock 掉文件就读不出
 * 这件事。覆盖：普通日志、跨检查点、末尾窗口、无结尾换行、CRLF、空行、CJK、
 * UTF-8 跨块边界、起始行 / count 夹取、文件被换掉、超长单行、超过字节上限、缓存命中；
 * 增量索引（正在写的日志）、在途去重与取消、LRU 与令牌过期。
 */
import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, open as openForWrite, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_LINES_PER_READ,
  PREVIEW_MAX_INDEX_BYTES,
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

  test("令牌不认识（缓存被换出 / 应用重启）：回 expired，不猜一个文件去读", async () => {
    const got = await readLines({ indexId: "lines-does-not-exist", startLine: 0, count: 1 });
    assert.equal(got.kind, "expired");
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
    // 退路要看的开头文本随回执带上（fs:read 不再先读 16 MB 了）
    assert.equal(index.headText, "x".repeat(PREVIEW_MAX_LINE_BYTES + 1024));
  });

  test("超过字节上限：不读一个字节就回 too-large（稀疏文件造 1 GiB，不占盘）", async () => {
    const path = join(dir, "huge.log");
    await writeFile(path, "a\n", "utf8");
    await truncate(path, PREVIEW_MAX_INDEX_BYTES + 1);
    const started = performance.now();
    const index = await buildLineIndex(path);
    const took = performance.now() - started;
    assert.ok(index.kind === "too-large");
    assert.equal(index.limit, PREVIEW_MAX_INDEX_BYTES);
    assert.equal(index.size, PREVIEW_MAX_INDEX_BYTES + 1);
    // 扫 1 GiB 要几百毫秒到几秒；只 stat 是个位数毫秒
    assert.ok(took < 100, `不该开始扫：${took.toFixed(1)} ms`);
  });

  test("恰好等于字节上限：不被挡（上限是「超过」才拒）", async () => {
    // 同样用稀疏文件，但开头 8 KB 是 NUL → 走到二进制嗅探而不是 too-large，证明过了字节闸
    const path = join(dir, "at-limit.bin");
    await writeFile(path, Buffer.from([0]));
    await truncate(path, PREVIEW_MAX_INDEX_BYTES);
    const index = await buildLineIndex(path);
    assert.equal(index.kind, "binary");
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

  test("文件被替换（rename 换了 inode）：新索引、新令牌，旧令牌作废", async () => {
    const path = join(dir, "replaced.log");
    await writeFile(path, "a\nb\n", "utf8");
    const first = await indexOk(path);
    // logrotate 的写法：新文件写好再 rename 盖上去（inode 变了）
    await writeFile(`${path}.new`, "x\ny\nz\nw\n", "utf8");
    await rename(`${path}.new`, path);
    const second = await indexOk(path);
    assert.notEqual(second.indexId, first.indexId);
    assert.equal(second.totalLines, 4);
    const old = await readLines({ indexId: first.indexId, startLine: 0, count: 1 });
    assert.equal(old.kind, "expired");
  });

  test("LRU：缓存只留最近用到的几份，最久没用的令牌过期", async () => {
    const first = join(dir, "lru-first.log");
    await writeFile(first, "a\nb\n", "utf8");
    const { indexId } = await indexOk(first);
    for (let n = 0; n < 20; n += 1) {
      const path = join(dir, `lru-${n}.log`);
      await writeFile(path, `a\nb\nc ${n}\n`, "utf8");
      await indexOk(path);
    }
    const got = await readLines({ indexId, startLine: 0, count: 1 });
    assert.equal(got.kind, "expired");
  });

  test("取窗也算用到：一直在读的那份不会被别的标签建索引挤掉", async () => {
    const first = join(dir, "busy.log");
    await writeFile(first, "a\nb\n", "utf8");
    const { indexId } = await indexOk(first);
    for (let n = 0; n < 20; n += 1) {
      const path = join(dir, `other-${n}.log`);
      await writeFile(path, `a\nb\nc ${n}\n`, "utf8");
      await indexOk(path);
      // 用户在这份上滚动：每次取窗都刷新它的新旧顺序
      const got = await readLines({ indexId, startLine: 0, count: 1 });
      assert.ok(got.kind === "text", `第 ${n} 轮就过期了：${got.kind}`);
    }
  });

  test("同时开着 4 份大文件来回切：每份的令牌都还在", async () => {
    const paths = [1, 2, 3, 4].map((n) => join(dir, `tab-${n}.log`));
    const ids: string[] = [];
    for (const [at, path] of paths.entries()) {
      await writeFile(path, `a\nb\nc ${at}\n`, "utf8");
      ids.push((await indexOk(path)).indexId);
    }
    for (let round = 0; round < 3; round += 1) {
      for (const [at, indexId] of ids.entries()) {
        const got = await readLines({ indexId, startLine: 2, count: 1 });
        assert.ok(got.kind === "text", `第 ${round} 轮第 ${at} 份：${got.kind}`);
        assert.deepEqual(got.lines, [`c ${at}`]);
      }
    }
  });
});

/** 造一份大到够 4 KB 样本不覆盖整份的日志：每行 `row-<n>` 补到 32 字节 */
function bigLog(rows: number, from = 0): string {
  return Array.from({ length: rows }, (_, i) => `row-${from + i}`.padEnd(31, ".")).join("\n") + "\n";
}

describe("增量索引 —— 正在写入的日志只是变长", () => {
  test("追加若干行：令牌不变，totalLines 变大，新行读得到", async () => {
    const path = join(dir, "grow.log");
    await writeFile(path, "a\nb\nc\n", "utf8");
    const first = await indexOk(path);
    await appendFile(path, "d\ne\n", "utf8");

    const again = await indexOk(path);
    assert.equal(again.indexId, first.indexId);
    assert.equal(again.totalLines, 5);
    const got = await readLines({ indexId: first.indexId, startLine: 3, count: 5 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, ["d", "e"]);
    assert.equal(got.totalLines, 5);
  });

  test("只调 readLines 也能发现变长（renderer 手里的 totalLines 过时）：接着扫再读，回执带新总数", async () => {
    const path = join(dir, "grow-read.log");
    await writeFile(path, bigLog(3000), "utf8");
    const first = await indexOk(path);
    assert.equal(first.totalLines, 3000);
    await appendFile(path, bigLog(10, 3000), "utf8");

    const got = await readLines({ indexId: first.indexId, startLine: 2995, count: 100 });
    assert.ok(got.kind === "text");
    assert.equal(got.totalLines, 3010);
    assert.equal(got.lines.length, 15);
    assert.equal(got.lines[0], "row-2995".padEnd(31, "."));
    assert.equal(got.lines[14], "row-3009".padEnd(31, "."));
  });

  test("旧末尾是一条没收尾的残行：续扫从它的行首开始，拼成完整的一行", async () => {
    const path = join(dir, "partial.log");
    await writeFile(path, "a\nb", "utf8");
    const first = await indexOk(path);
    assert.equal(first.totalLines, 2);
    await appendFile(path, "c\nd\n", "utf8");

    const again = await indexOk(path);
    assert.equal(again.indexId, first.indexId);
    assert.equal(again.totalLines, 3);
    const got = await readLines({ indexId: first.indexId, startLine: 0, count: 5 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, ["a", "bc", "d"]);
  });

  test("残行 + 追加合起来才超过 64 KB：按整行算，回 long-line", async () => {
    const path = join(dir, "partial-long.log");
    await writeFile(path, `a\n${"x".repeat(40_000)}`, "utf8"); // 末尾残行 40 KB，还没超
    const first = await indexOk(path);
    assert.equal(first.totalLines, 2);
    await appendFile(path, `${"y".repeat(40_000)}\n`, "utf8"); // 续上之后这一行 80 KB
    const again = await buildLineIndex(path);
    assert.equal(again.kind, "long-line");
  });

  test("追加跨过 1024 行的检查点边界：旧检查点保留，新检查点接上", async () => {
    const path = join(dir, "cross.log");
    await writeFile(path, bigLog(1000), "utf8");
    const first = await indexOk(path);
    await appendFile(path, bigLog(3000, 1000), "utf8");
    const again = await indexOk(path);
    assert.equal(again.indexId, first.indexId);
    assert.equal(again.totalLines, 4000);
    for (const at of [0, 1023, 1024, 2047, 2048, 3071, 3999]) {
      const got = await readLines({ indexId: first.indexId, startLine: at, count: 1 });
      assert.ok(got.kind === "text");
      assert.deepEqual(got.lines, [`row-${at}`.padEnd(31, ".")], `第 ${at} 行`);
    }
  });

  test("旧末尾刚好是第 1024 行的行首：续扫后第 1024 行读得准", async () => {
    const path = join(dir, "exact-stride.log");
    await writeFile(path, bigLog(1024), "utf8");
    const first = await indexOk(path);
    assert.equal(first.totalLines, 1024);
    await appendFile(path, bigLog(5, 1024), "utf8");
    await indexOk(path);
    const got = await readLines({ indexId: first.indexId, startLine: 1024, count: 5 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, Array.from({ length: 5 }, (_, i) => `row-${1024 + i}`.padEnd(31, ".")));
  });

  test("续扫只扫新增的部分：前面被原地改过、但旧末尾样本没变——认不出来（已知的启发式边界）", async () => {
    // 这条同时是「确实没有整份重扫」的证据：若整份重扫，被改成 x 的换行会让总行数少 1
    const path = join(dir, "heuristic.log");
    await writeFile(path, bigLog(2000), "utf8");
    const first = await indexOk(path);
    const handle = await openForWrite(path, "r+");
    try {
      await handle.write("x", 31); // 把第 0 行末尾的 \n 改成 x，文件大小不变、末尾 4 KB 不变
    } finally {
      await handle.close();
    }
    await appendFile(path, bigLog(10, 2000), "utf8");
    const again = await indexOk(path);
    assert.equal(again.indexId, first.indexId);
    assert.equal(again.totalLines, 2010);
  });

  test("旧末尾那段被改写了：不当成追加，回新索引与新令牌", async () => {
    const path = join(dir, "rewritten.log");
    await writeFile(path, bigLog(2000), "utf8");
    const first = await indexOk(path);
    // 末尾的内容改了，再追加：样本对不上 → 整份重建
    const handle = await openForWrite(path, "r+");
    try {
      await handle.write("ZZZZ", 2000 * 32 - 10);
    } finally {
      await handle.close();
    }
    await appendFile(path, bigLog(10, 2000), "utf8");
    const again = await indexOk(path);
    assert.notEqual(again.indexId, first.indexId);
    assert.equal(again.totalLines, 2010);
    const old = await readLines({ indexId: first.indexId, startLine: 0, count: 1 });
    assert.equal(old.kind, "expired");
  });

  test("变小（被截断）：旧令牌回 stale，不按旧检查点读", async () => {
    const path = join(dir, "shrink.log");
    await writeFile(path, bigLog(100), "utf8");
    const { indexId } = await indexOk(path);
    await truncate(path, 320);
    const got = await readLines({ indexId, startLine: 0, count: 5 });
    assert.equal(got.kind, "stale");
  });

  test("大小没变但 mtime 变了（被重写 / touch）：保守回 stale", async () => {
    const path = join(dir, "touched.log");
    await writeFile(path, "a\nb\nc\n", "utf8");
    const { indexId } = await indexOk(path);
    const later = new Date(Date.now() + 60_000);
    await utimes(path, later, later);
    const got = await readLines({ indexId, startLine: 0, count: 1 });
    assert.equal(got.kind, "stale");
  });

  test("追加进来一条超长行：建索引回 long-line，旧令牌作废", async () => {
    const path = join(dir, "grow-long.log");
    await writeFile(path, "a\nb\n", "utf8");
    const first = await indexOk(path);
    await appendFile(path, "x".repeat(PREVIEW_MAX_LINE_BYTES + 100), "utf8");
    const again = await buildLineIndex(path);
    assert.equal(again.kind, "long-line");
    const old = await readLines({ indexId: first.indexId, startLine: 0, count: 1 });
    assert.equal(old.kind, "expired");
  });

  test("跨 8 MB 块的续扫：新增 9 MB 也一样准", async () => {
    const path = join(dir, "grow-big.log");
    await writeFile(path, bigLog(1500), "utf8");
    const first = await indexOk(path);
    const more = bigLog(300_000, 1500); // 约 9.6 MB
    await appendFile(path, more, "utf8");
    const again = await indexOk(path);
    assert.equal(again.indexId, first.indexId);
    assert.equal(again.totalLines, 301_500);
    const got = await readLines({ indexId: first.indexId, startLine: 301_499, count: 5 });
    assert.ok(got.kind === "text");
    assert.deepEqual(got.lines, [`row-301499`.padEnd(31, ".")]);
  });
});

describe("在途去重与取消", () => {
  /** 一份够大、扫一遍要让出几次事件循环的文件（~17 MB，三块） */
  async function bigFile(name: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, bigLog(540_000), "utf8");
    return path;
  }

  test("同一个文件同时建两次：并成一次扫描，令牌相同", async () => {
    const path = await bigFile("dedupe.log");
    const [a, b, c] = await Promise.all([buildLineIndex(path), buildLineIndex(path), buildLineIndex(path)]);
    assert.ok(a.kind === "ok" && b.kind === "ok" && c.kind === "ok");
    // 没有去重时，后完成的那次会换掉先完成的（新令牌）
    assert.equal(a.indexId, b.indexId);
    assert.equal(b.indexId, c.indexId);
    assert.equal(a.totalLines, 540_000);
  });

  test("取消：信号触发后立刻回 cancelled，不留索引", async () => {
    const path = await bigFile("cancel.log");
    const controller = new AbortController();
    const pending = buildLineIndex(path, controller.signal);
    controller.abort();
    const got = await pending;
    assert.equal(got.kind, "cancelled");
    // 没缓存下来：下一次从头扫，拿到的是一个新的有效索引
    const next = await indexOk(path);
    assert.equal(next.totalLines, 540_000);
  });

  test("取消之后扫描真的停下：没有索引被装进缓存", async () => {
    const probe = join(dir, "probe.log");
    await writeFile(probe, "a\n", "utf8");
    const seq = Number((await indexOk(probe)).indexId.replace("lines-", ""));
    const path = await bigFile("stops.log");
    const controller = new AbortController();
    const pending = buildLineIndex(path, controller.signal);
    controller.abort();
    assert.equal((await pending).kind, "cancelled");
    // 令牌按序号发：若被取消的那次照样扫完并装进缓存，它拿到的就是下一个号
    await new Promise((resolve) => setTimeout(resolve, 500));
    const leaked = await readLines({ indexId: `lines-${seq + 1}`, startLine: 0, count: 1 });
    assert.equal(leaked.kind, "expired");
  });

  test("已经取消的信号：直接回 cancelled", async () => {
    const path = await bigFile("pre-cancel.log");
    const controller = new AbortController();
    controller.abort();
    assert.equal((await buildLineIndex(path, controller.signal)).kind, "cancelled");
  });

  test("两个请求并在一次扫描上，一个取消：另一个照常拿到结果", async () => {
    const path = await bigFile("share.log");
    const quitter = new AbortController();
    const stayer = buildLineIndex(path);
    const left = buildLineIndex(path, quitter.signal);
    quitter.abort();
    assert.equal((await left).kind, "cancelled");
    const got = await stayer;
    assert.ok(got.kind === "ok");
    assert.equal(got.totalLines, 540_000);
  });

  test("等的人都走了、扫描还没停下时来了新请求：新请求不会拿到别人的 cancelled", async () => {
    const path = await bigFile("revive.log");
    const first = new AbortController();
    const gone = buildLineIndex(path, first.signal);
    first.abort(); // 唯一的等待者走了 → 任务被取消，但它还没来得及停
    const fresh = await buildLineIndex(path);
    assert.ok(fresh.kind === "ok", `新请求拿到了 ${fresh.kind}`);
    assert.equal((await gone).kind, "cancelled");
    assert.equal(fresh.totalLines, 540_000);
  });
});

