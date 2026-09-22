/**
 * 筛选行的「完整 / 紧凑」判定：容器比四个带字 chip 的自然宽度窄，就只画图标
 * （wafo 2026-09-22：「太窄的时候文字自动消失，只剩图标，往左 stack」）。
 *
 * **自然宽度只在完整态量**，量到就记住（`fullWidth`）：紧凑态下内容缩了，
 * 再拿当时的 scrollWidth 比，会得出「放得下」→ 切回完整 → 又放不下 → 来回抖。
 * 记住完整态的宽度，之后只拿容器宽和它比，一个阈值两边稳定。
 *
 * 纯函数：输入当前态与两个宽度，返回下一态与该记住的自然宽度。
 */
export function nextFilterRowMode(state: {
  compact: boolean;
  /** 完整态最近一次量到的内容自然宽度；null = 还没量过 */
  fullWidth: number | null;
  /** 容器可用宽度 */
  containerWidth: number;
  /** 当前内容的 scrollWidth（只在完整态可信） */
  contentWidth: number;
}): { compact: boolean; fullWidth: number | null } {
  const fullWidth = state.compact ? state.fullWidth : Math.max(state.fullWidth ?? 0, state.contentWidth);
  if (fullWidth === null || fullWidth === 0) return { compact: false, fullWidth };
  return { compact: state.containerWidth < fullWidth, fullWidth };
}
