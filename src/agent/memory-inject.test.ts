import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemoryHit } from "../shared/memory.ts";
import { buildMemoryBlock } from "./memory-inject.ts";

function hit(text: string, timestamp = new Date(2026, 8, 30).getTime()): MemoryHit {
  return { entry: { id: "mem_x", text, keywords: [], sessionId: "s", timestamp }, score: 0.9 };
}

test("空命中返回 null（调用方不注入）", () => {
  assert.equal(buildMemoryBlock([]), null);
});

test("组装：标签包裹、每条带绝对日期、原样引用条目文本", () => {
  const block = buildMemoryBlock([hit("用户偏好 bun")]);
  assert.ok(block !== null);
  assert.ok(block.startsWith("\n\n<orbita-memory>"));
  assert.ok(block.endsWith("</orbita-memory>"));
  assert.ok(block.includes("- [2026-09-30] 用户偏好 bun"));
});

test("预算：超 1500 字符的后续条目整条跳过，第一条永远装", () => {
  const big = "长".repeat(1400);
  const block = buildMemoryBlock([hit(big), hit("第二条"), hit("第三条")]);
  assert.ok(block !== null);
  assert.ok(block.includes(big));
  // 1400 + 第一条的行头已逼近预算，第二条第三条只能装得下就装、装不下整条跳
  const lines = block.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(lines.length >= 1 && lines.length <= 3);
  for (const l of lines.slice(1)) assert.ok(l.includes("第"));
});

test("第一条自身超预算也照装（一条都不装等于召回白做）", () => {
  const block = buildMemoryBlock([hit("巨".repeat(2000)), hit("轮不到我")]);
  assert.ok(block !== null);
  assert.ok(block.includes("巨".repeat(2000)));
  assert.ok(!block.includes("轮不到我"));
});
