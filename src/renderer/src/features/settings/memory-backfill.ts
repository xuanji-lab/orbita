/**
 * 设置 › 记忆库 ›「从历史生成」的纯函数层：进度、token 量级、界面该处于哪一态。
 * 不碰 React、不碰 IPC，`node --test` 直接测（memory-backfill.test.ts）。
 */
import type { MemoryBackfillStatus } from "@shared/memory";

/**
 * 界面的四种形态：
 * - hidden：没开卡、也没有值得一提的任务（idle）
 * - setup：卡片展开，选范围、看预估、点开始
 * - progress：任务在跑或暂停中——收成一条进度条，常驻在头部下方（不受卡片开合影响）
 * - result：刚结束（完成 / 取消 / 失败），给一句结果，可关掉
 */
export type BackfillView = "hidden" | "setup" | "progress" | "result";

export function backfillView(status: MemoryBackfillStatus | null, setupOpen: boolean, resultDismissed: boolean): BackfillView {
  const state = status?.state ?? "idle";
  if (state === "running" || state === "paused") return "progress";
  if (setupOpen) return "setup";
  if ((state === "done" || state === "cancelled" || state === "failed") && !resultDismissed) return "result";
  return "hidden";
}

/** 进度 0..1，按轮算（轮 = 调用次数，比会话数更均匀）。总数为 0 时按 0。 */
export function backfillProgress(status: MemoryBackfillStatus): number {
  if (status.totalTurns <= 0) return 0;
  return Math.min(1, Math.max(0, status.doneTurns / status.totalTurns));
}

/**
 * token 只给量级：<1 万按千（「约 8 千」）、<1 亿按万保留一位小数（「约 12.5 万」），
 * 再大按亿。预估本来就是按字符折算的粗数，多给位数是假精确。
 */
export function tokenMagnitude(tokens: number, lang: "zh" | "en"): string {
  const n = Math.max(0, Math.round(tokens));
  if (lang === "en") {
    if (n < 1_000) return `~${n}`;
    if (n < 1_000_000) return `~${trim(n / 1_000)}K`;
    return `~${trim(n / 1_000_000)}M`;
  }
  if (n < 1_000) return `约 ${n}`;
  if (n < 10_000) return `约 ${trim(n / 1_000)} 千`;
  if (n < 100_000_000) return `约 ${trim(n / 10_000)} 万`;
  return `约 ${trim(n / 100_000_000)} 亿`;
}

function trim(value: number): string {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}
