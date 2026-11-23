import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@shared/session";
import { boardCallOf, boardClickAction, boardOf, childActivityOf, childStateOf, clampPanelWidth, fitsPanel, goalHeadline, groupOutputs, nextTickIn, pillSignal, planWindow, statusOutputs, STUCK_MS, thumbCardOf, toolCallLine } from "./chat-status.ts";

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

describe("goalHeadline：卡头目标的短标题", () => {
  it("取第一个冒号前那一句", () => {
    assert.equal(goalHeadline("补上璇玑的「最后一公里」：先把对话里的卡片定稿，再改提示词"), "补上璇玑的「最后一公里」");
    assert.equal(goalHeadline("和用户一起形成两份 benchmark 设计文档：一份 urban planning"), "和用户一起形成两份 benchmark 设计文档");
  });
  it("没有冒号、冒号太靠前或太靠后：用全文", () => {
    assert.equal(goalHeadline("把左栏改成两条左起线"), "把左栏改成两条左起线");
    assert.equal(goalHeadline("改：左栏"), "改：左栏");
    const long = "一".repeat(50) + "：二";
    assert.equal(goalHeadline(long), long);
  });
});

describe("状态卡：看板产物的缩略图与点击", () => {
  const HASH = "a".repeat(64);
  const card = (id: string) => ({ id, title: id, size: "2x2", index: 0, template: HASH, data: { n: id }, state: "ready", usingSample: false, updatedAt: 1 });
  const details = (title: string, cardIds: string[], at: number) => ({
    pluginBoard: { plugin: "planet-forge", displayName: "行星造物", title, source: "installed", draftPath: null, at, tuned: false, cards: cardIds.map(card), skipped: [] },
  });
  const boardRecord = (toolCallId: string, timestamp: number, body: unknown, status: "complete" | "error" = "complete"): TranscriptRecord =>
    ({ id: `r-${toolCallId}`, role: "tool", toolCallId, toolName: "show_plugin_board", input: {}, content: [], timestamp, status, isError: status === "error", details: body }) as unknown as TranscriptRecord;

  it("同名看板展示过几次，缩略图取最后一次成功的那份快照（失败的不算）", () => {
    const records = [
      boardRecord("c1", 10, details("行星", ["old"], 10)),
      boardRecord("c2", 20, details("行星", ["new"], 20)),
      boardRecord("c3", 30, details("行星", ["bad"], 30), "error"),
    ];
    const boards = statusOutputs(records, null).filter((item) => item.kind === "board");
    assert.equal(boards.length, 1);
    assert.equal(boards[0]?.boardCall?.toolCallId, "c2");
    assert.equal(boards[0]?.at, 20);
    assert.equal(thumbCardOf(boards[0]?.boardCall?.result ?? (undefined as never))?.id, "new");
  });
  it("不同标题各自一条，后展示的排前面", () => {
    const records = [boardRecord("c1", 10, details("甲", ["a"], 10)), boardRecord("c2", 20, details("乙", ["b"], 20)), boardRecord("c3", 30, details("甲", ["c"], 30))];
    const boards = statusOutputs(records, null).filter((item) => item.kind === "board");
    assert.deepEqual(boards.map((item) => [item.title, item.boardCall?.toolCallId]), [["甲", "c3"], ["乙", "c2"]]);
  });
  it("缩略图画第一张卡；一张卡都没有（全被跳过）退回图标", () => {
    const withCards = boardCallOf("c1", details("甲", ["first", "second"], 1));
    assert.equal(thumbCardOf(withCards?.result ?? (undefined as never))?.id, "first");
    const empty = boardCallOf("c2", details("乙", [], 1));
    assert.equal(thumbCardOf(empty?.result ?? (undefined as never)), null);
    assert.equal(boardCallOf("c3", { pluginBoard: { plugin: "" } }), null);
  });
  it("点击：主会话自己的看板滚回对话；子会话做的、快照读不出来的直接开插件页", () => {
    const call = boardCallOf("c1", details("甲", ["a"], 1));
    assert.equal(boardClickAction({ by: null, plugin: "planet-forge", boardCall: call }), "reveal");
    assert.equal(boardClickAction({ by: "子会话甲", plugin: "planet-forge", boardCall: call }), "open-plugin");
    assert.equal(boardClickAction({ by: null, plugin: "planet-forge", boardCall: null }), "open-plugin");
  });
});
