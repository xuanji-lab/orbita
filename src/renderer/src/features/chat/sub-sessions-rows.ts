/**
 * 右栏 Sub-sessions 面板列表层与父子会话通道卡的纯函数：一行 / 一卡的状态怎么算、
 * 全部行怎么排序。组件不测（仓库 renderer 组件无测试框架先例，channel-column.ts 同款
 * 做法）——逻辑抽出来落在这里测，`SubSessionsPanel.tsx` 只负责取数据、拼行、调这里的
 * 函数。
 *
 * 纯模块：不 import React、不 import `@shared/*` 的值（只用类型），可被
 * `node --test` 直接加载。
 */
import type { ChannelMessage, ChannelStatus } from "@shared/channel";
import type { Messages } from "../../messages-en.ts";

/**
 * 一行的显示状态（七档，字面对应设计裁决的颜色/图标分配）：
 *   running  = 子在跑（accent）
 *   waiting  = 通道状态 waiting，子问了、父还没回（warning，"waiting for you"）
 *   approval = 子会话在 renderer 会话槽里有未答的工具审批（warning，"needs approval"）——
 *     manual 档下每个工具都要批，用户往往不在看这条子会话，必须顶到审批之上单独一档
 *   stopped  = 通道状态 stopped，**用户**终止了这个子会话（tertiary，"stopped"）——
 *     用户的裁决压过审批 / 在跑这些瞬时态：停都停了，不该再引导用户去批一个死轮
 *   done     = 通道 closed 于 done（success）
 *   failed   = 通道 closed 于 failed（danger）
 *   idle     = 都不是（tertiary）——子会话建了但通道还没有除 task 外的往来，也没在跑
 */
export type SubSessionRowStatus =
  | "running"
  | "waiting"
  | "approval"
  | "done"
  | "failed"
  | "stopped"
  | "idle";

/**
 * 一行状态怎么定：**waiting 优先于 stopped，优先于 approval，优先于 running**——
 * waiting 与 stopped 同源（通道状态，互斥），摆在一起只是让检查顺序可读；stopped
 * 压过 approval / running 是用户裁决的语义：终止了就别再拿「待批 / 在跑」引导用户。
 * approval 又比单纯 running 紧迫——running 只是「知会」，approval 是「卡住了，等你」。
 * done/failed 只在不满足前者时才看（正常情况下 done/failed 的通道不会同时在跑或有
 * 待批审批，但状态机不为「不会发生」的组合留特判缺口，见 channelStatus 同款纪律）。
 */
export function subSessionRowStatus(input: {
  channelStatus: ChannelStatus | undefined;
  needsApproval: boolean;
  running: boolean;
}): SubSessionRowStatus {
  if (input.channelStatus === "waiting") return "waiting";
  if (input.channelStatus === "stopped") return "stopped";
  if (input.needsApproval) return "approval";
  if (input.running) return "running";
  if (input.channelStatus === "done") return "done";
  if (input.channelStatus === "failed") return "failed";
  return "idle";
}

/** 多行正文取第一个非空行并压掉首尾空白——收件箱行里只放得下一句话。 */
function firstLineOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return line.trim();
}

/**
 * `subSessionStatusOf` 从引擎读的两个槽的**最小结构面**——结构化而不是直接引用
 * `SessionEngine` 整型：本模块保持纯模块纪律（不 import useChatSession），
 * 测试拿字面量假对象就能喂，真实引擎天然满足这个形状。
 */
export interface SubSessionEngineSlots {
  /** 分槽状态里的审批槽：有未答审批 = approval 档 */
  states: ReadonlyMap<string, { approvals: readonly unknown[] }>;
  /** 会话 phase：非 idle = 这条会话此刻真的在跑 */
  phaseOf: (id: string) => string;
}

/**
 * 一行 / 一张通道卡的显示状态怎么取：通道摘要的 status + 引擎的审批槽与 phase，
 * 拼成 `subSessionRowStatus` 的输入。Sub-sessions 面板的行与父子会话面板的通道卡
 * **共用这一份 glue**，两处画出来的状态永远同源。
 *
 * 2026-10 bug 的直接教训：通道卡曾只看 channelStatus，而它的 "running" 语义是
 * 「通道开着」（子会话还没报 done/failed/question），跟子会话在不在跑无关——子会话
 * 这一轮跑完但没调 report_to_parent 时，面板已按 phase 画 idle，通道卡还在画
 * accent 呼吸的「运行中」。phase 必须参与推导，且只能从这一处参与。
 */
export function subSessionStatusOf(
  childId: string,
  channelStatus: ChannelStatus | undefined,
  engine: SubSessionEngineSlots,
): SubSessionRowStatus {
  return subSessionRowStatus({
    channelStatus,
    needsApproval: (engine.states.get(childId)?.approvals.length ?? 0) > 0,
    running: engine.phaseOf(childId) !== "idle",
  });
}

// ───────────────────────── 列表层重做（2026-11-22）：分组、第二行、卡住、走表 ─────────────────────────
//
// 用户原话（2026-11-22 22:43）：「Composer 上面做了一个状态栏，会显示子会话正在进行的 bash 啥的。我就是在想
// 这个子会话这个面板能不能做好看一点，现在好丑。」——列表层要回答两件事：哪几个要我看、在跑的此刻在干什么跑了多久。
// 「此刻在跑什么 / 卡住 / 走表」三段照搬原型分支 proto/chat-workbench 的 chat-status.ts（状态卡的子会话行），
// 第二行「计划在做的步优先、没有就退到最近的动作」照 #488 后台状态位（background-strip.ts 的 stepText），不另写一套。

/** 子会话此刻正在跑的那次工具调用（照搬 proto/chat-workbench chat-status.ts 的 ChildActivity） */
export interface ChildActivity {
  toolName: string;
  input: unknown;
  /** 这次调用开始的时刻 */
  since: number;
}

/** 转录尾巴的最小结构面（TranscriptRecord 的子集：测试拿字面量就能喂） */
export type TailRecord =
  | { role: "tool"; status: string; toolCallId: string; toolName: string; input: unknown; timestamp: number }
  | {
      role: "assistant";
      timestamp: number;
      content: readonly ({ type: string } & { toolCallId?: string; toolName?: string; input?: unknown })[];
    }
  | { role: string; timestamp: number };

/**
 * 子会话转录的尾巴 → 正在跑的那次工具调用（状态 running 的工具记录；或 assistant 发出了调用、结果还没来）。
 * 没有在跑的调用 = null（在想、在写回答、已停）。照搬 chat-status.ts 的 childActivityOf。
 */
export function childActivityOf(records: readonly TailRecord[]): ChildActivity | null {
  const resolved = new Set<string>();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    if (record.role === "tool" && "toolCallId" in record) {
      if (record.status === "running") return { toolName: record.toolName, input: record.input, since: record.timestamp };
      resolved.add(record.toolCallId);
      continue;
    }
    if (record.role === "assistant" && "content" in record) {
      for (const block of record.content) {
        if (block.type === "toolCall" && block.toolCallId !== undefined && !resolved.has(block.toolCallId)) {
          return { toolName: block.toolName ?? "", input: block.input, since: record.timestamp };
        }
      }
      // 最后一条 assistant 的调用都有结果：此刻不在跑工具
      return null;
    }
    if (record.role === "user") return null;
  }
  return null;
}

/** 同一个工具调用跑了这么久就算「卡住了」（转录空档 P97 是 28 秒；一条命令十分钟没动静，人该看一眼）——同状态卡 */
export const STUCK_MS = 10 * 60_000;

/** 面板行的状态：子会话七档之上多一档 stuck（在跑，但同一个调用跑太久了） */
export type PanelRowState = SubSessionRowStatus | "stuck";

/**
 * 一行此刻的状态。running 的来源有二：引擎说它在跑；或通道还开着、转录尾巴有一次在跑的调用（重开应用后
 * 引擎槽是空的，只有转录尾巴知道它在跑什么——同状态卡 childStateOf）。在跑且同一个调用超过 STUCK_MS = stuck。
 */
export function panelRowState(input: {
  channelStatus: ChannelStatus | undefined;
  needsApproval: boolean;
  enginePhaseRunning: boolean;
  activity: ChildActivity | null;
  now: number;
}): PanelRowState {
  const open = input.channelStatus === undefined || input.channelStatus === "running";
  const status = subSessionRowStatus({
    channelStatus: input.channelStatus,
    needsApproval: input.needsApproval,
    running: input.enginePhaseRunning || (open && input.activity !== null),
  });
  if (status === "running" && input.activity !== null && input.now - input.activity.since > STUCK_MS) return "stuck";
  return status;
}

/**
 * 四组，按「要不要你」排：等你（在问你 / 待批 / 失败——要你看的）→ 在跑（含卡住）→ 已交回 → 已停止（你停的，
 * 以及这一轮停了却没交回的 idle）。后两组默认收成一行（「15 个已交回 ›」）：做完的不需要你，自己退场。
 */
export type PanelGroup = "attention" | "running" | "handed" | "stopped";

export const PANEL_GROUPS: readonly PanelGroup[] = ["attention", "running", "handed", "stopped"];

/** 默认收起的组 */
export const FOLDED_GROUPS: ReadonlySet<PanelGroup> = new Set(["handed", "stopped"]);

export function panelGroupOf(state: PanelRowState): PanelGroup {
  switch (state) {
    case "waiting":
    case "approval":
    case "failed":
      return "attention";
    case "running":
    case "stuck":
      return "running";
    case "done":
      return "handed";
    default:
      return "stopped";
  }
}

/** 组内次序：等你组里 在问你 / 待批 › 失败；在跑组里 卡住的在前、其余跑得久的在前；交回 / 停止组新的在前 */
const IN_GROUP_ORDER: Record<PanelRowState, number> = {
  waiting: 0,
  approval: 0,
  failed: 1,
  stuck: 0,
  running: 1,
  done: 0,
  stopped: 0,
  idle: 1,
};

/**
 * 行 → 有序的组（空组不出现）。在跑组按「这次调用开始的时刻」正序（跑得最久的在前，离「卡住」最近），
 * 其余组按 lastAt 倒序（新的在前）。
 */
export function groupPanelRows<T extends { state: PanelRowState; lastAt: number; since: number | null }>(
  rows: readonly T[],
): { group: PanelGroup; rows: T[] }[] {
  const byGroup = new Map<PanelGroup, T[]>();
  for (const row of rows) {
    const group = panelGroupOf(row.state);
    byGroup.set(group, [...(byGroup.get(group) ?? []), row]);
  }
  return PANEL_GROUPS.flatMap((group) => {
    const list = byGroup.get(group);
    if (list === undefined) return [];
    const sorted = [...list].sort((a, b) => {
      const order = IN_GROUP_ORDER[a.state] - IN_GROUP_ORDER[b.state];
      if (order !== 0) return order;
      if (group === "running") return (a.since ?? a.lastAt) - (b.since ?? b.lastAt);
      return b.lastAt - a.lastAt;
    });
    return [{ group, rows: sorted }];
  });
}

/** 第二行：text 是那句话；tool = 正在跑的调用（等宽显示，带走表）；tone 只给渲染挑色 */
export interface PanelSecondLine {
  text: string;
  /** 句首的状态词（「卡住了」）：常规字，不随命令进等宽；没有 = null */
  lead: string | null;
  /** 正在跑的那次调用开始的时刻（行尾走表从它算）；不是在跑工具 = null */
  since: number | null;
  /** 机器内容（命令 / 路径）用等宽 */
  mono: boolean;
  tone: "default" | "warning" | "danger" | "quiet";
}

/**
 * 每个状态的第二行说有用的话（2026-11-22 任务单）：
 *   在跑：正在执行的工具调用（「bash · bun run test」，行尾走表）；没在跑工具时，计划里在做的那一步；都没有 =「在想」
 *   卡住：同上，前面多「卡住了」（文字是首选信号，黄色三角与黄字是第二信号）
 *   在问你：问题第一行；待批：要批的那次调用
 *   失败：原因第一行；已交回：报告第一行（不是「完成」两个字）
 *   已停止（用户终止）：「你停止了它」；idle：「这一轮停了，没有交回」
 * 通道正文拉不到时退到状态词，不显示「读取失败」。
 */
export function panelSecondLine(
  input: {
    state: PanelRowState;
    activity: ChildActivity | null;
    /** 子会话计划里 in_progress 那一步（没有计划 / 没有在做的步 = null） */
    planStep: string | null;
    messages: readonly ChannelMessage[] | undefined;
    /** 挂着的第一个工具审批 */
    approval: { toolName: string; input: unknown } | null;
  },
  /** 一次调用的一行字（「bash · bun run test」）：动词表在组件里，这里只拼 */
  callLine: (toolName: string, toolInput: unknown) => string,
  t: Messages,
): PanelSecondLine {
  const quiet = (text: string): PanelSecondLine => ({ text, lead: null, since: null, mono: false, tone: "quiet" });
  const lastOf = (kind: ChannelMessage["kind"]): string | null => {
    const found = [...(input.messages ?? [])].reverse().find((message) => message.kind === kind);
    return found === undefined ? null : firstLineOf(found.text) || null;
  };
  switch (input.state) {
    case "running":
    case "stuck": {
      const tone = input.state === "stuck" ? "warning" : "default";
      if (input.activity !== null) {
        const call = callLine(input.activity.toolName, input.activity.input);
        return {
          text: call,
          lead: input.state === "stuck" ? t.subSessions.stuck : null,
          since: input.activity.since,
          mono: true,
          tone,
        };
      }
      return { text: input.planStep ?? t.subSessions.thinking, lead: input.state === "stuck" ? t.subSessions.stuck : null, since: null, mono: false, tone };
    }
    case "waiting":
      return { text: lastOf("question") ?? t.subSessions.rowStatus.waiting, lead: null, since: null, mono: false, tone: "default" };
    case "approval":
      return {
        text:
          input.approval === null
            ? t.subSessions.rowStatus.approval
            : t.subSessions.approvalLine(callLine(input.approval.toolName, input.approval.input)),
        lead: null,
        since: null,
        mono: false,
        tone: "default",
      };
    case "failed":
      return { text: lastOf("failed") ?? t.subSessions.rowStatus.failed, lead: null, since: null, mono: false, tone: "danger" };
    case "done":
      return quiet(lastOf("done") ?? t.subSessions.rowStatus.done);
    case "stopped":
      return quiet(t.subSessions.stoppedByYou);
    default:
      return quiet(t.subSessions.idleLine);
  }
}

/**
 * 下一次要重画的时间（毫秒后）：只有在跑项才走（since 列表为空 = null，不走表）；不到一分钟的每秒跳，
 * 否则按分钟跳——对齐到最早一个「下一分钟」的边界，四十个计时也只醒一次。照搬 chat-status.ts 的 nextTickIn。
 */
export function nextTickIn(sinces: readonly number[], now: number): number | null {
  if (sinces.length === 0) return null;
  let wait = 60_000;
  for (const since of sinces) {
    const elapsed = Math.max(0, now - since);
    if (elapsed < 60_000) return 1000 - (elapsed % 1000);
    wait = Math.min(wait, 60_000 - (elapsed % 60_000));
  }
  return Math.max(250, wait);
}

/**
 * 跑了多久的字：不到一分钟写秒，不到一小时写分，再长写时 + 分（分钟级，不写秒——秒在跳只会吸走眼睛；
 * 走表超过一分钟也只按分钟跳，写秒就是写一个不会动的假数字）。
 */
export function elapsedText(ms: number, t: Messages): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return t.subSessions.elapsedHM(h, m);
  if (m > 0) return t.subSessions.elapsedM(m);
  return t.subSessions.elapsedS(total % 60);
}
