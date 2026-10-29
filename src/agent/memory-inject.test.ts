/**
 * 注入块组装（memory-inject.ts）——空命中不注入、预算兜底、常驻在前。
 * 纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  attachMemoryBlocks,
  buildMemoryBlock,
  MEMORY_ATTACH_ENTRY,
  memoryAttachments,
  type TurnMemoryAttach,
} from "./memory-inject.ts";
import type { ContextMessage } from "./image-byte-budget.ts";
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
  assert.ok(block!.startsWith("<orbita-memory>"));
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

/* ---------- 附件式挂载：不改用户原话，发送前挂独立块，逐字节重放 ---------- */

function user(text: string, timestamp: number): ContextMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp } as ContextMessage;
}
function assistant(text: string): ContextMessage {
  return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 } as unknown as ContextMessage;
}
function contentOf(message: ContextMessage | undefined): unknown {
  return (message as { content?: unknown } | undefined)?.content;
}

test("认领：pending 挂到最后一条用户消息末尾（独立块），原话不变，返回要落本的 record", () => {
  const state: TurnMemoryAttach = { attached: new Map(), pending: "<orbita-memory>A</orbita-memory>" };
  const input = [user("第一轮", 100), assistant("答"), user("第二轮", 200)];
  const out = attachMemoryBlocks(input, state);
  assert.deepEqual(out.record, { at: 200, text: "<orbita-memory>A</orbita-memory>" });
  assert.equal(state.pending, null);
  assert.deepEqual(contentOf(out.messages?.[2]), [
    { type: "text", text: "第二轮" },
    { type: "text", text: "<orbita-memory>A</orbita-memory>" },
  ]);
  // 入参不被改
  assert.deepEqual(contentOf(input[2]), [{ type: "text", text: "第二轮" }]);
  // 第一轮没有附件，原样
  assert.deepEqual(contentOf(out.messages?.[0]), [{ type: "text", text: "第一轮" }]);
});

test("重放：后续轮次与轮内多次调用，旧消息的附件逐字节相同；steer 进来的新消息不认领", () => {
  const state: TurnMemoryAttach = { attached: new Map([[100, "<orbita-memory>旧</orbita-memory>"]]), pending: null };
  const first = attachMemoryBlocks([user("问", 100), assistant("答"), user("插话", 300)], state);
  const second = attachMemoryBlocks([user("问", 100), assistant("答"), user("插话", 300), assistant("再答")], state);
  assert.equal(first.record, null);
  assert.equal(JSON.stringify(first.messages?.[0]), JSON.stringify(second.messages?.[0]));
  assert.deepEqual(contentOf(first.messages?.[2]), [{ type: "text", text: "插话" }]);
});

test("字符串正文转块数组；没有任何附件时不替换", () => {
  const state: TurnMemoryAttach = { attached: new Map([[5, "M"]]), pending: null };
  const out = attachMemoryBlocks([{ role: "user", content: "纯文本", timestamp: 5 } as ContextMessage], state);
  assert.deepEqual(contentOf(out.messages?.[0]), [
    { type: "text", text: "纯文本" },
    { type: "text", text: "M" },
  ]);
  const none = attachMemoryBlocks([user("x", 1)], { attached: new Map(), pending: null });
  assert.equal(none.messages, null);
  assert.equal(none.record, null);
});

test("memoryAttachments：从本子读回，坏 entry 跳过，同一时间戳以先落的为准", () => {
  const entries = [
    { type: "custom", customType: MEMORY_ATTACH_ENTRY, data: { at: 1, text: "先" } },
    { type: "custom", customType: MEMORY_ATTACH_ENTRY, data: { at: 1, text: "后" } },
    { type: "custom", customType: MEMORY_ATTACH_ENTRY, data: { at: "x", text: "坏" } },
    { type: "custom", customType: "other", data: { at: 2, text: "别家" } },
    { type: "custom", customType: MEMORY_ATTACH_ENTRY, data: { at: 3, text: "三" } },
  ] as unknown as SessionEntry[];
  assert.deepEqual([...memoryAttachments(entries)], [
    [1, "先"],
    [3, "三"],
  ]);
});
