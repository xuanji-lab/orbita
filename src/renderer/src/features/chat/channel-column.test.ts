import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  channelInlineMaxWidth,
  channelPanelWide,
  channelWhoLabel,
  delegateAutoOpen,
  reconcileChannelPanel,
  revealChannelPanel,
  toggleChannelPanel,
  nonTaskMessages,
  taskCardBody,
  TASK_CARD_PREVIEW_LINES,
  visibleChannels,
} from "./channel-column.ts";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载（同 channel-column.ts 本身的纪律）
import type { ChannelMessage, ChannelSummary } from "../../../../shared/channel.ts";
import { en } from "../../messages-en.ts";

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
    deepStrictEqual(channelWhoLabel(message({ kind: "task" }), en), { text: "task", tone: "neutral", you: false });
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "progress" }), en),
      { text: "progress", tone: "neutral", you: false },
    );
  });

  it("question 暖黄语气", () => {
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "question" }), en),
      { text: "question", tone: "question", you: false },
    );
  });

  it("reply · steer 强调色；reply · turn end 中性——只有 steer 是需要用户特别留意的那一档", () => {
    deepStrictEqual(
      channelWhoLabel(message({ kind: "reply", delivery: "steer" }), en),
      { text: "reply · steer", tone: "reply", you: false },
    );
    deepStrictEqual(
      channelWhoLabel(message({ kind: "reply", delivery: "followUp" }), en),
      { text: "reply · turn end", tone: "neutral", you: false },
    );
  });

  it("done 绿、failed 红", () => {
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "done" }), en),
      { text: "done", tone: "done", you: false },
    );
    deepStrictEqual(
      channelWhoLabel(message({ from: "child", kind: "failed" }), en),
      { text: "failed", tone: "failed", you: false },
    );
  });

  it("author === user 时 you 为 true——调用方据此追加「· you」（primary 色单独渲染）", () => {
    strictEqual(channelWhoLabel(message({ kind: "reply", author: "user" }), en).you, true);
    strictEqual(channelWhoLabel(message({ kind: "task", author: "model" }), en).you, false);
  });
});

describe("channelPanelWide（够宽 = chat | 父子会话面板 | 右栏 三栏都放得下，用户 2026-09-25 裁决）", () => {
  // paneWidth 是 `.pane`（chat + 父子会话面板 + 右栏三者的和）本身的宽度，不是窗口宽度——
  // 窗口减去侧栏、图标条与边距之后剩下的才是 pane，两者不能混用。两个宽度都是**设置值**，
  // 函数内部按 pane 夹过再算
  const wide = (over: Partial<Parameters<typeof channelPanelWide>[0]> = {}) =>
    channelPanelWide({ narrow: false, paneWidth: 1294, rightPanelWidth: 499, channelWidth: 381, ...over });

  it("全屏（用户机器上的设置：右栏 499、通道列 381，pane 1294）：chat 530 ≥ 480，够宽", () => {
    strictEqual(wide(), true);
  });

  // 这一刀的由来：1200px 窗口里先开 Sub-sessions 再开父子会话面板，以前浮起来盖在右栏上
  it("1200px 窗口（pane 832、右栏 320、通道列 300）：三栏放不下，不够宽——父子会话面板进槽", () => {
    strictEqual(wide({ paneWidth: 832, rightPanelWidth: 320, channelWidth: 300 }), false);
  });

  it("边界取等：chat 恰好剩 480 算够宽，差 1px 就不够", () => {
    // pane 1080：右栏夹到 1/3 = 360，通道列夹到 (1080-360)/3 = 240，chat = 480
    strictEqual(wide({ paneWidth: 1080, rightPanelWidth: 320, channelWidth: 300 }), true);
    strictEqual(wide({ paneWidth: 1079, rightPanelWidth: 320, channelWidth: 300 }), false);
  });

  it("两个宽度都按夹过的值算：右栏设置 2000 也只按 pane 的 2/3 计", () => {
    strictEqual(wide({ paneWidth: 1600, rightPanelWidth: 2000, channelWidth: 300 }), false);
    strictEqual(wide({ paneWidth: 1600, rightPanelWidth: 320, channelWidth: 300 }), true);
  });

  it("全局窄窗恒不够宽——pane 按数字算明明够，narrow 仍然压过它", () => {
    strictEqual(wide({ narrow: true, paneWidth: 3000 }), false);
  });

  it("pane 量不到（<=0 或 NaN，还没挂载测出来）：保守当不够宽，不擅自挤主槽", () => {
    strictEqual(wide({ paneWidth: 0 }), false);
    strictEqual(wide({ paneWidth: -1 }), false);
    strictEqual(wide({ paneWidth: Number.NaN }), false);
  });
});

describe("channelInlineMaxWidth（内联列拖宽的上限，与 channelPanelWide 同一套算法）", () => {
  it("拖到上限恰好还够宽，多 1px 就翻成不够宽——所以拖宽不能越过它", () => {
    // pane 1050：右栏夹到 350，C = 700，通道列区间 [180, 233]，上限 1050-350-480 = 220
    const max = channelInlineMaxWidth({ paneWidth: 1050, rightPanelWidth: 320 });
    strictEqual(max, 220);
    strictEqual(channelPanelWide({ narrow: false, paneWidth: 1050, rightPanelWidth: 320, channelWidth: max }), true);
    strictEqual(
      channelPanelWide({ narrow: false, paneWidth: 1050, rightPanelWidth: 320, channelWidth: max + 1 }),
      false,
    );
  });

  it("上限高于 1/3 天花板时不起作用：拖宽本来就被 chat 区的 1/3 夹住，怎么拖都够宽", () => {
    // 全屏：上限 1294-499-480 = 315，而 1/3 天花板是 (1294-499)/3 = 265
    strictEqual(channelInlineMaxWidth({ paneWidth: 1294, rightPanelWidth: 499 }), 315);
    strictEqual(channelPanelWide({ narrow: false, paneWidth: 1294, rightPanelWidth: 499, channelWidth: 5000 }), true);
  });
});

describe("reconcileChannelPanel（宽窄切换时父子会话面板去哪）", () => {
  it("够宽时槽里是父子会话面板（窄时放进去的）：挪回内联，槽空出来", () => {
    deepStrictEqual(
      reconcileChannelPanel({ wide: true, wasWide: false, inlineWasOpen: false, rightPanel: "channels" }),
      { rightPanel: null, shown: true },
    );
  });

  it("够宽 → 不够宽，内联列正显示、槽空着：它进槽，继承槽宽", () => {
    deepStrictEqual(
      reconcileChannelPanel({ wide: false, wasWide: true, inlineWasOpen: true, rightPanel: null }),
      { rightPanel: "channels" },
    );
  });

  // 用户 2026-09-25：你正在右栏里看的东西不会因为拖了下窗口就被换掉
  it("够宽 → 不够宽，槽里有别的（子会话工作记录）：那个留下，父子会话面板收起（shown 不动，拖回来自己回）", () => {
    strictEqual(
      reconcileChannelPanel({ wide: false, wasWide: true, inlineWasOpen: true, rightPanel: "subsessions" }),
      null,
    );
  });

  it("够宽 → 不够宽，但内联列本来就没显示：什么都不动", () => {
    strictEqual(reconcileChannelPanel({ wide: false, wasWide: true, inlineWasOpen: false, rightPanel: null }), null);
  });

  it("一直不够宽时关掉槽里的面板：不冒出父子会话面板——进槽只发生在切换那一拍", () => {
    strictEqual(reconcileChannelPanel({ wide: false, wasWide: false, inlineWasOpen: true, rightPanel: null }), null);
  });

  it("一直够宽、槽里是别的：不动（三分屏）", () => {
    strictEqual(reconcileChannelPanel({ wide: true, wasWide: true, inlineWasOpen: true, rightPanel: "files" }), null);
  });
});

describe("toggleChannelPanel / revealChannelPanel（入口点击与点标记）", () => {
  it("够宽：入口开关内联列，与槽无关", () => {
    deepStrictEqual(toggleChannelPanel({ wide: true, inlineOpen: true, rightPanel: "subsessions" }), { shown: false });
    deepStrictEqual(toggleChannelPanel({ wide: true, inlineOpen: false, rightPanel: null }), { shown: true });
  });

  it("不够宽：同其它入口的互斥——不在槽里就替换进去（继承槽宽）", () => {
    deepStrictEqual(toggleChannelPanel({ wide: false, inlineOpen: false, rightPanel: "subsessions" }), {
      rightPanel: "channels",
    });
    deepStrictEqual(toggleChannelPanel({ wide: false, inlineOpen: false, rightPanel: null }), { rightPanel: "channels" });
  });

  it("不够宽、已在槽里：收起，并记成显式不显示——拖回够宽时不自己冒出来", () => {
    deepStrictEqual(toggleChannelPanel({ wide: false, inlineOpen: false, rightPanel: "channels" }), {
      rightPanel: null,
      shown: false,
    });
  });

  it("点标记是「打开并看这里」不是开关：够宽开内联列，不够宽换进槽", () => {
    deepStrictEqual(revealChannelPanel(true), { shown: true });
    deepStrictEqual(revealChannelPanel(false), { rightPanel: "channels" });
  });
});

describe("delegateAutoOpen（母会话刚派出子会话时自动弹出什么，用户 2026-09-25 裁决）", () => {
  it("不够宽、槽空着：弹子会话工作记录，父子会话面板不出（它只能进槽，会抢同一个位置）", () => {
    deepStrictEqual(delegateAutoOpen({ wide: false, rightPanel: null }), { openSubSession: true, showChannel: false });
  });

  it("够宽、槽空着：工作记录与父子会话面板一起出，三分屏", () => {
    deepStrictEqual(delegateAutoOpen({ wide: true, rightPanel: null }), { openSubSession: true, showChannel: true });
  });

  it("槽里本来就是子会话面板（一轮里连派几条）：换到最新那条", () => {
    strictEqual(delegateAutoOpen({ wide: false, rightPanel: "subsessions" }).openSubSession, true);
  });

  it("槽里是用户正看着的别的面板：不换；够宽时父子会话面板照样在旁边出来", () => {
    for (const panel of ["files", "skills", "mcp", "drawer", "channels"] as const) {
      strictEqual(delegateAutoOpen({ wide: false, rightPanel: panel }).openSubSession, false, panel);
    }
    deepStrictEqual(delegateAutoOpen({ wide: true, rightPanel: "files" }), { openSubSession: false, showChannel: true });
  });
});
