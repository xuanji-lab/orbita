import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@shared/session";
import { childActivityOf, childStateOf, nextTickIn, pillSignal, planWindow, STUCK_MS, toolCallLine } from "./chat-status.ts";

describe("状态卡：计划收着露哪几步", () => {
  const steps = (statuses: string[]) => statuses.map((status, i) => ({ id: `s${i}`, status: status as "done" }));
  it("四步以内全露", () => {
    assert.deepEqual(planWindow(steps(["done", "in_progress", "pending", "pending"]), new Set()).map((row) => row.kind), ["step", "step", "step", "step"]);
  });
  it("两步同时在做（第 2 步靠子会话）：中间做完的折成「N 个步骤」，前后各折一段", () => {
    const rows = planWindow(steps(["done", "done", "waiting", "done", "done", "in_progress", "pending", "pending", "pending"]), new Set(["s2"]));
    assert.deepEqual(rows, [
      { kind: "fold", count: 1, where: "before" },
      { kind: "step", index: 1 },
      { kind: "step", index: 2 },
      { kind: "fold", count: 2, where: "between" },
      { kind: "step", index: 5 },
      { kind: "step", index: 6 },
      { kind: "fold", count: 2, where: "after" },
    ]);
  });
  it("没有在发生的步：露最后做完的一步和下一步", () => {
    const rows = planWindow(steps(["done", "done", "done", "pending", "pending", "pending"]), new Set());
    assert.deepEqual(rows.filter((row) => row.kind === "step"), [
      { kind: "step", index: 2 },
      { kind: "step", index: 3 },
    ]);
  });
});

describe("状态卡：子会话此刻在跑什么", () => {
  const tool = (status: "running" | "complete", at: number): TranscriptRecord =>
    ({ id: `t${at}`, role: "tool", toolCallId: `c${at}`, toolName: "bash", input: { command: "sleep 900" }, content: [], timestamp: at, status, isError: false }) as unknown as TranscriptRecord;
  it("尾巴上 running 的工具记录 = 正在跑的调用", () => {
    assert.deepEqual(childActivityOf([tool("complete", 1), tool("running", 5)]), { toolName: "bash", input: { command: "sleep 900" }, since: 5 });
  });
  it("一条命令跑过十分钟算卡住；通道关了不算在跑", () => {
    const activity = { toolName: "bash", input: {}, since: 0 };
    assert.equal(childStateOf({ channelStatus: "running", needsApproval: false, enginePhaseRunning: false, activity, now: STUCK_MS + 1 }), "stuck");
    assert.equal(childStateOf({ channelStatus: "running", needsApproval: false, enginePhaseRunning: false, activity, now: 60_000 }), "running");
    assert.equal(childStateOf({ channelStatus: "done", needsApproval: false, enginePhaseRunning: false, activity, now: 60_000 }), "done");
  });
  it("调用的一行字：工具名 + 能认出它的参数", () => {
    assert.equal(toolCallLine("bash", { command: "sleep 600\nnext" }), "bash sleep 600");
    assert.equal(toolCallLine("read", { path: "/a/b/TaskProgress.tsx" }), "read TaskProgress.tsx");
    assert.equal(toolCallLine("think", {}), "think");
  });
});

describe("状态卡：走表与小钮", () => {
  it("没有在跑项不走表；都过了一分钟按分钟对齐跳；有不到一分钟的按秒跳", () => {
    assert.equal(nextTickIn([], 0), null);
    assert.equal(nextTickIn([0], 90_000), 30_000);
    assert.equal(nextTickIn([0, 89_500], 90_000), 500);
  });
  it("小钮只说一种：在问你 > 失败 > 卡住 > 在跑", () => {
    assert.deepEqual(pillSignal(["running", "stuck", "failed", "waiting"], 0), { kind: "waiting", count: 1 });
    assert.deepEqual(pillSignal(["running", "stuck"], 0), { kind: "stuck", count: 1 });
    assert.deepEqual(pillSignal(["done"], 1), { kind: "running", count: 1 });
    assert.equal(pillSignal(["done"], 0), null);
  });
});
