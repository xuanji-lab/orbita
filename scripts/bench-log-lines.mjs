#!/usr/bin/env node
/**
 * bench-log-lines.mjs —— readLogEntries 行切分：旧「整份 toString + split("\n")」vs
 * 新「按换行字节切 Buffer、每行再解码」（perf/session-log-lines）。
 *
 * 口径对齐调查报告【4】的「同步段」：readFile 拿到字节之后的纯 CPU 段（解码 + 切行 +
 * trim + JSON.parse + 落地判定），读盘两边相同、不计入。逐行判定 parseLogLine 两边
 * 共用同一份（import 自 store.ts），只差「怎么拿到行」。
 *
 * 用法：node scripts/bench-log-lines.mjs [jsonl 路径 …]
 * 不带参数时自动取真实会话目录里最大的 3 条 + 居中 1 条（只读打开，不打印内容）。
 * 每条会话先读 Buffer 预热页缓存，然后旧 / 新交替各跑 5 次取中位数。
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { forEachBufferLine } from "../src/main/jsonl-scan.ts";
import { parseLogLine } from "../src/main/session/store.ts";

const RUNS = 5;

/** 旧路径：整份解码成一个字符串再 split（当前要替换的写法） */
function parseLegacy(raw) {
  const records = [];
  for (const line of raw.toString("utf8").split("\n")) {
    const record = parseLogLine(line);
    if (record !== undefined) records.push(record);
  }
  return records;
}

/** 新路径：按换行字节切 Buffer、每行再解码 */
function parseBuffered(raw) {
  const records = [];
  forEachBufferLine(raw, (line) => {
    const record = parseLogLine(line);
    if (record !== undefined) records.push(record);
  });
  return records;
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 不带参数时挑量测素材：真实会话目录按大小排序，取最大 3 条 + 居中 1 条 */
async function defaultFiles() {
  const dir = join(homedir(), "Library", "Application Support", "orbita", "sessions");
  const entries = await readdir(dir);
  const sizes = await Promise.all(
    entries
      .filter((name) => name.endsWith(".jsonl"))
      .map(async (name) => ({ path: join(dir, name), size: (await stat(join(dir, name))).size })),
  );
  sizes.sort((a, b) => b.size - a.size);
  const picked = [...sizes.slice(0, 3), sizes[Math.floor(sizes.length / 2)]];
  return picked.map((item) => item.path);
}

async function main() {
  const files = process.argv.length > 2 ? process.argv.slice(2) : await defaultFiles();
  console.log(`旧 = toString + split("\\n")；新 = 按字节切行逐行解码；各 ${RUNS} 次交替取中位数（同步段，不含读盘）`);
  for (const path of files) {
    // 预热：读盘 + 页缓存 + 编译，均不进计时
    await readFile(path);
    const raw = await readFile(path);
    const legacyMs = [];
    const bufferedMs = [];
    let legacyCount = -1;
    let bufferedCount = -1;
    for (let run = 0; run < RUNS; run += 1) {
      const t0 = performance.now();
      legacyCount = parseLegacy(raw).length;
      legacyMs.push(performance.now() - t0);
      const t1 = performance.now();
      bufferedCount = parseBuffered(raw).length;
      bufferedMs.push(performance.now() - t1);
    }
    const oldMs = median(legacyMs);
    const newMs = median(bufferedMs);
    const mib = (raw.length / 1024 / 1024).toFixed(1);
    const match = legacyCount === bufferedCount ? "一致" : `不一致！旧 ${legacyCount} 新 ${bufferedCount}`;
    console.log(
      `${path.split("/").pop()}  ${mib} MB  记录 ${legacyCount} 条  旧 ${oldMs.toFixed(1)}ms → 新 ${newMs.toFixed(1)}ms` +
        `（省 ${(oldMs - newMs).toFixed(1)}ms / ${(((oldMs - newMs) / oldMs) * 100).toFixed(1)}%），条数 ${match}`,
    );
  }
}

await main();
