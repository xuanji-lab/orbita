import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { latestPlan, workCardOf, workCardsText } from "./work-card.ts";
import type { TranscriptItem } from "./transcript.ts";
import type { ChannelMessage } from "./channel.ts";

const plan = (items: unknown): TranscriptItem =>
  ({ role: "tool", id: "p", toolCallId: "c", toolName: "update_plan", input: { items }, content: [], status: "complete", isError: false, timestamp: 1 }) as unknown as TranscriptItem;
const msg = (kind: ChannelMessage["kind"], text: string, from: ChannelMessage["from"] = "child"): ChannelMessage => ({ id: kind + text, from, author: "model", kind, text, delivery: "followUp", createdAt: 1 });

describe("小卡（主智能体读的）", () => {
  test("计划取最近一次；那一句取在做的那步；在问时带上问题", () => {
    const items = [
      plan([{ text: "旧", status: "in_progress" }]),
      plan([{ text: "下载会议议程", status: "done" }, { text: "整理表格", status: "in_progress" }]),
    ];
    assert.equal(latestPlan(items)?.length, 2);
    const card = workCardOf({
      meta: { id: "c1", title: "整理数据集", durable: { resumed: 1000 } },
      status: "waiting",
      messages: [msg("task", "做", "parent"), msg("question", "要不要算进对比？")],
      items,
      running: true,
      lastActivityAt: 0,
      now: 10 * 60_000,
    });
    assert.equal(card.line, "整理表格");
    assert.deepEqual(card.plan, { done: 1, total: 2 });
    assert.equal(card.waitingFor, "要不要算进对比？");
    assert.equal(card.quiet, true);
    assert.equal(card.resumedAt, 1000);
    const text = workCardsText([card], 10 * 60_000);
    assert.ok(text.includes("plan 1/2") && text.includes("waiting for: 要不要算进对比？") && text.includes("no activity"));
  });

  test("暂停带理由；没有活时说没有", () => {
    const card = workCardOf({ meta: { id: "c", title: "t" }, status: "paused", messages: [msg("pause", "等口径", "parent")], items: [], running: false, lastActivityAt: null, now: 0 });
    assert.equal(card.pausedFor, "等口径");
    assert.equal(card.quiet, false);
    assert.match(workCardsText([], 0), /No work/);
    const idle = workCardOf({ meta: { id: "c", title: "t" }, status: "running", messages: [], items: [], running: false, lastActivityAt: null, now: 0 });
    assert.match(workCardsText([idle], 0), /idle \(not finished/);
  });

  test("能力集：全带不写；纯聊天、只带基础、基础 + 清单各说一句", () => {
    const of = (capabilities?: string[]) =>
      workCardsText([workCardOf({ meta: { id: "c", title: "t", ...(capabilities === undefined ? {} : { capabilities }) }, status: "running", messages: [], items: [], running: true, lastActivityAt: 0, now: 0 })], 0);
    assert.doesNotMatch(of(), /given:/);
    assert.match(of(["none"]), /given: chat only, no tools/);
    assert.match(of([]), /given: basic tools only/);
    assert.match(of(["pdf-docx", "browser"]), /given: basic tools \+ pdf-docx, browser/);
  });
});
