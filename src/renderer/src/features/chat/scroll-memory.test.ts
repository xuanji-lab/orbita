import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESTORE_MAX_PAGES,
  createScrollMemory,
  decideRestore,
  positionToRecord,
} from "./scroll-memory.ts";

const found = (top: number) => () => top;
const missing = () => null;

test("记录与读回；同 id 覆盖", () => {
  const m = createScrollMemory();
  m.record("a", { kind: "row", key: "k1", offsetTop: -12 });
  m.record("a", { kind: "bottom" });
  assert.deepEqual(m.get("a"), { kind: "bottom" });
  assert.equal(m.get("b"), undefined);
  assert.equal(m.size, 1);
});

test("上限：超出丢最旧；更新过的算新", () => {
  const m = createScrollMemory(3);
  m.record("a", { kind: "bottom" });
  m.record("b", { kind: "bottom" });
  m.record("c", { kind: "bottom" });
  m.record("a", { kind: "row", key: "k", offsetTop: 0 }); // a 变最新
  m.record("d", { kind: "bottom" }); // 挤掉 b
  assert.equal(m.size, 3);
  assert.equal(m.get("b"), undefined);
  assert.notEqual(m.get("a"), undefined);
  assert.notEqual(m.get("c"), undefined);
});

test("positionToRecord：跟随记底部，否则记行，无锚点不记", () => {
  assert.deepEqual(positionToRecord(true, { key: "x", offsetTop: 1 }), { kind: "bottom" });
  assert.deepEqual(positionToRecord(false, { key: "x", offsetTop: -5 }), { kind: "row", key: "x", offsetTop: -5 });
  assert.equal(positionToRecord(false, null), null);
});

test("恢复：无记录 / 在底部 → 跳底", () => {
  assert.deepEqual(decideRestore(undefined, found(10), true, 0), { action: "bottom" });
  assert.deepEqual(decideRestore({ kind: "bottom" }, found(10), true, 0), { action: "bottom" });
});

test("恢复：行在窗口里 → 滚到那一行", () => {
  const d = decideRestore({ kind: "row", key: "k", offsetTop: -3 }, found(840), false, 0);
  assert.deepEqual(d, { action: "scroll", top: 840, key: "k", offsetTop: -3 });
});

test("恢复：行不在窗口 → 先翻页；翻到头或超上限 → 跳底", () => {
  const pos = { kind: "row", key: "k", offsetTop: 0 } as const;
  assert.deepEqual(decideRestore(pos, missing, true, 2), { action: "load" });
  assert.deepEqual(decideRestore(pos, missing, false, 2), { action: "bottom" });
  assert.deepEqual(decideRestore(pos, missing, true, RESTORE_MAX_PAGES), { action: "bottom" });
});
