/**
 * 已蒸轮账本的回归网：宽松解读（坏文件当空账）、记录与幂等、落盘读回、
 * 单会话坏数组只丢那段。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DistilledTurnLedger, DISTILLED_TURNS_FILE, parseDistilledTurns, toDistilledTurnsFile } from "./backfill-ledger.ts";

let dir = "";
let file = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-ledger-"));
  file = join(dir, DISTILLED_TURNS_FILE);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("parseDistilledTurns", () => {
  test("v 不认识 / sessions 不是对象 → 空账", () => {
    assert.equal(parseDistilledTurns(null).size, 0);
    assert.equal(parseDistilledTurns({ v: 2, sessions: {} }).size, 0);
    assert.equal(parseDistilledTurns({ v: 1, sessions: [] }).size, 0);
    assert.equal(parseDistilledTurns({ v: 1 }).size, 0);
  });

  test("好账逐会话读回；坏数组的会话整段丢，别的不受影响", () => {
    const turns = parseDistilledTurns({
      v: 1,
      sessions: { "s-good": [1, 2, 5], "s-bad": [1, "x"], "s-empty": [] },
    });
    assert.deepEqual([...(turns.get("s-good") ?? [])].sort((a, b) => a - b), [1, 2, 5]);
    assert.equal(turns.has("s-bad"), false);
    assert.equal(turns.has("s-empty"), false);
  });

  test("轮号非正整数（0 / 负 / 小数）的会话丢", () => {
    const turns = parseDistilledTurns({ v: 1, sessions: { a: [0], b: [1.5], c: [-1], d: [3] } });
    assert.equal(turns.has("a"), false);
    assert.equal(turns.has("b"), false);
    assert.equal(turns.has("c"), false);
    assert.deepEqual([...(turns.get("d") ?? [])], [3]);
  });
});

describe("DistilledTurnLedger", () => {
  test("文件不存在：空账，has 安静地 false", async () => {
    const ledger = new DistilledTurnLedger(file);
    await ledger.load();
    assert.equal(ledger.has("s1", 1), false);
    assert.equal(ledger.turnsOf("s1").size, 0);
  });

  test("record 落盘，重开读回；重复记同一轮幂等", async () => {
    const ledger = new DistilledTurnLedger(file);
    await ledger.load();
    await ledger.record("s1", 1);
    await ledger.record("s1", 3);
    await ledger.record("s2", 2);
    await ledger.record("s1", 3); // 幂等
    const reopened = new DistilledTurnLedger(file);
    await reopened.load();
    assert.equal(reopened.has("s1", 1), true);
    assert.equal(reopened.has("s1", 3), true);
    assert.equal(reopened.has("s2", 2), true);
    assert.equal(reopened.has("s1", 2), false);
    // 盘上是升序数组
    const raw = JSON.parse(await readFile(file, "utf8")) as { sessions: Record<string, number[]> };
    assert.deepEqual(raw.sessions["s1"], [1, 3]);
  });

  test("坏 JSON 当空账（重蒸兜底）", async () => {
    await writeFile(file, "{ not json", "utf8");
    const ledger = new DistilledTurnLedger(file);
    await ledger.load();
    assert.equal(ledger.has("s1", 1), false);
  });

  test("toDistilledTurnsFile 与 parseDistilledTurns 往返一致，空段不落盘", () => {
    const turns = new Map<string, Set<number>>([
      ["a", new Set([3, 1, 2])],
      ["b", new Set()],
    ]);
    const snapshot = toDistilledTurnsFile(turns);
    assert.deepEqual(snapshot.sessions["a"], [1, 2, 3]);
    assert.equal("b" in snapshot.sessions, false);
    const back = parseDistilledTurns(snapshot);
    assert.deepEqual([...(back.get("a") ?? [])], [1, 2, 3]);
    assert.equal(back.has("b"), false);
  });
});
