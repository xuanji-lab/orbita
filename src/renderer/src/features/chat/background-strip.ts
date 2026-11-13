/**
 * 对话输入框上方「后台任务条」的纯推导（2026-11-13）。
 *
 * 要回答的三个问题：后台有几件事在跑、各自做到哪、有没有在等我。**全部从现有状态派生，
 * 不另存只活在 renderer 的真源**：
 *   - 子会话 = 这条会话的直接子会话 + 通道摘要（`channel:list`）+ 引擎的 phase / 审批槽；
 *     状态判定、排序、饼档位**复用** `sub-sessions-rows.ts`，不另写一套；
 *   - 自动化 = 目标是本会话（this_session）、还在排期、等下次运行的那几条。
 * 现在只有这两种项，不为别的后台来源预留类型（没有真实调用点的东西不进仓）。
 *
 * 退场的时序也是派生的，没有只存在组件里的「淡出计时器」，重开应用、切走再切回来结果一致：
 *   - 完成的子会话用通道里最后一条消息的时间当「完成时刻」，在 `BG_LINGER_MS` 内还留着，过了就不算；
 *   - **失败的不按秒数退场**，留到「母会话在这次失败之后完成了一轮」为止（`failureDigested`）。
 *     这不是「用户看过没有」——子会话没有未读（完成提醒只认根会话，见 completion-notice.ts），也不
 *     新造只活在内存里的已看；它只保证「母会话还没处理之前，这条失败不会凭空消失」。
 *
 * 纯模块：不 import React，可被 node --test 直接加载（值导入走相对路径带 .ts 后缀）。
 */
import type { ChannelMessage, ChannelStatus } from "@shared/channel";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import type { TranscriptRecord } from "@shared/session";
import { parseChannelPrompt } from "../../../../shared/channel.ts";
import type { Automation } from "../../../../shared/automation.ts";
import type { Messages } from "../../messages-en.ts";
import { formatWhen } from "../automation/automation-view.ts";
import { isBookkeepingTool } from "../../../../shared/goal.ts";
import { planTimeline } from "../context/plan-timeline.ts";
import { homeCardLine, type HomeCardLineText } from "./home-cards.ts";
import { flattenRenderUnits, toolCallSummary } from "./tool-results.ts";
import {
  latestChannelLine,
  sortSubSessionRows,
  subSessionStatusFrom,
  type SubSessionRowStatus,
} from "./sub-sessions-rows.ts";

/** 完成的子会话在条里停留多久再退场（毫秒）；失败的不按时间退场，见 failureDigested */
export const BG_LINGER_MS = 8000;
/** 细条一行里最多并排几项，多的折成「+N」 */
export const BG_INLINE_MAX = 3;

/** 一个后台子会话：状态是 sub-sessions-rows 的七档之一，条里只出现 running / waiting / approval / done / failed */
export interface BgSubItem {
  kind: "sub";
  /** React key 与去重用：`sub:<childId>` */
  key: string;
  childId: string;
  title: string;
  status: SubSessionRowStatus;
  /** 开始时间（子会话建立）：浮层清单行尾的「已跑多久」从这里算 */
  startedAt: number;
  /** 通道里最后一条消息的时间（没有往来 = 建立时间）：排序与退场都用它 */
  lastAt: number;
}

/** 一条等下次运行的自动化（目标是本会话） */
export interface BgAutomationItem {
  kind: "automation";
  key: string;
  automationId: string;
  title: string;
  nextRunAt: number;
  /** 已经到点、在等本会话这一轮结束才送达（Automation.pendingDelivery） */
  due: boolean;
}

export type BgItem = BgSubItem | BgAutomationItem;

/** 派生要的最小子会话信息（SessionMeta 的子集，测试拿字面量就能喂） */
export interface BgChildMeta {
  id: string;
  title: string;
  createdAt: number;
}

/** 通道摘要里条要用的两个字段（ChannelSummary 的子集） */
export interface BgChannelFact {
  status: ChannelStatus;
  lastAt: number;
}

export interface BackgroundItemsInput {
  parentId: string;
  children: readonly BgChildMeta[];
  channelOf: (childId: string) => BgChannelFact | undefined;
  /** 引擎的按 id 查询（ChatSession 上引用稳定的 approvalsOf / phaseOf） */
  probe: { approvalCountOf: (id: string) => number; phaseOf: (id: string) => string };
  automations: readonly Automation[];
  /** 这条失败的子会话，母会话是否已经处理过（failureDigested）；由调用方从母会话的槽里取 */
  failureDigested: (childId: string) => boolean;
  now: number;
}

/** 母会话在槽里的事实（failureDigested 的原料；全是盘上已有的东西，重启后读回来一样） */
export interface ParentFacts {
  /** 母会话此刻的 phase：非 idle = 有一轮还在跑 */
  phase: string;
  /**
   * 通道消息**已经被喂进母会话的一轮**的痕迹（投递状态）：盘上是通道标记 `ChannelMarkRecord`
   * （重读转录后在 `entry.marks`），实时槽里则是那条带信封首行的 user 消息（`parseChannelPrompt`
   * 认得出 message id；落盘时被换成标记）。两处读到的是同一件事，合并成这一份。
   */
  deliveries: readonly { messageId: string; timestamp: number }[];
  /** 轮边界的时刻（时间正序）：每条 user 消息与每个通道标记都开一轮 */
  boundaries: readonly number[];
  /** 母会话槽里全部助手消息的时间 */
  assistantAts: readonly number[];
  /** 槽只装尾窗：更早还有记录（window.hasMore）时，窗口里最早一条记录的时间；没有更早的 = null */
  windowStartAt: number | null;
}

/**
 * 母会话槽里的原料 → ParentFacts。投递痕迹两处读：重读过的转录里是通道标记（`marks`）；实时槽里
 * 是带信封首行的 user 消息（`parseChannelPrompt` 认得出 message id，落盘时才被换成标记）。
 */
export function parentFactsFrom(input: {
  phase: string;
  marks: readonly { messageId: string; timestamp: number }[];
  /** 槽只装尾窗：更早还有记录 */
  hasMore: boolean;
  /** 槽里生效的转录（selectTranscript 的结果，时间正序） */
  items: readonly TranscriptItem[];
}): ParentFacts {
  const assistantAts: number[] = [];
  const boundaries: number[] = input.marks.map((mark) => mark.timestamp);
  const deliveries = input.marks.map((mark) => ({ messageId: mark.messageId, timestamp: mark.timestamp }));
  for (const item of input.items) {
    if (item.role === "assistant") assistantAts.push(item.timestamp);
    if (item.role !== "user") continue;
    boundaries.push(item.timestamp);
    const text = item.content.find((block) => block.type === "text");
    const parsed = text?.type === "text" ? parseChannelPrompt(text.text) : null;
    if (parsed !== null) deliveries.push({ messageId: parsed.messageId, timestamp: item.timestamp });
  }
  boundaries.sort((x, y) => x - y);
  return {
    phase: input.phase,
    deliveries,
    boundaries,
    assistantAts,
    windowStartAt: input.hasMore ? (input.items[0]?.timestamp ?? null) : null,
  };
}

/**
 * 一条失败回报，母会话「在这次失败之后完成了一轮」没有？是才算处理过，失败项才退场。
 *
 * 优先用最精确的现成信号——**投递状态**：子→父的失败回报投进母会话那一刻，母会话转录里就有这条消息
 * 的痕迹（`ParentFacts.deliveries`，轮边界，与 user 同级）。从投递那一刻起，母会话消化它的那一轮 =
 * 到下一个轮边界为止（没有下一个边界就是到现在）。所以：
 *   1. 母会话转录里没有这条消息的投递痕迹 = 还没投递（母在忙、消息在队里等）→ 没处理；
 *   2. 已投递，这一轮里母会话产出了助手消息，且这一轮已经结束（母会话 idle，或之后已经开了新的一轮）→ 处理过，退场；
 *   3. 已投递、这一轮还在跑 → 没处理（失败项还在，并排显示没问题）；
 *      之后母会话再开别的新轮不会把已退场的失败项叫回来——退场看的是「消化它的那一轮」，不是此刻的 phase；
 *   4. 已投递、这一轮没有产出助手消息（用户打断）→ 没处理，继续留着。
 * 拿不到投递状态时退到「失败时刻之后的那一轮」，规则同 2–4：
 *   - 账本里找不到这条失败回报（旧数据）时用失败时刻（通道最后一条消息）；
 *   - 通道正文还没拉回来（messagesLoaded = false）时**不判**，按没处理算——宁可多留一拍，
 *     也不让失败项在加载间隙闪没；
 *   - 投递痕迹不在尾窗里但窗口起点晚于失败时刻（痕迹在窗口之前）：当作失败时刻已投递。
 * **不用**「通道 lastAt 变了」：母会话不一定回信给子会话。
 */
export function failureDigested(input: {
  /** 这条子通道里最后一条 failed 回报的 id / 时刻；账本里没有 = null */
  failed: { id: string; at: number } | null;
  /** 没有失败回报时的兜底时刻（通道最后一条消息的时间） */
  fallbackAt: number;
  messagesLoaded: boolean;
  parent: ParentFacts | null;
}): boolean {
  if (!input.messagesLoaded || input.parent === null) return false;
  const parent = input.parent;
  let from: number;
  if (input.failed === null) {
    from = input.fallbackAt;
  } else {
    const delivery = parent.deliveries.find((candidate) => candidate.messageId === input.failed?.id);
    if (delivery !== undefined) {
      from = delivery.timestamp;
    } else if (parent.windowStartAt !== null && parent.windowStartAt > input.failed.at) {
      from = input.failed.at;
    } else {
      return false;
    }
  }
  // 消化它的那一轮从哪开始：投递就是一个轮边界（等于 from）；兜底时是失败时刻之后的第一个轮边界
  const start = parent.boundaries.find((at) => at >= from) ?? from;
  const next = parent.boundaries.find((at) => at > start);
  const hasOutput = parent.assistantAts.some((at) => at >= start && (next === undefined || at < next));
  if (!hasOutput) return false;
  return next !== undefined || parent.phase === "idle";
}

/**
 * 这一刻后台有什么：子会话（等你最前，其次在跑，其次失败，其次完成——sub-sessions-rows 的同一个排序）
 * 在前，等下次运行的自动化（下次到点早的在前）在后。没有 = 空数组，调用方据此整条不渲染。
 *
 * 子会话入选：running / waiting / approval 恒入选；done 只在完成时刻后 `BG_LINGER_MS` 内；
 * failed 留到母会话处理过为止（`input.failureDigested`）；stopped（用户自己停的）与 idle（建了没在跑）不进条——前者是用户的裁决，后者没有后台活动。
 */
export function backgroundItems(input: BackgroundItemsInput): BgItem[] {
  const subs: BgSubItem[] = [];
  for (const child of input.children) {
    const channel = input.channelOf(child.id);
    const status = subSessionStatusFrom(child.id, channel?.status, input.probe);
    const lastAt = channel?.lastAt ?? child.createdAt;
    if (!isBackgroundStatus(status)) continue;
    if (status === "done" && input.now - lastAt >= BG_LINGER_MS) continue;
    if (status === "failed" && input.failureDigested(child.id)) continue;
    subs.push({
      kind: "sub",
      key: `sub:${child.id}`,
      childId: child.id,
      title: child.title,
      status,
      startedAt: child.createdAt,
      lastAt,
    });
  }
  const automations = input.automations
    .filter(
      (automation) =>
        automation.target.kind === "this_session" &&
        automation.target.sessionId === input.parentId &&
        automation.status === "active" &&
        automation.nextRunAt !== null,
    )
    .map(
      (automation): BgAutomationItem => ({
        kind: "automation",
        key: `automation:${automation.id}`,
        automationId: automation.id,
        title: automation.title,
        nextRunAt: automation.nextRunAt ?? 0,
        due: automation.pendingDelivery !== undefined,
      }),
    )
    .sort((a, b) => a.nextRunAt - b.nextRunAt);
  return [...sortSubSessionRows(subs), ...automations];
}

function isBackgroundStatus(status: SubSessionRowStatus): boolean {
  return status !== "stopped" && status !== "idle";
}

/**
 * 状态位自己的时钟要不要走：有在跑的（「已跑多久」在变）或停留中的完成项（到点要退场）才走；
 * 只剩等你 / 失败 / 等自动化时画面是静止的，不开定时器。
 */
export function needsClock(items: readonly BgItem[]): boolean {
  return items.some((item) => item.kind === "sub" && (item.status === "running" || item.status === "done"));
}

/** 时钟走到 now 时还该显示的项：停留期满的完成项退场（自己的 1 秒时钟用它，不等上游重算）；失败项不按时间退场 */
export function visibleBgItems(items: readonly BgItem[], now: number): BgItem[] {
  return items.filter((item) => item.kind !== "sub" || item.status !== "done" || now - item.lastAt < BG_LINGER_MS);
}

/** 两份项列表逐字段相同（上游每次渲染都新算一份，用它挡掉没变化的更新，条不随无关渲染重画） */
export function sameBgItems(a: readonly BgItem[], b: readonly BgItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    if (right === undefined || left.kind !== right.kind || left.key !== right.key || left.title !== right.title) return false;
    if (left.kind === "sub" && right.kind === "sub") {
      return left.status === right.status && left.startedAt === right.startedAt && left.lastAt === right.lastAt;
    }
    if (left.kind === "automation" && right.kind === "automation") {
      return left.nextRunAt === right.nextRunAt && left.due === right.due;
    }
    return false;
  });
}

/**
 * 细条一行并排几项：按它自己的宽度（右栏开着、窗口窄时比窗口窄得多）。计数那句事实（最长五段）占去约 260
 * （窄到 300 以下计数收起，只剩「后台」二字，约 40），每项至少要 190 才读得出「名字 + 一截步骤」，
 * 所以并排数 = 剩下的宽度 ÷ 190，夹在 1 到 3 之间，其余折进「+N」。名字必须读得出：
 * 宁可少放几项，也不把每项都压成一个饼。量宽度的是组件，这里只管换算。
 */
export function bgInlineCap(widthPx: number): number {
  const head = widthPx < 300 ? 40 : 260;
  return Math.min(BG_INLINE_MAX, Math.max(1, Math.floor((widthPx - head) / 190)));
}

/** 折叠：细条并排 `inlineCap` 项，超出的只给个数 */
export function foldBgItems(
  items: readonly BgItem[],
  inlineCap: number = BG_INLINE_MAX,
): { shown: BgItem[]; hidden: BgItem[] } {
  return { shown: items.slice(0, inlineCap), hidden: items.slice(inlineCap) };
}

/** 条头事实里的一段（「2 项在跑」）：tone 只给渲染挑色，「等你」那段染 warning */
export interface BgSummaryPart {
  tone: "running" | "waiting" | "failed" | "done" | "scheduled";
  text: string;
}

/**
 * 条头那句事实：「2 项在跑 · 1 项等你」。只写数字与状态，不写「正在努力」；顺序固定
 * 在跑 › 等你 › 失败 › 完成 › 待运行，哪一档为 0 就不出现。等你 = 通道在问 + 子会话有待批审批。
 */
export function bgSummaryParts(items: readonly BgItem[], t: Messages): BgSummaryPart[] {
  let running = 0;
  let waiting = 0;
  let failed = 0;
  let done = 0;
  let scheduled = 0;
  for (const item of items) {
    if (item.kind === "automation") {
      scheduled++;
    } else if (item.status === "running") {
      running++;
    } else if (item.status === "waiting" || item.status === "approval") {
      waiting++;
    } else if (item.status === "failed") {
      failed++;
    } else if (item.status === "done") {
      done++;
    }
  }
  const parts: BgSummaryPart[] = [];
  if (running > 0) parts.push({ tone: "running", text: t.bgStrip.running(running) });
  if (waiting > 0) parts.push({ tone: "waiting", text: t.bgStrip.waiting(waiting) });
  if (failed > 0) parts.push({ tone: "failed", text: t.bgStrip.failed(failed) });
  if (done > 0) parts.push({ tone: "done", text: t.bgStrip.done(done) });
  if (scheduled > 0) parts.push({ tone: "scheduled", text: t.bgStrip.scheduled(scheduled) });
  return parts;
}

/** 条头那句事实的纯文本（title / 读屏用） */
export function bgSummary(items: readonly BgItem[], t: Messages): string {
  return bgSummaryParts(items, t)
    .map((part) => part.text)
    .join(" · ");
}

/** 子会话那一项「此刻」要的原料（纯数据，由条从槽与通道账本里取） */
export interface BgStepInput {
  status: SubSessionRowStatus;
  /** 该子会话槽里的记录；槽没载过 = null */
  records: readonly TranscriptRecord[] | null;
  /** 通道全文（时间正序）；拉不到 = undefined */
  messages: readonly ChannelMessage[] | undefined;
  /** 挂着的第一个工具审批 */
  approval: { toolName: string; input: unknown } | null;
}

/**
 * 一项当前在做的那一步（一行字）：
 *   - 在跑：**计划里 in_progress 那一步的文字**；没有计划（或没有在做的步）就取最近的动作——
 *     这一轮里最后一次干活的工具调用（动词 + 对象，如「bash sleep 45」），还没动过工具是「在想」。
 *     不取章节标题：章节来自模型的思考原话，常是英文自言自语，放进一条常驻的状态条里是噪音；
 *     槽没载过（重开应用后还没打开过它）退到通道里它最近说的一句，不留空也不写占位词；
 *   - 等审批：要批的是什么（动词 + 对象，同首页记录行）；
 *   - 在问你：它问的那句；完成 / 失败：通道里的结语（latestChannelLine 的同一套话）。
 */
export function stepText(input: BgStepInput, t: Messages, lineText: HomeCardLineText): string {
  if (input.status === "approval") {
    const line = homeCardLine(
      { state: "waiting", records: null, approval: input.approval, turnError: null, lastAsk: null },
      lineText,
    );
    return line ?? t.subSessions.rowStatus.approval;
  }
  if (input.status === "running" && input.records !== null) {
    const planStep = planTimeline(input.records)?.current.items.find((item) => item.status === "in_progress")?.text ?? null;
    if (planStep !== null) return planStep;
    return latestActionLine(input.records, lineText);
  }
  return latestChannelLine(input.messages, input.status, t);
}

/**
 * 这一轮（最后一条用户消息起）里最后一次干活的工具调用：动词 + 对象。记账工具（update_plan /
 * update_goal）不算动作；这一轮还没动过工具 = 「在想」。
 */
function latestActionLine(records: readonly TranscriptRecord[], lineText: HomeCardLineText): string {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.role === "user") {
      start = i;
      break;
    }
  }
  const call = flattenRenderUnits(records.slice(start))
    .filter((unit) => unit.kind === "toolCall" && !isBookkeepingTool(unit.toolName))
    .at(-1);
  if (call === undefined || call.kind !== "toolCall") return lineText.thinking;
  const summary = toolCallSummary(call.toolName, call.input);
  const verb = lineText.verb(call.toolName, call.input);
  return summary === null ? verb : `${verb} ${summary}`;
}

/** 自动化项那一句：「下次运行 今天 18:00」；已到点在等这一轮结束时说清楚 */
export function automationLine(item: BgAutomationItem, now: number, t: Messages): string {
  if (item.due) return t.bgStrip.automationDue;
  return t.automation.next(formatWhen(item.nextRunAt, now, t.automation));
}
