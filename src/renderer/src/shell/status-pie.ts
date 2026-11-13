import type { SessionRunState } from "../features/notify/completion-notice.ts";

/** 亮着的几档（null = 不亮，不渲染） */
export type PieFill = Exclude<SessionRunState, null>;

/** 每档占几分之几：与旧三节竖条同一套份数（1/3 · 2/3 · 满 · 满） */
export const PIE_FRACTION: Readonly<Record<PieFill, number>> = {
  running: 1 / 3,
  waiting: 2 / 3,
  done: 1,
  failed: 1,
};

/**
 * 饼的扇形路径（viewBox 0 0 10 10，圆心 5,5，半径 r，从 12 点顺时针）。满圆不走这里。
 * 抽出来是为了能测：大弧标志是这里唯一会写错的地方。
 */
export function wedgePath(fraction: number, r = 4.25): string {
  const a = fraction * 2 * Math.PI;
  const x = 5 + r * Math.sin(a);
  const y = 5 - r * Math.cos(a);
  return `M5 5V${(5 - r).toFixed(2)}A${r} ${r} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}z`;
}

