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
 * 退场的时序也是派生的：完成 / 失败的子会话用通道里最后一条消息的时间当「完成时刻」，
 * 在 `BG_LINGER_MS` 内还留在条里，过了就不算——重开应用、切走再切回来，结果一致，没有
 * 只存在组件里的「淡出计时器」。
 *
 * 纯模块：不 import React，可被 node --test 直接加载（值导入走相对路径带 .ts 后缀）。
 */
import type { ChannelMessage, ChannelStatus } from "@shared/channel";
import type { TranscriptRecord } from "@shared/session";
import type { Automation } from "../../../../shared/automation.ts";
import type { BackgroundStripStyle } from "../../../../shared/settings.ts";
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

/** 完成 / 失败的子会话在条里停留多久再退场（毫秒） */
export const BG_LINGER_MS = 8000;
/** 汇总条（A）一行里最多并排几项，多的折成「+N」 */
export const BG_INLINE_MAX = 3;
/** 分行条（B）最多几行，多的折成「还有 N 项」 */
export const BG_ROWS_MAX = 4;

/** 一个后台子会话：状态是 sub-sessions-rows 的七档之一，条里只出现 running / waiting / approval / done / failed */
export interface BgSubItem {
  kind: "sub";
  /** React key 与去重用：`sub:<childId>` */
  key: string;
  childId: string;
  title: string;
  status: SubSessionRowStatus;
  /** 开始时间（子会话建立）：分行条的「已跑多久」从这里算 */
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
  now: number;
}

/**
 * 这一刻后台有什么：子会话（等你最前，其次在跑，其次失败，其次完成——sub-sessions-rows 的同一个排序）
 * 在前，等下次运行的自动化（下次到点早的在前）在后。没有 = 空数组，调用方据此整条不渲染。
 *
 * 子会话入选：running / waiting / approval 恒入选；done / failed 只在完成时刻后 `BG_LINGER_MS` 内；
 * stopped（用户自己停的）与 idle（建了没在跑）不进条——前者是用户的裁决，后者没有后台活动。
 */
export function backgroundItems(input: BackgroundItemsInput): BgItem[] {
  const subs: BgSubItem[] = [];
  for (const child of input.children) {
    const channel = input.channelOf(child.id);
    const status = subSessionStatusFrom(child.id, channel?.status, input.probe);
    const lastAt = channel?.lastAt ?? child.createdAt;
    if (!isBackgroundStatus(status)) continue;
    if ((status === "done" || status === "failed") && input.now - lastAt >= BG_LINGER_MS) continue;
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
 * 条自己的时钟要不要走：有在跑的（步骤与「已跑多久」在变）或停留中的完成项（到点要退场）才走；
 * 只剩等你 / 等自动化时画面是静止的，不开定时器。
 */
export function needsClock(items: readonly BgItem[]): boolean {
  return items.some(
    (item) => item.kind === "sub" && (item.status === "running" || item.status === "done" || item.status === "failed"),
  );
}

/** 时钟走到 now 时还该显示的项：停留期满的完成 / 失败项退场（条自己的 1 秒时钟用它，不等上游重算） */
export function visibleBgItems(items: readonly BgItem[], now: number): BgItem[] {
  return items.filter(
    (item) =>
      item.kind !== "sub" || !(item.status === "done" || item.status === "failed") || now - item.lastAt < BG_LINGER_MS,
  );
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
 * 汇总条一行并排几项：按条自己的宽度（右栏开着、窗口窄时条比窗口窄得多）。条头那句事实
 * 占去约 260（再窄时计数收起，只剩「后台」二字，约 60），每项至少要 190 才读得出「名字 + 一截步骤」，
 * 所以并排数 = 剩下的宽度 ÷ 190，夹在 1 到 3 之间，其余折进「+N」。名字必须读得出：
 * 宁可少放几项，也不把每项都压成一个饼。量宽度的是组件，这里只管换算。
 */
export function bgInlineCap(widthPx: number): number {
  const head = widthPx < 400 ? 60 : 260;
  return Math.min(BG_INLINE_MAX, Math.max(1, Math.floor((widthPx - head) / 190)));
}

/** 按密度折叠：汇总条并排 `inlineCap` 项（默认 3）、分行条 4 行，超出的只给个数 */
export function foldBgItems(
  items: readonly BgItem[],
  style: BackgroundStripStyle,
  inlineCap: number = BG_INLINE_MAX,
): { shown: BgItem[]; hidden: BgItem[] } {
  const cap = style === "rows" ? BG_ROWS_MAX : inlineCap;
  return { shown: items.slice(0, cap), hidden: items.slice(cap) };
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

/** 折叠后「+N」按钮点哪里去：隐藏项里有子会话 → 子会话面板列表；只剩自动化 → 自动化面板 */
export function overflowTarget(hidden: readonly BgItem[]): "subsessions" | "automation" | null {
  if (hidden.length === 0) return null;
  return hidden.some((item) => item.kind === "sub") ? "subsessions" : "automation";
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
