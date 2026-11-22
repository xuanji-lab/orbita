/**
 * 筛选行的「逐个收成图标」判定（wafo 2026-09-22：「太窄的时候文字自动消失，只剩图标，往左 stack」）。
 *
 * 行里现在有三个 chip（全部 / 星标 / 时间范围；2026-11-22 删掉「已完成」与「有待办」两个，随会话
 * 「完成」与遗留事项一起）。放不下时**逐个收**：从最右边的字 chip 起往左一个个只留图标，放得下就停，
 * 时间范围的字（选了某档才有的「3 天」）最后才收。
 *
 * **自然宽度只在 chip 不是图标态时量，量到就记住**：图标态的 chip 缩了，再拿当时的宽度比，会得出
 * 「放得下」→ 展开 → 又放不下 → 来回抖。记住每个 chip 完整态的宽度，之后只拿容器宽和它们比，
 * 同一个宽度恒得同一个档，两边稳定。
 *
 * 纯函数：输入各 chip 的完整宽度、图标态宽度、间距与容器宽，返回「收几个」。
 */

/** 收成图标的先后：从最右边的字 chip 起往左，时间范围（下标 2）最后——它平时本来就不带字 */
export const COMPACT_ORDER = [1, 0, 2] as const;

/** 档位 level（0 = 全部完整，COMPACT_ORDER.length = 全部图标）下，第 index 个 chip 是不是图标态 */
export function chipCompactAt(level: number, index: number): boolean {
  return COMPACT_ORDER.slice(0, level).some((i) => i === index);
}

/**
 * 放得下的最小档位。`fullWidths[i]` 是第 i 个 chip 完整态的宽度（还没量到的传 null，按图标态宽度
 * 估——只发生在第一次量之前，那时档位是 0，完整态本来就在 DOM 里，所以实际不会走到）。
 * 全图标仍放不下就返回最高档（行本身 overflow hidden，兜底）。
 */
export function nextCompactLevel(input: {
  fullWidths: readonly (number | null)[];
  compactWidth: number;
  gap: number;
  containerWidth: number;
}): number {
  const { fullWidths, compactWidth, gap, containerWidth } = input;
  for (let level = 0; level <= COMPACT_ORDER.length; level += 1) {
    const content = fullWidths.reduce<number>(
      (sum, width, index) => sum + (chipCompactAt(level, index) ? compactWidth : (width ?? compactWidth)),
      0,
    );
    if (content + gap * Math.max(0, fullWidths.length - 1) <= containerWidth) return level;
  }
  return COMPACT_ORDER.length;
}
