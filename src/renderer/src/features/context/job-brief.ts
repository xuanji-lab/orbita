/**
 * 一件活的自含摘要（2026-11-21）：用户隔天回来、已经不记得这件活的上下文时，不点进去也能读懂它——
 * 上次做到哪 / 现在在等什么 / 下一步。单纯一列勾与状态只有记得上下文的人才读得懂（用户 2026-11-19）。
 *
 * 只从已经发生过的结构化事实里取，不编：
 * - 通道里这件活自己说的话（进度 / 完成 / 没做成 / 提问，取第一句、洗掉命令路径代号）；
 * - 它自己写的计划（update_plan：做完的步、在做 / 下一步、在等的步与等什么）；
 * - 行状态（在问你、被打断、没做成、做完、暂停、在跑）。
 * 某一项取不到就是 null，由界面写「信息不足」，不拿状态名硬凑一句话。不读整段转录。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { ChannelMessage } from "@shared/channel";
import type { PlanItem } from "@shared/plan";
import { latestSentence, sanitizeWorkLine } from "../../../../shared/work-line.ts";
import type { SubSessionRowStatus } from "../chat/sub-sessions-rows.ts";

export interface JobBrief {
  /** 派它去做什么：主智能体派活时那句任务的第一句 */
  why: string | null;
  /** 上次做到哪 */
  reached: string | null;
  /** 现在在等什么；在跑、不等任何人时 = null */
  waiting: string | null;
  /** 等的是你（在问你、被打断、没做成、做完等你看） */
  waitingOnYou: boolean;
  /** 下一步 */
  next: string | null;
}

export interface JobBriefWords {
  reachedStep: (step: string) => string;
  waitingAnswer: (question: string) => string;
  waitingAnswerBare: string;
  waitingFailed: (reason: string) => string;
  waitingFailedBare: string;
  waitingReview: string;
  waitingInterrupted: string;
  waitingPaused: string;
  /** 计划里有一步在等（等外部、等别的活），不是等你 */
  waitingStep: (step: string, waitingFor: string) => string;
  nextAfterAnswer: (step: string) => string;
  nextAnswer: string;
  nextReview: string;
  nextFailed: string;
  nextInterrupted: string;
}

/** 第一个非空行的第一句，洗掉命令、路径、代号；洗空 = null */
function said(text: string): string | null {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const clean = sanitizeWorkLine(latestSentence(line));
  return clean === "" ? null : clean;
}

function lastFrom(messages: readonly ChannelMessage[], from: ChannelMessage["from"], kinds: readonly ChannelMessage["kind"][]): ChannelMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.from === from && kinds.includes(message.kind)) return message;
  }
  return null;
}

/** 计划里接下来那步：在做的，没有就第一条没开始的 */
function upcoming(plan: readonly PlanItem[] | null): PlanItem | null {
  if (plan === null) return null;
  return plan.find((item) => item.status === "in_progress") ?? plan.find((item) => item.status === "pending") ?? null;
}

export function jobBrief(
  input: { status: SubSessionRowStatus; messages: readonly ChannelMessage[] | undefined; plan: readonly PlanItem[] | null },
  words: JobBriefWords,
): JobBrief {
  const messages = input.messages ?? [];
  const task = lastFrom(messages, "parent", ["task"]);
  const report = lastFrom(messages, "child", ["progress", "done", "failed"]);
  const lastDone = input.plan === null ? null : ([...input.plan].reverse().find((item) => item.status === "done") ?? null);
  const reached = (report === null ? null : said(report.text)) ?? (lastDone === null ? null : words.reachedStep(lastDone.text));
  const step = upcoming(input.plan);
  const planWait = input.plan?.find((item) => item.status === "waiting") ?? null;

  let waiting: string | null = null;
  let waitingOnYou = false;
  let next: string | null = step === null ? null : step.text;
  switch (input.status) {
    case "waiting": {
      const question = lastFrom(messages, "child", ["question"]);
      const text = question === null ? null : said(question.text);
      waiting = text === null ? words.waitingAnswerBare : words.waitingAnswer(text);
      waitingOnYou = true;
      next = step === null ? words.nextAnswer : words.nextAfterAnswer(step.text);
      break;
    }
    case "interrupted":
      waiting = words.waitingInterrupted;
      waitingOnYou = true;
      next = words.nextInterrupted;
      break;
    case "failed": {
      const failed = lastFrom(messages, "child", ["failed"]);
      const reason = failed === null ? null : said(failed.text);
      waiting = reason === null ? words.waitingFailedBare : words.waitingFailed(reason);
      waitingOnYou = true;
      next = words.nextFailed;
      break;
    }
    case "done":
      waiting = words.waitingReview;
      waitingOnYou = true;
      next = words.nextReview;
      break;
    case "paused":
      waiting = words.waitingPaused;
      break;
    default:
      if (planWait !== null) waiting = words.waitingStep(planWait.text, planWait.waitingFor ?? "");
  }
  return { why: task === null ? null : said(task.text), reached, waiting, waitingOnYou, next };
}
