/**
 * 注入账本（MemoryUsageStore）的回归网：每轮一条（含零命中）、按会话过滤、
 * 使用统计推导、坏行跳过。真文件系统用临时目录，不 mock fs。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryInjectionRecord } from "../../shared/memory.ts";
import { MemoryUsageStore, parseInjectionRecord } from "./usage.ts";

let dir = "";
let store: MemoryUsageStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-memory-usage-"));
  store = new MemoryUsageStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const record = (sessionId: string, turn: number, at: number, hits: { id: string; score: number }[] = []): MemoryInjectionRecord => ({
  sessionId,
  turn,
  at,
  hits,
});

describe("MemoryUsageStore", () => {
  test("空账本：list / bySession / usageOf 都是空，不抛", async () => {
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await store.bySession("s1"), []);
    assert.equal((await store.usageOf()).size, 0);
  });

  test("record 是追加：按会话过滤读回，顺序保留", async () => {
    await store.record(record("s1", 1, 100));
    await store.record(record("s2", 1, 200));
    await store.record(record("s1", 2, 300, [{ id: "mem_a", score: 0.8 }]));
    assert.deepEqual(
      (await store.bySession("s1")).map((entry) => entry.turn),
      [1, 2],
    );
    assert.equal((await store.bySession("s2")).length, 1);
  });

  test("usageOf：次数累计，最近一次取最大时刻", async () => {
    await store.record(record("s1", 1, 100, [
      { id: "mem_a", score: 0.8 },
      { id: "mem_b", score: 0.5 },
    ]));
    await store.record(record("s1", 2, 300, [{ id: "mem_a", score: 0.9 }]));
    await store.record(record("s2", 5, 200, [{ id: "mem_b", score: 1 }]));
    const usage = await store.usageOf();
    assert.deepEqual(usage.get("mem_a"), { count: 2, lastAt: 300 });
    assert.deepEqual(usage.get("mem_b"), { count: 2, lastAt: 200 });
  });

  test("坏行跳过：半截 JSON 与字段残缺各跳一条，好行照常", async () => {
    await writeFile(
      join(dir, "injections.jsonl"),
      [
        "not json",
        JSON.stringify({ sessionId: "s2", turn: 1, at: 1 }), // 缺 hits → 跳
        JSON.stringify({ sessionId: "", turn: 1, at: 1, hits: [] }), // 空 sessionId → 跳
        JSON.stringify({ sessionId: "s2", turn: 0, at: 1, hits: [] }), // 轮号 0 → 跳
        JSON.stringify(record("s1", 1, 100)), // 好行（写文件是整份替换，好行写进同一份）
        JSON.stringify(record("s2", 3, 42)), // 好行
      ].join("\n") + "\n",
      "utf8",
    );
    const records = await store.list();
    assert.deepEqual(records.map((entry) => entry.turn), [1, 3]);
  });
});

describe("parseInjectionRecord", () => {
  test("hits 里的坏项剔除（非对象 / 缺 id / 坏分数），好项保留", () => {
    const parsed = parseInjectionRecord({
      sessionId: "s1",
      turn: 2,
      at: 100,
      hits: [
        { id: "mem_a", score: 0.5 },
        "junk",
        { id: "", score: 1 },
        { id: "mem_b", score: "高" },
        { id: "mem_c", score: 0.9 },
      ],
    });
    assert.ok(parsed !== null);
    assert.deepEqual(parsed.hits, [
      { id: "mem_a", score: 0.5 },
      { id: "mem_c", score: 0.9 },
    ]);
  });

  test("字段不齐返回 null", () => {
    assert.equal(parseInjectionRecord(null), null);
    assert.equal(parseInjectionRecord({ sessionId: "s", turn: 1 }), null);
    assert.equal(parseInjectionRecord({ sessionId: "s", turn: "一", at: 1, hits: [] }), null);
  });
});
