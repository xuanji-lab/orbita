/**
 * 过程行的「这一轮发生了什么」（2026-11-17 对话流降噪）：把一轮的过程步摊成按时间排的事件，
 * 再按种类数出一句摘要。
 *
 * 用户 2026-11-16：「发了一条消息，就可以有一个块呈现读了哪些记忆、修改了什么计划、回复了子 agent 什么，
 * 想办法统一好。但是你统一好，又要清楚地让我知道你在干嘛。」——所以过程行不能只剩「12 步 · 58 秒」，
 * 后面跟一句按种类拼的摘要（「交回 1 件 · 改了计划 · 回了 1 句 · 1 条命令没成」）。摘要用规则拼，
 * 不多花一次模型调用；命令失败不上红色（没让这一轮失败的失败，不需要红色）。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { ChannelMessageKind } from "@shared/channel";
import { isBookkeepingTool } from "../../../../shared/goal.ts";
import type { Messages } from "../../messages-en.ts";
import type { ProcessStep, ToolCallUnit, ToolResultIndex, TurnViewEntry } from "./tool-results.ts";
import { rollupToolKey, stepTime } from "./tool-results.ts";
import { firstLine } from "./turn-process.ts";

/** 展开后的一行：动词 · 内容 · 时间。和子会话的来往、改计划也只是一行 */
export type ProcessEvent =
  | {
      kind: "tools";
      key: string;
      /** 统计词汇（rollupToolKey）：相邻同类的调用并成一行 */
      toolKey: string;
      calls: ToolCallUnit[];
      /** 点开这一行时原样画的步（含紧挨着的思考），沿用现有的工具行展开 */
      steps: ProcessStep[];
      failed: number;
      time: number;
    }
  | { kind: "say"; key: string; text: string; time: number }
  | { kind: "childIn"; key: string; peerId: string; messageId: string; msgKind: ChannelMessageKind; time: number }
  | { kind: "reply"; key: string; peerId: string | null; text: string | null; time: number }
  | { kind: "delegate"; key: string; peerId: string | null; title: string | null; time: number }
  | { kind: "plan"; key: string; toolCallId: string; time: number }
  | { kind: "goal"; key: string; toolCallId: string; time: number }
  /** 读了 / 记住的记忆：挂在用户消息上，由视图层按这一轮补进来 */
  | { kind: "memory"; key: string; used: readonly MemoryLine[]; remembered: readonly MemoryLine[]; time: number }
  /** 认不出的种类（以后新加的单元）：默认进过程，展开时原样画 */
  | { kind: "other"; key: string; step: ProcessStep; time: number };

/** 一条记忆在过程明细里的样子：一行字，点开看全文 */
export interface MemoryLine {
  id: string;
  text: string;
}

export interface EventSources {
  results: ToolResultIndex;
  skills?: ReadonlyArray<{ slug: string; name: string }>;
  /** 这次 update_plan 调用有没有真的改了计划（只打勾不算） */
  planChanged: (toolCallId: string) => boolean;
  /** 这次 update_goal 调用有没有改掉一个已有的目标（第一次定目标不算） */
  goalChanged: (toolCallId: string) => boolean;
  /** 子会话派活回执里的 childId（delegate 的结果卡）；拿不到给 null */
  delegatedChild: (toolCallId: string) => string | null;
}

const PLAN_TOOL = "update_plan";
const GOAL_TOOL = "update_goal";

function inputRecord(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** 一轮的过程步 → 按时间排的事件。相邻同类工具并成一行；思考挂到紧接着的那行工具上，不单独成行 */
export function processEvents(steps: readonly ProcessStep[], src: EventSources): ProcessEvent[] {
  const events: ProcessEvent[] = [];
  let pendingThinking: ProcessStep[] = [];
  const lastTools = (): Extract<ProcessEvent, { kind: "tools" }> | null => {
    const last = events.at(-1);
    return last?.kind === "tools" ? last : null;
  };
  const pushCall = (call: ToolCallUnit, step: ProcessStep) => {
    const name = call.toolName;
    if (name === PLAN_TOOL || name === GOAL_TOOL || isBookkeepingTool(name)) {
      if (name === PLAN_TOOL && src.planChanged(call.toolCallId)) events.push({ kind: "plan", key: call.key, toolCallId: call.toolCallId, time: call.timestamp });
      if (name === GOAL_TOOL && src.goalChanged(call.toolCallId)) events.push({ kind: "goal", key: call.key, toolCallId: call.toolCallId, time: call.timestamp });
      return;
    }
    const input = inputRecord(call.input);
    if (name === "delegate") {
      events.push({ kind: "delegate", key: call.key, peerId: src.delegatedChild(call.toolCallId), title: str(input["title"]), time: call.timestamp });
      return;
    }
    if (name === "reply_subsession") {
      events.push({ kind: "reply", key: call.key, peerId: str(input["childId"]), text: str(input["text"]), time: call.timestamp });
      return;
    }
    const toolKey = rollupToolKey(name, call.input, src.skills ?? []);
    const failed = src.results.get(call.toolCallId)?.status === "error" ? 1 : 0;
    const prev = lastTools();
    if (prev !== null && prev.toolKey === toolKey && pendingThinking.length === 0) {
      prev.calls.push(call);
      if (!prev.steps.includes(step)) prev.steps.push(step);
      prev.failed += failed;
      return;
    }
    events.push({ kind: "tools", key: call.key, toolKey, calls: [call], steps: [...pendingThinking, step], failed, time: call.timestamp });
    pendingThinking = [];
  };
  for (const step of steps) {
    switch (step.kind) {
      case "thinking":
        pendingThinking.push(step);
        break;
      case "toolCall":
        pushCall(step, step);
        break;
      case "toolGroup":
        for (const call of step.calls) pushCall(call, step);
        break;
      case "text": {
        const line = firstLine(step.text);
        if (line !== null) events.push({ kind: "say", key: step.key, text: line, time: step.timestamp });
        break;
      }
      case "channelMark":
        // 子会话的进度消息不进父会话（它是子会话自己的事）；交回 / 提问 / 没做成各一行
        if (step.mark.from === "child" && step.mark.kind !== "progress") {
          events.push({
            kind: "childIn",
            key: step.key,
            peerId: step.mark.peerId,
            messageId: step.mark.messageId,
            msgKind: step.mark.kind,
            time: step.timestamp,
          });
        }
        break;
      default:
        events.push({ kind: "other", key: step.key, step, time: stepTime(step) });
    }
  }
  // 最后几段思考后面没有工具了：挂到上一行工具上，没有就不出行（思考不单独占一行）
  const tail = lastTools();
  if (pendingThinking.length > 0 && tail !== null) tail.steps.push(...pendingThinking);
  return events;
}

/** 按种类数出来的摘要的原料（只数发生了的） */
export interface ProcessTally {
  memoryRead: number;
  remembered: number;
  returned: number;
  asked: number;
  childFailed: number;
  goal: number;
  plan: number;
  replied: number;
  delegated: number;
  /** 没成的工具调用；全是命令时说「命令」 */
  failed: number;
  failedAllCommands: boolean;
}

const COMMAND_KEYS: ReadonlySet<string> = new Set(["bash", "powershell", "shell"]);

export function processTally(events: readonly ProcessEvent[]): ProcessTally {
  const tally: ProcessTally = {
    memoryRead: 0,
    remembered: 0,
    returned: 0,
    asked: 0,
    childFailed: 0,
    goal: 0,
    plan: 0,
    replied: 0,
    delegated: 0,
    failed: 0,
    failedAllCommands: true,
  };
  for (const event of events) {
    switch (event.kind) {
      case "memory":
        tally.memoryRead += event.used.length;
        tally.remembered += event.remembered.length;
        break;
      case "childIn":
        if (event.msgKind === "done") tally.returned += 1;
        else if (event.msgKind === "question") tally.asked += 1;
        else if (event.msgKind === "failed") tally.childFailed += 1;
        break;
      case "goal":
        tally.goal += 1;
        break;
      case "plan":
        tally.plan += 1;
        break;
      case "reply":
        tally.replied += 1;
        break;
      case "delegate":
        tally.delegated += 1;
        break;
      case "tools":
        if (event.failed > 0) {
          tally.failed += event.failed;
          if (!COMMAND_KEYS.has(event.toolKey)) tally.failedAllCommands = false;
        }
        break;
      default:
        break;
    }
  }
  return tally;
}

/**
 * 摘要：只列发生了的种类，按「先看到的、再做的、最后没成的」排。空数组 = 这一轮只是干活（读、跑、改），
 * 由视图层退回按工具数。
 */
export function processSummary(t: Messages, tally: ProcessTally): string[] {
  const s = t.chat.procSum;
  const parts: string[] = [];
  if (tally.memoryRead > 0) parts.push(s.memoryRead(tally.memoryRead));
  if (tally.remembered > 0) parts.push(s.remembered(tally.remembered));
  if (tally.returned > 0) parts.push(s.returned(tally.returned));
  if (tally.asked > 0) parts.push(s.asked(tally.asked));
  if (tally.childFailed > 0) parts.push(s.childFailed(tally.childFailed));
  if (tally.goal > 0) parts.push(s.goal);
  if (tally.plan > 0) parts.push(s.plan(tally.plan));
  if (tally.replied > 0) parts.push(s.replied(tally.replied));
  if (tally.delegated > 0) parts.push(s.delegated(tally.delegated));
  if (tally.failed > 0) parts.push(tally.failedAllCommands ? s.commandsFailed(tally.failed) : s.stepsFailed(tally.failed));
  return parts;
}

/** 摘要里除了失败之外有没有事件种类（没有就退回按工具数） */
export function tallyHasEvents(tally: ProcessTally): boolean {
  return (
    tally.memoryRead + tally.remembered + tally.returned + tally.asked + tally.childFailed + tally.goal + tally.plan + tally.replied + tally.delegated >
    0
  );
}

/**
 * 记忆挂在哪一行（2026-11-17：「用到 N 条记忆」从用户消息的动作行挪进这一轮的过程行）：
 * 过程行 → 这一轮的用户消息 id，只给这一轮的**第一个**过程行（一轮可能被正文切成几块）；
 * 往前找到别的过程行就说明不是第一个；找到视图开头还没碰到用户消息，就是尾段里接着历史段最后那条用户消息的一轮
 * （leadUserId）。
 */
export function processTurnUser(view: readonly TurnViewEntry[], index: number, leadUserId: string | null): string | null {
  for (let i = index - 1; i >= 0; i -= 1) {
    const entry = view[i];
    if (entry === undefined) continue;
    if (entry.kind === "turnProcess") return null;
    if (entry.kind === "user") return entry.item.id;
    if (entry.kind === "compacted" || entry.kind === "revertMark") return null;
  }
  return leadUserId;
}

/**
 * 这条用户消息的这一轮有没有过程行：没有（只想了想就答、或答之前就断了）时，记忆单独画一行同样长相的过程行挂在消息下面，
 * 不然就没处放了。`continuesInTail`：这是历史段最后一条用户消息、尾段里已经有过程行。
 */
export function userTurnHasProcess(view: readonly TurnViewEntry[], index: number, continuesInTail: boolean): boolean {
  for (let i = index + 1; i < view.length; i += 1) {
    const entry = view[i];
    if (entry === undefined) continue;
    if (entry.kind === "turnProcess") return true;
    if (entry.kind === "user" || entry.kind === "compacted" || entry.kind === "revertMark") return false;
  }
  return continuesInTail;
}
