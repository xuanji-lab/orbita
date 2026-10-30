import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { buildGoalLedger } from "../../../../shared/goal-ledger.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { isLedgerRecord, ledgerEventsOf, ledgerSignature } from "./goal-ledger-records.ts";
import { goalNoticeText } from "./plan-text.ts";

const userMsg = (id: string, at: number, text: string): TranscriptItem =>
  ({ id, role: "user", content: [{ type: "text", text }, { type: "image", data: "x", mimeType: "image/png" }], timestamp: at }) as TranscriptItem;
const tool = (toolCallId: string, toolName: string, at: number, input: unknown, status: ToolTranscriptItem["status"] = "complete"): TranscriptItem =>
  ({ id: `item-${toolCallId}`, role: "tool", toolCallId, toolName, input, content: [], timestamp: at, status, isError: status === "error" }) as TranscriptItem;

describe("ledgerEventsOf（转录记录 → 账本事件）", () => {
  const records = [
    userMsg("u1", 100, "做排序\n细节在 README"),
    tool("g1", "update_goal", 110, { goal: "做排序" }),
    tool("b1", "bash", 120, { command: "ls" }),
    tool("g2", "update_goal", 130, { goal: "坏的" }, "error"),
  ];

  test("只挑用户消息与 update_goal / update_plan；用户消息只取文字块，失败的调用带 failed", () => {
    assert.deepEqual(records.filter(isLedgerRecord).map((r) => r.id), ["u1", "item-g1", "item-g2"]);
    const events = ledgerEventsOf(records);
    assert.deepEqual(events[0], { kind: "user", id: "u1", at: 100, text: "做排序\n细节在 README" });
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => (e.kind === "call" ? e.failed : null)), [null, false, true]);
  });

  test("失败的调用不进账；用户来源挂的是用户消息 id（对话里点得回去）", () => {
    const ledger = buildGoalLedger(ledgerEventsOf(records));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0]?.source.kind === "user" ? ledger.entries[0].source.id : null, "u1");
  });

  test("签名：流式吐字（非账本记录变化）不改签名；工具状态变了才改", () => {
    const a = ledgerSignature(records.filter(isLedgerRecord));
    const withChatter = [...records, { id: "a1", role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 140, status: "streaming" } as TranscriptItem];
    assert.equal(ledgerSignature(withChatter.filter(isLedgerRecord)), a);
    const running = [tool("g1", "update_goal", 110, { goal: "做排序" }, "running")];
    const done = [tool("g1", "update_goal", 110, { goal: "做排序" })];
    assert.notEqual(ledgerSignature(running), ledgerSignature(done));
  });
});

describe("goalNoticeText（对话里『目标改了』那一行）", () => {
  const ledger = buildGoalLedger(
    ledgerEventsOf([
      userMsg("u1", 1, "做排序"),
      tool("g1", "update_goal", 2, { goal: "做排序" }),
      userMsg("u2", 3, "还要筛选"),
      tool("g2", "update_goal", 4, { goal: "做排序和筛选", why: "用户补充" }),
    ]),
  );

  test("改了已有目标：写从什么到什么 + 理由（中英文）", () => {
    assert.equal(goalNoticeText(zh, ledger, ["g2"]), "目标改了：「做排序」改成「做排序和筛选」——用户补充");
    assert.equal(goalNoticeText(en, ledger, ["g2"]), 'Goal changed: "做排序" → "做排序和筛选" — 用户补充');
  });

  test("第一次定目标不出；不在这个块里的调用不出；没理由不带破折号", () => {
    assert.equal(goalNoticeText(zh, ledger, ["g1"]), null);
    assert.equal(goalNoticeText(zh, ledger, ["gX"]), null);
    assert.equal(goalNoticeText(zh, ledger, []), null);
    const noWhy = buildGoalLedger(ledgerEventsOf([userMsg("u1", 1, "a"), tool("g1", "update_goal", 2, { goal: "a" }), tool("g2", "update_goal", 3, { goal: "b" })]));
    assert.equal(goalNoticeText(zh, noWhy, ["g2"]), "目标改了：「a」改成「b」");
  });
});
