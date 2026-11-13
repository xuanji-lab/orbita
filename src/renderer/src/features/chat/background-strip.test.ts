import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { ChannelMessage } from "@shared/channel";
import type { Automation } from "../../../../shared/automation.ts";
import type { Messages } from "../../messages-en.ts";
import {
  BG_INLINE_MAX,
  BG_LINGER_MS,
  automationLine,
  backgroundItems,
  bgInlineCap,
  bgSummary,
  foldBgItems,
  needsClock,
  failureDigested,
  parentFactsFrom,
  sameBgItems,
  stepText,
  visibleBgItems,
  type BackgroundItemsInput,
  type ParentFacts,
  type BgAutomationItem,
  type BgItem,
  type BgSubItem,
} from "./background-strip.ts";
import type { HomeCardLineText } from "./home-cards.ts";

/** 文案表用测试自己的桩：纯函数只做拼接，不依赖真实翻译 */
const t = {
  bgStrip: {
    running: (n: number) => `${n} 项在跑`,
    waiting: (n: number) => `${n} 项等你`,
    failed: (n: number) => `${n} 项失败`,
    done: (n: number) => `${n} 项完成`,
    scheduled: (n: number) => `${n} 项待运行`,
    automationDue: "已到点，这一轮结束后送达",
  },
  automation: {
    next: (when: string) => `下次 ${when}`,
    today: "今天",
    tomorrow: "明天",
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
  },
  subSessions: { rowStatus: { approval: "需要批准" } },
  channel: {
    notSpokenRunning: "在跑 · 还没说话",
    notSpoken: "还没说话",
    latestQuestion: (text: string) => `问：${text}`,
    latestProgress: (text: string) => `进度：${text}`,
    latestDone: "完成",
    latestFailed: "失败",
    latestReply: (text: string) => `回复：${text}`,
  },
} as unknown as Messages;

const lineText: HomeCardLineText = {
  thinking: "在想",
  doing: (step, now) => `${step}：${now}`,
  approve: (what) => `等你批准：${what}`,
  childWaiting: "子会话在等你批准",
  failed: "出错停下了",
  done: "跑完了",
  noText: "（没有文字）",
  verb: (toolName) => toolName,
};

const PARENT = "root";
const T0 = 1_000_000;

interface Fixture {
  channel?: Record<string, { status: "running" | "waiting" | "done" | "failed" | "stopped"; lastAt: number }>;
  phase?: Record<string, string>;
  approvals?: Record<string, number>;
  automations?: Automation[];
  children?: string[];
  now?: number;
  /** 母会话已处理过的失败子会话 */
  digested?: string[];
}

function input(f: Fixture): BackgroundItemsInput {
  const ids = f.children ?? Object.keys({ ...f.channel, ...f.phase });
  return {
    parentId: PARENT,
    children: ids.map((id, index) => ({ id, title: `子会话 ${id}`, createdAt: T0 + index })),
    channelOf: (id) => f.channel?.[id],
    probe: { approvalCountOf: (id) => f.approvals?.[id] ?? 0, phaseOf: (id) => f.phase?.[id] ?? "idle" },
    automations: f.automations ?? [],
    failureDigested: (id) => f.digested?.includes(id) === true,
    now: f.now ?? T0 + 60_000,
  };
}

function automation(over: Partial<Automation> & Pick<Automation, "id">): Automation {
  return {
    title: `自动化 ${over.id}`,
    prompt: "do it",
    schedule: { kind: "daily", time: "09:00" },
    target: { kind: "this_session", sessionId: PARENT, workspaceId: null },
    mode: "readOnly",
    status: "active",
    createdBy: { kind: "user" },
    nextRunAt: T0 + 3_600_000,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  } as Automation;
}

const ids = (items: readonly BgItem[]): string[] => items.map((item) => (item.kind === "sub" ? item.childId : item.automationId));

describe("backgroundItems —— 后台有什么", () => {
  test("零项：没有子会话、没有自动化 = 空数组（调用方据此整条不渲染）", () => {
    assert.deepEqual(backgroundItems(input({})), []);
    assert.deepEqual(backgroundItems(input({ children: ["a", "b"] })), []);
  });

  test("在跑的子会话入选；通道 running 但引擎 idle（建了没在跑）与用户停掉的不入选", () => {
    const items = backgroundItems(
      input({
        channel: { run: { status: "running", lastAt: T0 }, quiet: { status: "running", lastAt: T0 }, halted: { status: "stopped", lastAt: T0 } },
        phase: { run: "turn", halted: "turn" },
      }),
    );
    assert.deepEqual(ids(items), ["run"]);
    assert.equal((items[0] as BgSubItem).status, "running");
  });

  test("只有等你：问问题的（通道 waiting）与挂着审批的各算一项，状态各自对", () => {
    const items = backgroundItems(
      input({
        channel: { ask: { status: "waiting", lastAt: T0 }, gate: { status: "running", lastAt: T0 } },
        phase: { gate: "turn" },
        approvals: { gate: 1 },
      }),
    );
    assert.deepEqual(
      items.map((item) => (item.kind === "sub" ? item.status : item.kind)).sort(),
      ["approval", "waiting"],
    );
    assert.equal(bgSummary(items, t), "2 项等你");
    // 全是等你时画面静止：条的 1 秒时钟不用走
    assert.equal(needsClock(items), false);
  });

  test("排序沿用收件箱的同一个函数：等你最前，其次在跑，其次失败，其次完成；同组新的在前", () => {
    const items = backgroundItems(
      input({
        channel: {
          doneOld: { status: "done", lastAt: T0 + 59_000 },
          run1: { status: "running", lastAt: T0 + 1000 },
          run2: { status: "running", lastAt: T0 + 2000 },
          ask: { status: "waiting", lastAt: T0 },
          bad: { status: "failed", lastAt: T0 + 58_000 },
        },
        phase: { run1: "turn", run2: "turn" },
      }),
    );
    assert.deepEqual(ids(items), ["ask", "run2", "run1", "bad", "doneOld"]);
  });

  test("完成后停留 BG_LINGER_MS 再退场（以通道最后一条消息为完成时刻）：差 1 毫秒还在，到点就没", () => {
    const channel = { fin: { status: "done" as const, lastAt: T0 } };
    assert.deepEqual(ids(backgroundItems(input({ channel, now: T0 + BG_LINGER_MS - 1 }))), ["fin"]);
    assert.deepEqual(ids(backgroundItems(input({ channel, now: T0 + BG_LINGER_MS }))), []);
    // 条自己的 1 秒时钟用 visibleBgItems 做同一判断，不等上游重算
    const early = backgroundItems(input({ channel, now: T0 }));
    assert.equal(visibleBgItems(early, T0 + BG_LINGER_MS - 1).length, 1);
    assert.equal(visibleBgItems(early, T0 + BG_LINGER_MS).length, 0);
    assert.equal(needsClock(early), true);
  });

  test("失败项不按秒数退场：隔多久都在，直到母会话处理过；只剩失败项时画面静止，不开时钟", () => {
    const channel = { boom: { status: "failed" as const, lastAt: T0 } };
    for (const now of [T0 + BG_LINGER_MS, T0 + 100 * BG_LINGER_MS]) {
      assert.deepEqual(ids(backgroundItems(input({ channel, now }))), ["boom"]);
    }
    const kept = backgroundItems(input({ channel, now: T0 + 100 * BG_LINGER_MS }));
    assert.equal(visibleBgItems(kept, T0 + 1000 * BG_LINGER_MS).length, 1);
    assert.equal(needsClock(kept), false);
    assert.deepEqual(ids(backgroundItems(input({ channel, digested: ["boom"] }))), []);
  });

  test("停留期内又开始跑了（父会话回信重开）：按在跑算，不被当成已完成退场", () => {
    const items = backgroundItems(
      input({ channel: { again: { status: "done", lastAt: T0 } }, phase: { again: "turn" }, now: T0 + 10 * BG_LINGER_MS }),
    );
    assert.deepEqual(items.map((item) => (item.kind === "sub" ? item.status : "")), ["running"]);
    assert.equal(visibleBgItems(items, T0 + 100 * BG_LINGER_MS).length, 1);
  });

  test("自动化：只收目标是本会话、在排期、有下次时间的；写下次运行时间；子会话在前，自动化按时间早的在前", () => {
    const items = backgroundItems(
      input({
        channel: { run: { status: "running", lastAt: T0 } },
        phase: { run: "turn" },
        automations: [
          automation({ id: "late", nextRunAt: T0 + 7_200_000 }),
          automation({ id: "soon", nextRunAt: T0 + 60_000_000 - 59_000_000 }),
          automation({ id: "elsewhere", target: { kind: "this_session", sessionId: "other", workspaceId: null } }),
          automation({ id: "fresh", target: { kind: "new_session", workspaceId: null } }),
          automation({ id: "paused", status: "paused" }),
          automation({ id: "none", nextRunAt: null }),
        ],
      }),
    );
    assert.deepEqual(ids(items), ["run", "soon", "late"]);
    assert.equal(bgSummary(items, t), "1 项在跑 · 2 项待运行");
    const soon = items[1] as BgAutomationItem;
    assert.match(automationLine(soon, T0, t), /^下次 /);
  });

  test("自动化已到点、在等本会话这一轮结束：条里说清楚，不写一个过期的下次时间", () => {
    const [item] = backgroundItems(
      input({ automations: [automation({ id: "due", pendingDelivery: { since: T0, trigger: "schedule", merged: 0 } })] }),
    ) as BgAutomationItem[];
    assert.equal(item?.due, true);
    assert.equal(automationLine(item as BgAutomationItem, T0, t), "已到点，这一轮结束后送达");
  });
});

describe("条头事实与折叠", () => {
  const sub = (childId: string, status: BgSubItem["status"], lastAt = T0): BgSubItem => ({
    kind: "sub",
    key: `sub:${childId}`,
    childId,
    title: childId,
    status,
    startedAt: T0,
    lastAt,
  });

  test("「2 项在跑 · 1 项等你」：固定顺序，为 0 的档不出现", () => {
    const items = [sub("a", "running"), sub("b", "running"), sub("c", "waiting")];
    assert.equal(bgSummary(items, t), "2 项在跑 · 1 项等你");
    assert.equal(bgSummary([sub("c", "approval")], t), "1 项等你");
    assert.equal(bgSummary([], t), "");
  });

  test("超过上限折叠：细条并排 3 项，其余只给个数；刚好等于上限不折", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => sub(id, "running"));
    const inline = foldBgItems(six);
    assert.equal(inline.shown.length, BG_INLINE_MAX);
    assert.equal(inline.hidden.length, 3);
    assert.equal(foldBgItems(six.slice(0, 3)).hidden.length, 0);
  });

  test("细条一行并排几项跟着它自己的宽度走：宽的 3 项，常见的 693 宽 2 项，再窄 1 项", () => {
    assert.equal(bgInlineCap(900), 3);
    assert.equal(bgInlineCap(693), 2);
    assert.equal(bgInlineCap(640), 2);
    assert.equal(bgInlineCap(560), 1);
    assert.equal(bgInlineCap(429), 1);
    assert.equal(bgInlineCap(189), 1);
    assert.equal(bgInlineCap(0), 1);
    assert.equal(bgInlineCap(Infinity), BG_INLINE_MAX);
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => sub(id, "running"));
    assert.equal(foldBgItems(six, bgInlineCap(189)).shown.length, 1);
    assert.equal(foldBgItems(six, bgInlineCap(189)).hidden.length, 5);
  });

  test("sameBgItems：逐字段相同才算没变（状态、完成时刻、自动化的下次时间任一变了都要重画）", () => {
    const a = [sub("a", "running")];
    assert.equal(sameBgItems(a, [sub("a", "running")]), true);
    assert.equal(sameBgItems(a, [sub("a", "waiting")]), false);
    assert.equal(sameBgItems(a, [sub("a", "running", T0 + 1)]), false);
    assert.equal(sameBgItems(a, []), false);
    const auto = (nextRunAt: number): BgAutomationItem => ({ kind: "automation", key: "automation:x", automationId: "x", title: "x", nextRunAt, due: false });
    assert.equal(sameBgItems([auto(1)], [auto(1)]), true);
    assert.equal(sameBgItems([auto(1)], [auto(2)]), false);
  });
});

describe("stepText —— 每项当前在做的那一步", () => {
  const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
    ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
  const user = (id: string, timestamp: number): TranscriptItem =>
    ({ id, role: "user", content: [{ type: "text", text: "go" }], timestamp }) as TranscriptItem;
  const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
    ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
  const plan = (items: { text: string; status: string }[]): TranscriptItem =>
    tool({ toolCallId: "p1", toolName: "update_plan", input: { items } as never, timestamp: 2001 });
  const base = { messages: undefined, approval: null } as const;

  test("在跑且有计划：取计划里 in_progress 那一步的文字，原样，不带章节", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "text", text: "先读代码。" }, { type: "toolCall", toolCallId: "p1", toolName: "update_plan", input: {} }]),
      plan([
        { text: "读代码", status: "done" },
        { text: "写测试", status: "in_progress" },
        { text: "提交", status: "pending" },
      ]),
      assistant("a2", 3000, [{ type: "text", text: "`a.ts` 里没有，换个地方找。" }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records }, t, lineText), "写测试");
  });

  test("在跑但没有计划：退到最近的动作（最后一次工具调用的动词 + 对象，没动过工具是「在想」），不是空白也不是占位符", () => {
    const withTool = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "sleep 30" } }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records: withTool }, t, lineText), "bash sleep 30");
    assert.equal(stepText({ ...base, status: "running", records: [user("u1", 1000)] }, t, lineText), "在想");
  });

  test("最近的动作不取章节标题：思考原话（常是英文自言自语）不进状态条，只有思考没动工具说「在想」", () => {
    const thinkingOnly = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "thinking", thinking: "I should not call bash since the system forbids it" }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records: thinkingOnly }, t, lineText), "在想");
    const saidThenRan = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "text", text: "先看看目录。" }, { type: "toolCall", toolCallId: "l1", toolName: "ls", input: { path: "src" } }]),
      assistant("a2", 3000, [{ type: "text", text: "再读一个文件，看看里面写了什么。" }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records: saidThenRan }, t, lineText), "ls src");
  });

  test("最近的动作只看这一轮，记账工具（update_plan）不算动作", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "toolCall", toolCallId: "b0", toolName: "bash", input: { command: "上一轮的命令" } }]),
      user("u2", 3000),
      assistant("a2", 4000, [{ type: "toolCall", toolCallId: "p9", toolName: "update_plan", input: { items: [] } }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records }, t, lineText), "在想");
  });

  test("在跑、计划里没有在做的步（全待做 / 全做完）：也退到最近的动作", () => {
    const records = [
      user("u1", 1000),
      plan([{ text: "收尾", status: "done" }]),
      assistant("a1", 3000, [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "ls" } }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records }, t, lineText), "bash ls");
  });

  test("槽没载过（重开应用后没打开过它）：退到通道里它最近说的一句", () => {
    const messages: ChannelMessage[] = [
      { id: "t", from: "parent", author: "model", kind: "task", text: "任务", delivery: "steer", createdAt: 1 },
      { id: "p", from: "child", author: "model", kind: "progress", text: "写完一半", delivery: "followUp", createdAt: 2 },
    ];
    assert.equal(stepText({ status: "running", records: null, messages, approval: null }, t, lineText), "进度：写完一半");
    assert.equal(stepText({ status: "running", records: null, messages: undefined, approval: null }, t, lineText), "在跑 · 还没说话");
  });

  test("等审批：要批的是什么；在问你：它问的那句；完成 / 失败：通道里的结语", () => {
    assert.equal(
      stepText({ ...base, status: "approval", records: null, approval: { toolName: "bash", input: { command: "rm x" } } }, t, lineText),
      "等你批准：bash rm x",
    );
    const asked: ChannelMessage[] = [
      { id: "q", from: "child", author: "model", kind: "question", text: "合并哪个分支？\n补充", delivery: "followUp", createdAt: 3 },
    ];
    assert.equal(stepText({ ...base, status: "waiting", records: null, messages: asked }, t, lineText), "问：合并哪个分支？");
    const finished: ChannelMessage[] = [
      { id: "d", from: "child", author: "model", kind: "done", text: "好了", delivery: "followUp", createdAt: 4 },
    ];
    assert.equal(stepText({ ...base, status: "done", records: null, messages: finished }, t, lineText), "完成");
  });
});

describe("failureDigested —— 失败回报，母会话处理过没有", () => {
  const FAIL = { id: "m-fail", at: 1000 };
  const D = { messageId: "m-fail", timestamp: 1500 };
  /** 母会话：投递在 1500 开了一轮（边界）；assistantAts 是这条母会话里全部助手消息的时间 */
  const parent = (over: Partial<ParentFacts> = {}): ParentFacts => ({
    phase: "idle",
    deliveries: [],
    boundaries: [],
    assistantAts: [],
    windowStartAt: null,
    ...over,
  });
  const digested = (facts: ParentFacts | null, extra: { failed?: typeof FAIL | null; loaded?: boolean } = {}): boolean =>
    failureDigested({
      failed: extra.failed === undefined ? FAIL : extra.failed,
      fallbackAt: FAIL.at,
      messagesLoaded: extra.loaded ?? true,
      parent: facts,
    });

  test("失败后母会话未动：回报还没投递（母转录里没有这条的投递痕迹），失败项留着；母会话之前说的话不算处理", () => {
    assert.equal(digested(parent({ assistantAts: [900], boundaries: [100] })), false);
    assert.equal(digested(parent({ assistantAts: [900, 2000], boundaries: [100, 1900], deliveries: [] })), false);
  });

  test("母会话正在跑（消化这条失败的那一轮没结束）：失败项还在，哪怕那一轮已经在流式输出", () => {
    assert.equal(digested(parent({ phase: "turn", deliveries: [D], boundaries: [1500], assistantAts: [1600] })), false);
  });

  test("母会话完成一轮（已投递、这一轮产出了助手消息、母会话 idle）：退场", () => {
    assert.equal(digested(parent({ deliveries: [D], boundaries: [1500], assistantAts: [1800] })), true);
  });

  test("消化完之后母会话又开了别的新轮（正在跑）：失败项不会被叫回来——看的是消化它的那一轮，不是此刻的 phase", () => {
    assert.equal(
      digested(parent({ phase: "turn", deliveries: [D], boundaries: [1500, 3000], assistantAts: [1800, 3100] })),
      true,
    );
  });

  test("母会话被打断、没产出助手消息：失败项继续留着；别的消息的投递不算", () => {
    assert.equal(digested(parent({ deliveries: [D], boundaries: [1500], assistantAts: [1400] })), false);
    assert.equal(digested(parent({ deliveries: [D], boundaries: [1500], assistantAts: [] })), false);
    // 投递之后用户马上又发了话，那一轮没有产出，更之后的轮产出不算消化它
    assert.equal(digested(parent({ deliveries: [D], boundaries: [1500, 1600], assistantAts: [1900] })), false);
    assert.equal(
      digested(parent({ deliveries: [{ messageId: "m-other", timestamp: 1500 }], boundaries: [1500], assistantAts: [1800] })),
      false,
    );
  });

  test("重启后重算：全是盘上的事实（转录里的投递痕迹、轮边界与助手消息），同样的输入同样的结论", () => {
    const facts = parent({ deliveries: [D], boundaries: [1500], assistantAts: [1800] });
    assert.equal(digested(facts), digested({ ...facts, deliveries: [...facts.deliveries] }));
    assert.equal(digested(parent({ deliveries: [D], boundaries: [1500], assistantAts: [1400] })), false);
  });

  test("兜底：账本里找不到这条失败回报时，按失败时刻之后的那一轮判", () => {
    assert.equal(digested(parent({ boundaries: [1200], assistantAts: [1300] }), { failed: null }), true);
    assert.equal(digested(parent({ boundaries: [], assistantAts: [1200] }), { failed: null }), true);
    assert.equal(digested(parent({ assistantAts: [900] }), { failed: null }), false);
    assert.equal(digested(parent({ phase: "turn", boundaries: [1200], assistantAts: [1300] }), { failed: null }), false);
  });

  test("通道正文还没拉回来 / 母会话槽读不到：不判，按没处理算（不在加载间隙闪没）", () => {
    assert.equal(digested(parent({ deliveries: [D], boundaries: [1500], assistantAts: [1800] }), { loaded: false }), false);
    assert.equal(digested(null), false);
  });

  test("投递痕迹在尾窗之前（窗口起点晚于失败时刻）：按失败时刻之后的轮判；窗口里没有更早记录时没痕迹就是没投递", () => {
    assert.equal(digested(parent({ windowStartAt: 1300, boundaries: [1300], assistantAts: [1800] })), true);
    assert.equal(digested(parent({ windowStartAt: null, boundaries: [1300], assistantAts: [1800] })), false);
    assert.equal(digested(parent({ windowStartAt: 500, boundaries: [1300], assistantAts: [1800] })), false);
  });
});

describe("parentFactsFrom —— 母会话槽 → 事实（实时与重读两条路径）", () => {
  const user = (id: string, timestamp: number, text: string): TranscriptItem =>
    ({ id, role: "user", content: [{ type: "text", text }], timestamp }) as TranscriptItem;
  const assistant = (id: string, timestamp: number): TranscriptItem =>
    ({ id, role: "assistant", content: [{ type: "text", text: "好" }], timestamp }) as TranscriptItem;
  const envelope = (messageId: string): string =>
    `<channel from="child" kind="failed" peer="c1" message="${messageId}" title="下载依赖">\n缺少凭证\n</channel>\nnotice`;
  const run = (facts: ParentFacts): boolean =>
    failureDigested({ failed: { id: "m-fail", at: 1000 }, fallbackAt: 1000, messagesLoaded: true, parent: facts });

  test("实时槽：投递就是带信封首行的 user 消息，认得出 message id；之后的助手消息算处理过", () => {
    const facts = parentFactsFrom({
      phase: "idle",
      marks: [],
      hasMore: false,
      items: [user("u1", 100, "派活"), assistant("a1", 200), user("u2", 1500, envelope("m-fail")), assistant("a2", 1800)],
    });
    assert.deepEqual(facts.deliveries, [{ messageId: "m-fail", timestamp: 1500 }]);
    assert.deepEqual(facts.boundaries, [100, 1500]);
    assert.deepEqual(facts.assistantAts, [200, 1800]);
    assert.equal(run(facts), true);
  });

  test("重读后：投递是通道标记（entry.marks）；用户自己说的、正文里提到信封的 user 消息不算投递", () => {
    const facts = parentFactsFrom({
      phase: "idle",
      marks: [{ messageId: "m-fail", timestamp: 1500 }],
      hasMore: true,
      items: [user("u1", 100, "我说 <channel from=\"child\" kind=\"failed\" peer=\"c\" message=\"m-x\" 只是提到"), assistant("a2", 1800)],
    });
    assert.deepEqual(facts.deliveries, [{ messageId: "m-fail", timestamp: 1500 }]);
    assert.deepEqual(facts.boundaries, [100, 1500]);
    assert.equal(facts.windowStartAt, 100);
    assert.equal(run(facts), true);
  });

  test("还在投递中（信封在、之后没有助手消息）：失败项留着；消化完又开新轮：不叫回来", () => {
    const pending = parentFactsFrom({
      phase: "idle",
      marks: [],
      hasMore: false,
      items: [assistant("a1", 200), user("u2", 1500, envelope("m-fail"))],
    });
    assert.equal(run(pending), false);
    const later = parentFactsFrom({
      phase: "turn",
      marks: [],
      hasMore: false,
      items: [user("u2", 1500, envelope("m-fail")), assistant("a2", 1800), user("u3", 3000, "继续"), assistant("a3", 3100)],
    });
    assert.equal(run(later), true);
  });
});
