/**
 * 重试行（Retrying）的文案与倒数数学 —— 纯函数，node --test 直接加载，不碰 React / IPC。
 * 倒数锚在 agent 进程盖的 startedAt（shared 的 RetryStatus）上：
 * 组件只负责每秒喂一个新 now，切走再切回、事件重放都不会把倒数重算回起点。
 */
import type { RetryStatus } from "@shared/agent-ipc";

/** 距下一次重试还有几秒（向上取整）。已到期 → null：等待结束、下一次尝试还没接上。 */
export function retryRemainingSeconds(status: RetryStatus, nowMs: number): number | null {
  const remaining = status.startedAt + status.delayMs - nowMs;
  if (remaining <= 0) return null;
  return Math.ceil(remaining / 1000);
}

/**
 * 重试行的主文案：「第 2/3 次重试 · 3 秒后」。到期后秒数换成「正在重试…」——
 * 倒数到 0 与下一次尝试开跑（agent_start 翻回 Responding）之间可能有零点几秒的缝，
 * 卡在「0 秒后」比如实说「正在重试」更让人慌。
 */
export function retryLineText(status: RetryStatus, nowMs: number): string {
  const seconds = retryRemainingSeconds(status, nowMs);
  const wait = seconds === null ? "正在重试…" : `${seconds} 秒后`;
  return `第 ${status.attempt}/${status.maxAttempts} 次重试 · ${wait}`;
}

/**
 * 失败原因的行内版：超长截断（hover 全文由组件拿原串给）。空白 → null，不渲染。
 * provider 的错误串经常是一整段 JSON，行内只留能辨因由的前缀。
 */
export function retryCauseText(errorMessage: string): string | null {
  const trimmed = errorMessage.trim();
  if (trimmed === "") return null;
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}
