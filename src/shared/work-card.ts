/**
 * 每件派出去的活一张小卡（tech-plan 3.4 的形状，这次只落主智能体读小卡要用的那几样）。
 * 主进程按会话转录 + 通道账本 + 最后一次动静的时刻现算，不落盘（数据都在盘上，重算一致）。
 * 第一个消费者：主智能体的 work_cards 工具（回答「做到哪了」时读小卡，不翻各条子会话的原文）。
 * 那一句与子会话面板第二行同一个函数（work-line.ts），说法同源。
 *
 * 纯模块：不 import electron / node，node --test 直接测。
 */
import { CAPABILITIES_WORDS_ZH, capabilitiesLine } from "./capabilities.ts";
import type { ChannelMessage, ChannelStatus } from "./channel.ts";
import { parsePlan, PLAN_TOOL_NAME, type PlanItem } from "./plan.ts";
import type { TranscriptItem } from "./transcript.ts";
import { currentPlanStep, isQuiet, workFacts, workLine, type WorkLineWords } from "./work-line.ts";

export interface WorkCard {
  sessionId: string;
  title: string;
  status: ChannelStatus;
  /** 此刻真有一轮在跑（通道状态 running 只说明没收尾；它可能停着没在干活） */
  working: boolean;
  /** 那一句（洗过：没有命令、网址、路径、英文代号）；洗不出来 = null */
  line: string | null;
  /** 计划：打了几个勾 / 共几步；没计划 = null */
  plan: { done: number; total: number } | null;
  /** 在等谁 / 在问什么（计划里 waiting 步的 waitingFor，或子会话最近一次提问的正文） */
  waitingFor: string | null;
  /** 在跑但一段时间没动静（新动作与命令新输出都没有） */
  quiet: boolean;
  /** 应用重启后被自动接着跑过的时刻（小卡第三行「断过一次」）；没有 = null */
  resumedAt: number | null;
  /** 暂停时父写的理由；没暂停 = null */
  pausedFor: string | null;
  /** 派活时定的能力集（shared/capabilities.ts）；全带 = undefined */
  capabilities?: string[];
}

/** 给模型读的说法（英文；模型回用户时按用户的语言说） */
export const MODEL_WORK_WORDS: WorkLineWords = {
  // 用中文：这些词主智能体会原样转述给用户（真型号下它把小卡里的英文直接说给了用户）
  activity: {
    command: "在跑命令",
    read: "在读文件",
    edit: "在改文件",
    web: "在上网查",
    delegate: "在派活",
    think: "在想",
    work: "在做",
  },
  waiting: (step, who) => `${step}（在等${who}）`,
};

/** 转录里最近一次 update_plan 的清单（回退 / 分支的细节不管：小卡要的是「现在大概在哪一步」） */
export function latestPlan(items: readonly TranscriptItem[]): PlanItem[] | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item?.role !== "tool" || item.toolName !== PLAN_TOOL_NAME || item.status === "error") continue;
    try {
      return parsePlan(item.input);
    } catch {
      continue;
    }
  }
  return null;
}

export function workCardOf(input: {
  meta: { id: string; title: string; durable?: { resumed?: number }; capabilities?: string[] };
  status: ChannelStatus;
  messages: readonly ChannelMessage[];
  items: readonly TranscriptItem[];
  running: boolean;
  lastActivityAt: number | null;
  now: number;
}): WorkCard {
  const plan = latestPlan(input.items);
  const step = currentPlanStep(plan);
  const facts = workFacts(input.items, input.running);
  const line = workLine({ said: facts.said, planStep: step, clerk: null, activity: facts.activity }, MODEL_WORK_WORDS);
  const lastQuestion = [...input.messages].reverse().find((message) => message.kind === "question");
  const lastPause = [...input.messages].reverse().find((message) => message.kind === "pause");
  return {
    sessionId: input.meta.id,
    title: input.meta.title,
    status: input.status,
    working: input.running,
    line: line?.text ?? null,
    plan: plan === null ? null : { done: plan.filter((item) => item.status === "done").length, total: plan.length },
    waitingFor:
      input.status === "waiting"
        ? (lastQuestion?.text ?? null)
        : step?.status === "waiting"
          ? (step.waitingFor ?? null)
          : null,
    quiet: isQuiet(input.now, input.running, input.lastActivityAt),
    resumedAt: input.meta.durable?.resumed ?? null,
    pausedFor: input.status === "paused" ? (lastPause?.text ?? null) : null,
    ...(input.meta.capabilities === undefined ? {} : { capabilities: [...input.meta.capabilities] }),
  };
}

/**
 * 状态给模型看的说法：大白话，不给状态码（2026-11-17 真型号试下来，模型拿到 running 就原样转述给用户
 * 「状态是 running」；给它一句话，它转述出来也是一句话）。
 */
const STATUS_WORDS: Readonly<Record<ChannelStatus, string>> = {
  running: "在做",
  waiting: "在等它问的那个问题的回答",
  done: "做完了",
  failed: "没做成",
  stopped: "用户叫停了",
  paused: "暂停着（你暂停的）",
};


/** 一组小卡压成给模型读的几行（每件一行；没有派出去的活就说没有） */
export function workCardsText(cards: readonly WorkCard[], now: number): string {
  if (cards.length === 0) return "这个对话里还没有派出去的活。";
  const minutes = (at: number): number => Math.max(0, Math.round((now - at) / 60_000));
  return cards
    .map((card) => {
      const status = card.status === "running" && !card.working ? "没做完，但这会儿没在动" : STATUS_WORDS[card.status];
      // id 留给 reply_subsession / pause_subsession 用；其余字段都是会被转述给用户的说法，一律中文
      const parts = [`- 「${card.title}」(id ${card.sessionId})：${status}`];
      if (card.plan !== null) parts.push(`计划做了 ${card.plan.done}/${card.plan.total} 步`);
      if (card.line !== null) parts.push(`眼下：${card.line}`);
      if (card.waitingFor !== null) parts.push(`在等：${card.waitingFor}`);
      if (card.pausedFor !== null) parts.push(`暂停的原因：${card.pausedFor}`);
      if (card.quiet) parts.push("有一阵没动静了");
      if (card.resumedAt !== null) parts.push(`${minutes(card.resumedAt)} 分钟前应用重启后接着做了`);
      if (card.capabilities !== undefined) parts.push(capabilitiesLine(card.capabilities, CAPABILITIES_WORDS_ZH) ?? "");
      return parts.filter((part) => part !== "").join("；");
    })
    .join("\n");
}
