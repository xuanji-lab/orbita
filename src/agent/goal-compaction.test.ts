import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { attachGoalLedger, ledgerEventsFromEntries, type LedgerAttachCache } from "./goal-compaction.ts";

let n = 0;
const id = (): string => `e${++n}`;
const user = (text: string, at: number) => ({ type: "message", id: id(), message: { role: "user", content: [{ type: "text", text }], timestamp: at } });
const call = (callId: string, name: string, args: unknown, at: number) => ({
  type: "message",
  id: id(),
  message: { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: callId, name, arguments: args }], timestamp: at },
});
const result = (callId: string, isError = false) => ({ type: "message", id: id(), message: { role: "toolResult", toolCallId: callId, isError, content: [], timestamp: 0 } });
const compaction = () => ({ type: "compaction", id: id(), summary: "S", firstKeptEntryId: "x", tokensBefore: 1 });
const summaryMsg = (summary: string) => ({ role: "compactionSummary", summary, tokensBefore: 1, timestamp: 0 });
const userMsg = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 5 };

describe("ledgerEventsFromEntries（pi 本子 → 账本事件）", () => {
  test("用户消息（字符串或文字块）、update_goal / update_plan 调用；其余工具与非 message 条目忽略", () => {
    const events = ledgerEventsFromEntries([
      user("做排序", 100),
      { type: "message", id: "u-str", message: { role: "user", content: "字符串形态", timestamp: 105 } },
      call("g1", "update_goal", { goal: "做排序" }, 110),
      call("b1", "bash", { command: "ls" }, 120),
      { type: "custom", id: "c1", customType: "x" },
    ]);
    assert.deepEqual(events.map((e) => e.kind), ["user", "user", "call"]);
    assert.equal(events[1]?.kind === "user" ? events[1].text : null, "字符串形态");
    assert.equal(events[2]?.kind === "call" ? events[2].tool : null, "update_goal");
  });

  test("toolResult.isError 的调用标 failed", () => {
    const events = ledgerEventsFromEntries([call("g1", "update_goal", { goal: "x" }, 1), result("g1", true)]);
    assert.equal(events[0]?.kind === "call" ? events[0].failed : null, true);
  });
});

describe("attachGoalLedger（压缩摘要后挂账，wire-only）", () => {
  const branch = [
    user("把待办模块做完", 1000),
    call("g1", "update_goal", { goal: "把待办模块做完" }, 1100),
    result("g1"),
    user("还要按到期日筛选", 2000),
    call("g2", "update_goal", { goal: "把待办模块做完，含按到期日筛选", why: "用户补充" }, 2100),
    result("g2"),
    compaction(),
  ];

  test("摘要后附账：目标原样 + 从→到 + why + 触发它的那条用户消息", () => {
    const out = attachGoalLedger([summaryMsg("摘要正文"), userMsg] as never, () => branch, new Map());
    assert.ok(out !== null);
    const summary = (out[0] as unknown as { summary: string }).summary;
    assert.ok(summary.startsWith("摘要正文\n\n---\nSession goal ledger"));
    assert.match(summary, /Current goal: "把待办模块做完，含按到期日筛选"/);
    assert.match(summary, /because 用户补充/);
    assert.match(summary, /user message .* "还要按到期日筛选"/);
    // 其余消息不动
    assert.equal(out[1], userMsg as never);
  });

  test("不改入参数组与原消息对象（wire-only）", () => {
    const messages = [summaryMsg("摘要正文"), userMsg];
    const before = JSON.stringify(messages);
    attachGoalLedger(messages as never, () => branch, new Map());
    assert.equal(JSON.stringify(messages), before);
  });

  test("逐字节稳定：同一压缩条目多次调用结果相同，且只算一次（命中缓存不再读本子）", () => {
    const cache: LedgerAttachCache = new Map();
    const first = attachGoalLedger([summaryMsg("S"), userMsg] as never, () => branch, cache);
    // 第二次本子被（假设地）改了：命中缓存就仍是第一次的文字——压缩条目之前的账本来就不会变
    const second = attachGoalLedger([summaryMsg("S"), userMsg] as never, () => [...branch.slice(0, -1), user("不该读到", 9), branch.at(-1)], cache);
    assert.ok(second !== null);
    assert.equal((first?.[0] as unknown as { summary: string }).summary, (second?.[0] as unknown as { summary: string }).summary);
    assert.equal(cache.size, 1);
  });

  test("压缩之后才发生的改动不进附段（它们在消息流里）；再次压缩后账含新的", () => {
    const later = [...branch, user("再加个 README", 3000), call("g3", "update_goal", { goal: "全部做完" }, 3100), result("g3")];
    const out1 = attachGoalLedger([summaryMsg("S"), userMsg] as never, () => later, new Map());
    assert.doesNotMatch((out1?.[0] as unknown as { summary: string }).summary, /全部做完/);
    const twice = [...later, compaction()];
    const out2 = attachGoalLedger([summaryMsg("S2"), userMsg] as never, () => twice, new Map());
    assert.match((out2?.[0] as unknown as { summary: string }).summary, /Current goal: "全部做完"/);
  });

  test("没有压缩摘要 / 本子里没有压缩条目 / 账是空的 = 不动", () => {
    assert.equal(attachGoalLedger([userMsg] as never, () => branch, new Map()), null);
    assert.equal(attachGoalLedger([summaryMsg("S")] as never, () => [user("hi", 1)], new Map()), null);
    assert.equal(attachGoalLedger([summaryMsg("S")] as never, () => [user("闲聊", 1), compaction()], new Map()), null);
  });

  test("被拒的 update_goal 调用不入账", () => {
    const bad = [user("a", 1), call("g1", "update_goal", { goal: "不该出现" }, 2), result("g1", true), compaction()];
    assert.equal(attachGoalLedger([summaryMsg("S")] as never, () => bad, new Map()), null);
  });
});
