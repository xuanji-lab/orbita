import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@shared/session";
import { boardOf, childActivityOf, childStateOf, clampPanelWidth, fitsPanel, groupOutputs, nextTickIn, pillSignal, planWindow, STUCK_MS, toolCallLine } from "./chat-status.ts";

describe("状态卡：计划收着露哪几步", () => {
  const steps = (statuses: string[]) => statuses.map((status, i) => ({ id: `s${i}`, status: status as "done" }));
  it("四步以内全露", () => {
    assert.deepEqual(planWindow(steps(["done", "in_progress", "pending", "pending"]), new Set()).map((row) => row.kind), ["step", "step", "step", "step"]);
  });
  it("两步同时在做（第 2 步靠子会话）：只露这两步，其余折起（前、中、后各一段）", () => {
    const rows = planWindow(steps(["done", "done", "waiting", "done", "done", "in_progress", "pending", "pending", "pending"]), new Set(["s2"]));
    assert.deepEqual(rows, [
      { kind: "fold", count: 2, where: "before" },
      { kind: "step", index: 2 },
      { kind: "fold", count: 2, where: "between" },
      { kind: "step", index: 5 },
      { kind: "fold", count: 3, where: "after" },
    ]);
  });
  it("没有在发生的步：只露下一步待做的；全做完了露最后一步", () => {
    const rows = planWindow(steps(["done", "done", "done", "pending", "pending", "pending"]), new Set());
    assert.deepEqual(rows.filter((row) => row.kind === "step"), [{ kind: "step", index: 3 }]);
    const done = planWindow(steps(["done", "done", "done", "done", "done"]), new Set());
    assert.deepEqual(done.filter((row) => row.kind === "step"), [{ kind: "step", index: 4 }]);
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

describe("状态卡：产物按文件类型分行", () => {
  it("一类一行、行序固定；PPTX 并进演示文稿、Word 并进文档、PDF 自成一行；没有的类型不出行", () => {
    const outs = [
      { kind: "pdf" as const, id: 1 },
      { kind: "web" as const, id: 2 },
      { kind: "slides" as const, id: 3 },
      { kind: "word" as const, id: 4 },
      { kind: "pptx" as const, id: 5 },
      { kind: "board" as const, id: 6 },
      { kind: "file" as const, id: 7 },
    ];
    const groups = groupOutputs(outs);
    assert.deepEqual(groups.map((group) => group.key), ["slides", "doc", "web", "pdf", "board", "file"]);
    assert.deepEqual(groups[0]?.items.map((item) => item.id), [3, 5]);
    // 并进来的 PPTX 再新也排在能渲染的演示文稿之后
    assert.deepEqual(groupOutputs([{ kind: "pptx" as const, id: 1 }, { kind: "slides" as const, id: 2 }])[0]?.items.map((item) => item.id), [2, 1]);
    assert.deepEqual(groups[1]?.items.map((item) => item.id), [4]);
  });
  it("看板结果认出插件名（右栏打开它的看板要用）", () => {
    assert.deepEqual(boardOf({ pluginBoard: { plugin: "kw-engine", title: "解法库" } }), { title: "解法库", plugin: "kw-engine" });
    assert.deepEqual(boardOf({ pluginBoard: { plugin: "orbita-atlas" } }), { title: "orbita-atlas", plugin: "orbita-atlas" });
    assert.equal(boardOf({ other: 1 }), null);
  });
});

describe("状态卡：拖宽的范围（挤对话列）", () => {
  it("340 起；上限取 560、对话区 60%、给对话列留 480 + 间距后剩下的，三者最小；读不出的值回到默认 380", () => {
    assert.equal(clampPanelWidth(200, 2000), 340);
    assert.equal(clampPanelWidth(900, 2000), 560);
    assert.equal(clampPanelWidth(900, 1000), 496);
    assert.equal(clampPanelWidth(380, 860), 356);
    assert.equal(clampPanelWidth(Number.NaN, 2000), 380);
  });
  it("对话区放不下最窄的卡 + 480 的对话列就默认收起", () => {
    assert.equal(fitsPanel(844), true);
    assert.equal(fitsPanel(843), false);
  });
});
