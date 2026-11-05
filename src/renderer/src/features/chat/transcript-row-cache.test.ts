import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@shared/session";
import { branchInfoOf, scanCardOf } from "./transcript-row-cache.ts";

type Assistant = Extract<TranscriptRecord, { role: "assistant" }>;

const user = (id: string): TranscriptRecord =>
  ({ id, role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }) as TranscriptRecord;
const assistant = (id: string, texts: string[], extra: Record<string, unknown> = {}): Assistant =>
  ({
    id,
    role: "assistant",
    content: texts.map((text) => ({ type: "text", text })),
    model: { provider: "p", id: "m" },
    timestamp: 2,
    status: "complete",
    stopReason: "stop",
    ...extra,
  }) as Assistant;

const FENCE = '```json\n{"carryovers": [{"title": "补 README", "detail": "摘录"}]}\n```';

describe("scanCardOf", () => {
  test("整条恰好一个扫描回答：卡挂在第一个 text 块的位置；同一条记录第二次直接取缓存", () => {
    const record = assistant("a1", ['```json\n{"carryovers": [', '{"title": "补 README", "detail": "摘录"}]}\n```']);
    const card = scanCardOf(record);
    assert.equal(card?.firstKey, "a1:0");
    assert.deepEqual(card?.scan.left, [{ title: "补 README", detail: "摘录" }]);
    assert.equal(scanCardOf(record), card);
  });

  test("普通回答、没有 text 块：null", () => {
    assert.equal(scanCardOf(assistant("a2", ["你好"])), null);
    assert.equal(scanCardOf(assistant("a3", [])), null);
    assert.notEqual(scanCardOf(assistant("a4", [FENCE])), null);
  });
});

describe("branchInfoOf", () => {
  const a1 = assistant("a1", ["第一句"], { usage: { output: 100 }, genMs: 1000 });
  const a2 = assistant("a2", ["第二句"], { usage: { output: 100 }, genMs: 1000 });
  const records: TranscriptRecord[] = [user("u1"), a1, a2, user("u2"), assistant("b1", ["下一轮"])];

  test("按锚点所在整轮取复制文本与速度（同 turnAssistantRecords + answerText + replySpeed）", () => {
    const info = branchInfoOf(records, new Map([[2, "a2"]]));
    assert.equal(info.get("a2")?.copyText, "第一句\n\n第二句");
    assert.equal(typeof info.get("a2")?.speed, "number");
    assert.equal(info.has("b1"), false);
  });

  test("整轮记录没变：交回上一次的同一个对象；轮里多了一条就重算", () => {
    const first = branchInfoOf(records, new Map([[2, "a2"]])).get("a2");
    const again = branchInfoOf([...records], new Map([[2, "a2"]])).get("a2");
    assert.equal(again, first);
    const extra = assistant("a0", ["前言"]);
    const changed = branchInfoOf([user("u1"), extra, a1, a2], new Map([[3, "a2"]])).get("a2");
    assert.notEqual(changed, first);
    assert.equal(changed?.copyText, "前言\n\n第一句\n\n第二句");
  });

  test("没有锚点：空表", () => {
    assert.equal(branchInfoOf(records, new Map()).size, 0);
  });
});
