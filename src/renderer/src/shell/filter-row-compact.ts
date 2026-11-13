/**
 * 筛选行的「逐个收成图标」判定（wafo 2026-09-22：「太窄的时候文字自动消失，只剩图标，往左 stack」）。
 *
 * 2026-11-07 起行里有五个 chip（全部 / 已完成 / 星标 / 有待办 / 时间范围）。原先是「四个带字 chip
 * 放不下就**一起**收成图标」，但四个字 chip 在默认宽度（内容宽 264px）下本来就刚好放满（252 + 间距 12），
 * 再多一个时间范围就会让默认宽度整行变成全图标、把已有的文字全吃掉。所以改成**逐个收**：
 * 从最右边的字 chip 起往左一个个只留图标，放得下就停（设计稿 c 图：全部、已完成带字，星标 / 灯泡 /
 * 时钟只剩图标），时间范围的字（选了某档才有的「3 天」）最后才收。
 *
 * **自然宽度只在 chip 不是图标态时量，量到就记住**：图标态的 chip 缩了，再拿当时的宽度比，会得出
 * 「放得下」→ 展开 → 又放不下 → 来回抖。记住每个 chip 完整态的宽度，之后只拿容器宽和它们比，
 * 同一个宽度恒得同一个档，两边稳定。
 *
 * 纯函数：输入各 chip 的完整宽度、图标态宽度、间距与容器宽，返回「收几个」。
 */

/** 收成图标的先后：从最右边的字 chip 起往左，时间范围（下标 4）最后——它平时本来就不带字 */
export const COMPACT_ORDER = [3, 2, 1, 0, 4] as const;

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
