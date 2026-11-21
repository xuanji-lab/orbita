/**
 * 跨天回来的那份恢复回答（2026-11-21）：用户隔一天回到工作区，只对主智能体说一句「接着上次」，
 * 不翻旧会话就能接上——为什么做、上次到哪、哪些已经定了、现在等什么、下一步（用户 2026-11-19 定的核心验收场景）。
 *
 * 这里只把**已经落盘的结构化状态**排成那五项：主智能体的目标与计划（update_goal / update_plan 的账）、
 * 各件活的通道往来与自含摘要（job-brief.ts）、用户在通道里替主智能体回的话（= 已定的决定）。
 * 取不到的项是空，由回答写「没有记录」，不编。
 *
 * 现状：只有同源预览（preview/fixture-api.ts）在用户说「接着上次」时拿它拼出确定性的回答，并在回答里标明不是模型记忆。
 * 真实运行时仍待接——应把同一份状态交给主智能体（模型）自己回答，而不是由界面替它说话。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { ChannelMessage } from "@shared/channel";
import { channelStatus } from "../../../../shared/channel.ts";
import type { PlanItem } from "@shared/plan";
import type { TranscriptRecord } from "@shared/session";
import { buildGoalLedger } from "../../../../shared/goal-ledger.ts";
import { subSessionRowStatus } from "../chat/sub-sessions-rows.ts";
import { ledgerEventsOf } from "./goal-ledger-records.ts";
import { cleanSentence, jobBrief, type JobBriefWords } from "./job-brief.ts";
import { planTimeline } from "./plan-timeline.ts";

export interface ResumeJob {
  title: string;
  messages: readonly ChannelMessage[];
  /** 这件活自己写的计划；没写 = null */
  plan: readonly PlanItem[] | null;
}

export interface ResumeBrief {
  /** 上次离开的时刻（主对话最后一条记录）；空会话 = null */
  leftAt: number | null;
  why: string | null;
  reached: string[];
  decisions: string[];
  waiting: { title: string; text: string }[];
  next: string | null;
}

const said = cleanSentence;

/** 已定的决定最多列几条（最近的在前） */
const DECISIONS_MAX = 3;

export function resumeBrief(input: { records: readonly TranscriptRecord[]; jobs: readonly ResumeJob[] }, words: JobBriefWords): ResumeBrief {
  const ledger = buildGoalLedger(ledgerEventsOf(input.records));
  const plan = planTimeline(input.records)?.current.items ?? null;
  const last = input.records.at(-1);
  // 上次到哪：计划里做完的最后两步；没写计划就用主智能体最后一次回答的第一句
  let reached = ledger.todos.done.slice(-2);
  if (reached.length === 0) {
    const answer = [...input.records].reverse().find((record) => record.role === "assistant");
    const text = answer?.role === "assistant" ? answer.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n") : "";
    const first = said(text);
    reached = first === null ? [] : [first];
  }
  const decisions = input.jobs
    .flatMap((job) => job.messages.filter((message) => message.kind === "reply" && message.author === "user"))
    .sort((a, b) => b.createdAt - a.createdAt)
    .flatMap((message) => {
      const text = said(message.text);
      return text === null ? [] : [text];
    })
    .slice(0, DECISIONS_MAX);
  const waiting = [
    ...input.jobs.flatMap((job) => {
      const status = subSessionRowStatus({ channelStatus: job.messages.length === 0 ? undefined : channelStatus(job.messages), running: false });
      if (status !== "waiting" && status !== "failed") return [];
      const brief = jobBrief({ status, messages: job.messages, plan: job.plan }, words);
      return brief.waiting === null ? [] : [{ title: job.title, text: brief.waiting }];
    }),
    ...ledger.todos.waiting.map((item) => ({ title: item.text, text: item.waitingFor ?? "" })),
  ];
  const step = plan?.find((item) => item.status === "in_progress") ?? plan?.find((item) => item.status === "pending") ?? null;
  return {
    leftAt: last === undefined ? null : last.timestamp,
    why: ledger.goal?.text ?? null,
    reached,
    decisions,
    waiting,
    next: step?.text ?? null,
  };
}

export interface ResumeWords {
  intro: (when: string) => string;
  why: string;
  reached: string;
  decisions: string;
  waiting: string;
  next: string;
  none: string;
  /** 标签后的冒号（中文「：」，英文「: 」） */
  colon: string;
}

/** 五项排成一段简短的 markdown 回答：每项一行；多条的（已定、在等你）各自缩进成子项，不挤成一行 */
export function resumeAnswer(brief: ResumeBrief, when: string, words: ResumeWords): string {
  const head = (label: string): string => `- **${label}**${words.colon}`;
  const one = (label: string, value: string | null): string => `${head(label)}${value === null || value === "" ? words.none : value}`;
  const many = (label: string, items: readonly string[]): string =>
    items.length === 0 ? `${head(label)}${words.none}` : items.length === 1 ? `${head(label)}${items[0]}` : [head(label).trimEnd(), ...items.map((item) => `  - ${item}`)].join("\n");
  return [
    words.intro(when),
    "",
    one(words.why, brief.why),
    many(words.reached, brief.reached),
    many(words.decisions, brief.decisions),
    many(words.waiting, brief.waiting.map((item) => (item.text === "" ? item.title : `${item.title} — ${item.text}`))),
    one(words.next, brief.next),
  ].join("\n");
}
