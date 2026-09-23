import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  channelColumnLayout,
  channelWhoLabel,
  nonTaskMessages,
  taskCardBody,
  TASK_CARD_PREVIEW_LINES,
  visibleChannels,
} from "./channel-column.ts";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载（同 channel-column.ts 本身的纪律）
import type { ChannelMessage, ChannelSummary } from "../../../../shared/channel.ts";

function summary(overrides: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    parentId: "p1",
    childId: "c1",
    childTitle: "子任务",
    status: "running",
    messageCount: 1,
    lastAt: 1,
    hasExchange: false,
    ...overrides,
  };
}

describe("visibleChannels", () => {
  it("hasExchange 为 true 的通道显示；只有 task（hasExchange false）且不在跑的不显示", () => {
    const summaries = new Map([
      ["c1", summary({ childId: "c1", hasExchange: true })],
      ["c2", summary({ childId: "c2", hasExchange: false })],
    ]);
    const result = visibleChannels(summaries, () => false);
    deepStrictEqual(result.entries.map((e) => e.summary.childId), ["c1"]);
  });

  it("只派出没说话、但子还在跑的通道也显示——liveRunning 是第二个放行条件", () => {
    const summaries = new Map([["c1", summary({ childId: "c1", hasExchange: false })]]);
    strictEqual(visibleChannels(summaries, () => true).entries.length, 1);
    strictEqual(visibleChannels(summaries, () => false).entries.length, 0);
  });

  it("按 lastAt 倒序——最近有动静的排最上面", () => {
    const summaries = new Map([
      ["old", summary({ childId: "old", hasExchange: true, lastAt: 1 })],
      ["new", summary({ childId: "new", hasExchange: true, lastAt: 9 })],
      ["mid", summary({ childId: "mid", hasExchange: true, lastAt: 5 })],
    ]);
    deepStrictEqual(
      visibleChannels(summaries, () => false).entries.map((e) => e.summary.childId),
      ["new", "mid", "old"],
    );
  });

  it("liveRunning 按各自的 childId 分别判定，不是全通道一刀切", () => {
    const summaries = new Map([
      ["running", summary({ childId: "running", hasExchange: false })],
      ["idle", summary({ childId: "idle", hasExchange: false })],
    ]);
    const result = visibleChannels(summaries, (childId) => childId === "running");
    deepStrictEqual(result.entries.map((e) => e.summary.childId), ["running"]);
  });

  it("有往来的通道 defaultCollapsed=false（默认展开）；只派出没说话的 defaultCollapsed=true（默认折叠成一行头部）", () => {
    const summaries = new Map([
      ["talked", summary({ childId: "talked", hasExchange: true })],
      ["silent", summary({ childId: "silent", hasExchange: false })],
    ]);
    const { entries } = visibleChannels(summaries, () => true);
    deepStrictEqual(
      entries.map((e) => [e.summary.childId, e.defaultCollapsed]),
      [
        ["talked", false],
        ["silent", true],
      ],
    );
  });

  it("autoShow 只由有往来的通道触发——用户裁决：通信始于子会话有提问需求的时候", () => {
    const onlySilent = new Map([["c1", summary({ childId: "c1", hasExchange: false })]]);
    strictEqual(visibleChannels(onlySilent, () => true).autoShow, false);
    const withExchange = new Map([
      ["c1", summary({ childId: "c1", hasExchange: false })],
      ["c2", summary({ childId: "c2", hasExchange: true })],
    ]);
    strictEqual(visibleChannels(withExchange, () => true).autoShow, true);
    strictEqual(visibleChannels(new Map(), () => true).autoShow, false);
  });
});

describe("nonTaskMessages", () => {
  it("过滤掉 kind === task，保留其余顺序不变", () => {
    const messages = [
      message({ id: "m1", kind: "task" }),
      message({ id: "m2", from: "child", kind: "question" }),
      message({ id: "m3", kind: "reply" }),
    ];
    deepStrictEqual(nonTaskMessages(messages).map((m) => m.id), ["m2", "m3"]);
  });

  it("只有 task 的通道过滤后是空数组——通道列该显示空态而不是那条 task", () => {
    deepStrictEqual(nonTaskMessages([message({ kind: "task" })]), []);
  });
});

describe("taskCardBody", () => {
  it("行数不超过预览行数：hasMore 恒 false，body 原样返回", () => {
    const text = "line1\nline2\nline3";
    deepStrictEqual(taskCardBody(text, false), { body: text, hasMore: false });
    deepStrictEqual(taskCardBody(text, true), { body: text, hasMore: false });
  });

  it("超过预览行数、未展开：截断到前 N 行，hasMore=true", () => {
    const lines = Array.from({ length: TASK_CARD_PREVIEW_LINES + 5 }, (_, i) => `line${i}`);
    const text = lines.join("\n");
    const result = taskCardBody(text, false);
    strictEqual(result.hasMore, true);
    deepStrictEqual(result.body, lines.slice(0, TASK_CARD_PREVIEW_LINES).join("\n"));
  });

  it("超过预览行数、已展开：body 是全文，hasMore 仍 true（好让用户收回去）", () => {
    const lines = Array.from({ length: TASK_CARD_PREVIEW_LINES + 5 }, (_, i) => `line${i}`);
    const text = lines.join("\n");
    const result = taskCardBody(text, true);
    strictEqual(result.hasMore, true);
    deepStrictEqual(result.body, text);
  });

  it("边界：恰好等于预览行数不算超过", () => {
    const lines = Array.from({ length: TASK_CARD_PREVIEW_LINES }, (_, i) => `line${i}`);
    const text = lines.join("\n");
    strictEqual(taskCardBody(text, false).hasMore, false);
  });
});

function message(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "m1",
    from: "parent",
    author: "model",
    kind: "task",
    text: "去干活",
    delivery: "followUp",
    createdAt: 1,
    ...overrides,
  };
}

describe("channelWhoLabel", () => {
  it("task / progress 文案原样、语气中性", () => {
    deepStrictEqual(channelWhoLabel(message({ kind: "task" })), { text: "task", tone: "neutral", you: false });
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "progress" })),
      { text: "progress", tone: "neutral", you: false },
    );
  });

  it("question 暖黄语气", () => {
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "question" })),
      { text: "question", tone: "question", you: false },
    );
  });

  it("reply · steer 强调色；reply · turn end 中性——只有 steer 是需要用户特别留意的那一档", () => {
    deepStrictEqual(
      channelWhoLabel(message({ kind: "reply", delivery: "steer" })),
      { text: "reply · steer", tone: "reply", you: false },
    );
    deepStrictEqual(
      channelWhoLabel(message({ kind: "reply", delivery: "followUp" })),
      { text: "reply · turn end", tone: "neutral", you: false },
    );
  });

  it("done 绿、failed 红", () => {
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "done" })),
      { text: "done", tone: "done", you: false },
    );
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "failed" })),
      { text: "failed", tone: "failed", you: false },
    );
  });

  it("author === user 时 you 为 true——调用方据此追加「· you」（primary 色单独渲染）", () => {
    strictEqual(channelWhoLabel(message({ kind: "reply", author: "user" })).you, true);
    strictEqual(channelWhoLabel(message({ kind: "task", author: "model" })).you, false);
  });
});

describe("channelColumnLayout（子会话 PR4c fix：右栏+通道列同开时主槽被挤到 ~200px 的 CDP 实测 bug）", () => {
  // paneWidth 是 `.pane`（chat + 通道列 + 右栏三者的和）本身的宽度，不是窗口宽度——
  // 窗口减去侧栏 288 + 图标条 32 + 边距之后剩下的才是 pane，两者不能混用
  const layout = (over: Partial<Parameters<typeof channelColumnLayout>[0]> = {}) =>
    channelColumnLayout({ narrow: false, paneWidth: 900, rightPanelWidth: 0, columnWidth: 300, ...over });

  it("全局窄窗恒 overlay——右栏那时也已经转覆盖层，不占 flex 空间，不需要量", () => {
    // paneWidth 给一个「按数字算明明够」的值，narrow 仍然应该压过它
    strictEqual(layout({ narrow: true, paneWidth: 2000, rightPanelWidth: 0 }), "overlay");
  });

  it("非窄窗、右栏关着、pane 够宽：chat = 900 - 0 - 300 = 600 ≥ 480，inline", () => {
    strictEqual(layout({ rightPanelWidth: 0 }), "inline");
  });

  it("复现报告的 bug：pane 900、右栏开着占 500（比例上限允许它这么宽）——chat = 900-500-300=100，" +
      "旧逻辑（不管右栏）会硬塞出一个 300px 通道列，主槽被压到 100px；新逻辑判 overlay", () => {
    strictEqual(layout({ paneWidth: 900, rightPanelWidth: 500 }), "overlay");
  });

  it("右栏开着但不算太宽：chat = 900-200-300=400，仍不够 480，overlay", () => {
    strictEqual(layout({ paneWidth: 900, rightPanelWidth: 200 }), "overlay");
  });

  it("用户刚打开的右栏优先，通道列让位——同一个 pane 宽度下，右栏越宽，通道列越容易被挤成 overlay", () => {
    strictEqual(layout({ paneWidth: 1080, rightPanelWidth: 0 }), "inline"); // 1080-0-300=780
    strictEqual(layout({ paneWidth: 1080, rightPanelWidth: 300 }), "inline"); // 1080-300-300=480，刚好够
    strictEqual(layout({ paneWidth: 1080, rightPanelWidth: 301 }), "overlay"); // 多 1px 右栏就不够了
  });

  it("边界取等：chat 恰好剩 480 算够（inline），差一点点就不够（overlay）", () => {
    strictEqual(layout({ paneWidth: 1080, rightPanelWidth: 300 }), "inline"); // 1080-300-300=480
    strictEqual(layout({ paneWidth: 1079, rightPanelWidth: 300 }), "overlay"); // 差 1px
  });

  it("右栏关着（宽度 0）时不再重复减一次——300px 通道列本身够不够全看它自己", () => {
    strictEqual(layout({ paneWidth: 780, rightPanelWidth: 0 }), "inline"); // 780-0-300=480
    strictEqual(layout({ paneWidth: 779, rightPanelWidth: 0 }), "overlay");
  });

  it("paneWidth 量不到（<=0，还没挂载测出来）：保守走 overlay，不擅自挤主槽", () => {
    strictEqual(layout({ paneWidth: 0 }), "overlay");
    strictEqual(layout({ paneWidth: -1 }), "overlay");
  });
});
