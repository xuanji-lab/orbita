import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import type { ChannelMessage } from "@shared/channel";
import type { Automation } from "../../../../shared/automation.ts";
import type { Messages } from "../../messages-en.ts";
import {
  BG_INLINE_MAX,
  BG_LINGER_MS,
  BG_ROWS_MAX,
  automationLine,
  backgroundItems,
  bgSummary,
  foldBgItems,
  needsClock,
  overflowTarget,
  sameBgItems,
  stepText,
  visibleBgItems,
  type BackgroundItemsInput,
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
}

function input(f: Fixture): BackgroundItemsInput {
  const ids = f.children ?? Object.keys({ ...f.channel, ...f.phase });
  return {
    parentId: PARENT,
    children: ids.map((id, index) => ({ id, title: `子会话 ${id}`, createdAt: T0 + index })),
    channelOf: (id) => f.channel?.[id],
    probe: { approvalCountOf: (id) => f.approvals?.[id] ?? 0, phaseOf: (id) => f.phase?.[id] ?? "idle" },
    automations: f.automations ?? [],
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
    const channel = { fin: { status: "done" as const, lastAt: T0 }, boom: { status: "failed" as const, lastAt: T0 } };
    assert.deepEqual(ids(backgroundItems(input({ channel, now: T0 + BG_LINGER_MS - 1 }))), ["boom", "fin"]);
    assert.deepEqual(ids(backgroundItems(input({ channel, now: T0 + BG_LINGER_MS }))), []);
    // 条自己的 1 秒时钟用 visibleBgItems 做同一判断，不等上游重算
    const early = backgroundItems(input({ channel, now: T0 }));
    assert.equal(visibleBgItems(early, T0 + BG_LINGER_MS - 1).length, 2);
    assert.equal(visibleBgItems(early, T0 + BG_LINGER_MS).length, 0);
    assert.equal(needsClock(early), true);
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

  test("超过上限折叠：汇总条并排 3 项、分行条 4 行，其余只给个数；刚好等于上限不折", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => sub(id, "running"));
    const inline = foldBgItems(six, "summary");
    assert.equal(inline.shown.length, BG_INLINE_MAX);
    assert.equal(inline.hidden.length, 3);
    const rows = foldBgItems(six, "rows");
    assert.equal(rows.shown.length, BG_ROWS_MAX);
    assert.equal(rows.hidden.length, 2);
    assert.equal(foldBgItems(six.slice(0, 3), "summary").hidden.length, 0);
    assert.equal(foldBgItems(six.slice(0, 4), "rows").hidden.length, 0);
  });

  test("「+N」去哪：隐藏项里有子会话 → 子会话面板；只剩自动化 → 自动化面板；没有隐藏项 = 不去", () => {
    const auto: BgAutomationItem = { kind: "automation", key: "automation:x", automationId: "x", title: "x", nextRunAt: T0, due: false };
    assert.equal(overflowTarget([]), null);
    assert.equal(overflowTarget([auto]), "automation");
    assert.equal(overflowTarget([auto, sub("a", "running")]), "subsessions");
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

  test("在跑但没有计划：退到最近的动作（章节 > 正在跑的工具 > 在想），不是空白也不是占位符", () => {
    const withTool = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "sleep 30" } }]),
    ];
    assert.equal(stepText({ ...base, status: "running", records: withTool }, t, lineText), "bash sleep 30");
    assert.equal(stepText({ ...base, status: "running", records: [user("u1", 1000)] }, t, lineText), "在想");
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
