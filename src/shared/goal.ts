/**
 * 会话级目标（update_goal，2026-10-30）的形状与校验。
 *
 * 用户 14:23 原话：「进度里面还可以有一个内容，就是长期的目标，goal……你做规划的时候要有 hierarchy：
 * 哪些目标是用户说过的、high level 的，哪些是可以 break down 成 todo 的……session 级别主要就是用户不希望
 * 模型偏离的目标」。目标挂在会话上，todo（update_plan）挂在目标下面；工作区级目标不做。
 *
 * **目标由 agent 从用户的话里提炼、替用户写，以用户原话为主，不让用户填表**；用户在聊天里改了说法，
 * agent 重新调一次 update_goal，并在回复正文里说一句「目标我改成了 X」——不弹确认、没有按钮。
 * 目标不另存：就在转录里的 update_goal 调用入参上（同 update_plan），最后一次有效的调用 = 当前目标；
 * 迁 pi-durable 后它变成一份 defineDoc，调用入参不用改。
 *
 * 纯模块：不 import electron / React，可被 node --test 直接加载。
 */
import { PLAN_TOOL_NAME } from "./plan.ts";

export const GOAL_TOOL_NAME = "update_goal";

/** 目标最多多少字符：以用户原话为主，所以给得比计划步骤宽；超长截断（不拒） */
export const GOAL_MAX_CHARS = 400;
/** why 的上限（字符），超长截断 */
export const GOAL_WHY_MAX_CHARS = 200;

/**
 * 这次改动是谁触发的：
 * - user：用户在聊天里说的（默认——目标主要来自用户的话）；
 * - self：agent 自己做事时发现的（why 里写发现了什么）。
 */
export type GoalBy = "user" | "self";

export interface GoalCall {
  goal: string;
  /** 为什么改（第一次定目标可缺） */
  why: string | null;
  /** 触发者；没写 = null，读者按「最近一条用户消息」算 user */
  by: GoalBy | null;
}

/** update_goal 的结果 details（随转录落盘，只给界面） */
export interface GoalToolDetails {
  goal: string;
  /** 这次调用改掉的上一个目标；第一次定目标 / 没变 = 缺席 */
  previous?: string;
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 入参 → 一次 update_goal 调用。goal 缺了 / 空白抛错（错误文案回灌给模型）；
 * why / by 是可选字段，写坏了静默丢掉——同 update_plan，弱模型对可选字段最容易写歪，不值得为它整调用重来。
 */
export function parseGoalCall(params: unknown): GoalCall {
  const record = (params ?? {}) as Record<string, unknown>;
  const goal = clean(record["goal"], GOAL_MAX_CHARS);
  if (goal === null) {
    throw new Error('update_goal requires "goal": the long-lived objective, mostly in the user\'s own words.');
  }
  const by = record["by"];
  return { goal, why: clean(record["why"], GOAL_WHY_MAX_CHARS), by: by === "user" || by === "self" ? by : null };
}

/** 宽松读：已落盘的入参，坏了 = null（面板 / 账本读「已经发生过」的调用，不抛错） */
export function parseGoalCallLoose(params: unknown): GoalCall | null {
  try {
    return parseGoalCall(params);
  } catch {
    return null;
  }
}

/**
 * 「记账」工具：update_plan / update_goal 只是把打算记下来，不是干活的一步——
 * 过程行的步数、章节归属、「用了几步」都不数它们。
 */
export function isBookkeepingTool(toolName: string): boolean {
  return toolName === PLAN_TOOL_NAME || toolName === GOAL_TOOL_NAME;
}
