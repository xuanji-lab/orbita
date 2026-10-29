/**
 * 注入块组装（memory-inject.ts）——空命中不注入、预算兜底、常驻在前。
 * 纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildMemoryBlock } from "./memory-inject.ts";
import type { MemoryEntry, MemoryHit } from "../shared/memory.ts";

function hit(overrides: Partial<MemoryEntry> & { id: string }): MemoryHit {
  return {
    entry: {
      type: "fact",
      text: `条目 ${overrides.id}`,
      keywords: [],
      layer: "workspace",
      scopeId: "ws-1",
      sessionId: "s1",
      turns: [1],
      at: new Date(2026, 9, 29).getTime(),
      episodeId: "ep_1",
      source: "chat",
      ...overrides,
    },
    score: 0.5,
  };
}

test("空命中返回 null（不注入，照常开轮）", () => {
  assert.equal(buildMemoryBlock([]), null);
});

test("命中拼进 <orbita-memory> 块：日期前缀 + 正文，常驻也一视同仁", () => {
  const block = buildMemoryBlock([hit({ id: "m1" }), { ...hit({ id: "m2" }), score: 1, pinned: true }]);
  assert.ok(block !== null);
  assert.ok(block!.startsWith("\n\n<orbita-memory>"));
  assert.ok(block!.includes("- [2026-10-29] 条目 m1"));
  assert.ok(block!.includes("条目 m2"));
  assert.ok(block!.endsWith("</orbita-memory>"));
});

test("预算兜底：超长条目跳过试下一条，第一条永远装", () => {
  const block = buildMemoryBlock([
    hit({ id: "long", text: "长".repeat(2900) }),
    hit({ id: "short", text: "短条目" }),
  ]);
  assert.ok(block !== null);
  assert.ok(block!.includes("长".repeat(100)));
  assert.ok(block!.includes("短条目"));
});
