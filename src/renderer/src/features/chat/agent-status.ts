import type { ScopeSummary } from "./galaxy-data.ts";

/**
 * 侧栏智能体行第二行要说的那一句（类型，文案由调用方按语言填）：等你压过在跑，在跑压过「最近在聊什么」，
 * 都没有时说最近一条会话的标题；一个会话也没有就是空态。真实数据都来自 scopeSummary（根会话的运行态汇总）。
 */
export type AgentLine =
  | { kind: "waiting"; count: number }
  | { kind: "working"; count: number }
  | { kind: "last"; title: string }
  | { kind: "empty" };

export function agentLineOf(summary: Pick<ScopeSummary, "waiting" | "running" | "lastTitle" | "total">): AgentLine {
  if (summary.waiting > 0) return { kind: "waiting", count: summary.waiting };
  if (summary.running > 0) return { kind: "working", count: summary.running };
  if (summary.lastTitle !== null) return { kind: "last", title: summary.lastTitle };
  return { kind: "empty" };
}

/** 页头状态胶囊：等你 > 在外面干活 > 就绪；等你时带上直达的会话 id */
export type HeaderStatus =
  | { kind: "waiting"; count: number; sessionId: string | null }
  | { kind: "working"; count: number }
  | { kind: "ready" };

export function headerStatusOf(summary: Pick<ScopeSummary, "waiting" | "running" | "waitingId">): HeaderStatus {
  if (summary.waiting > 0) return { kind: "waiting", count: summary.waiting, sessionId: summary.waitingId };
  if (summary.running > 0) return { kind: "working", count: summary.running };
  return { kind: "ready" };
}
