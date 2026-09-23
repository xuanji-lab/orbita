/**
 * `McpPanel.tsx` 用到的纯函数：ready 卡的工具列表默认只显示前 `limit` 个，
 * 超出的折进一个「+N more」提示，点击后在卡片内展开全部。不 import React，
 * 可被 `node --test` 直接加载（同 `skill-filter.ts` 的先例）。
 */

/** 默认展示的工具数——超过这个数才折叠（4-3 简报裁决）。 */
export const TOOL_CHIP_LIMIT = 6;

export interface VisibleTools {
  /** 这一轮该渲染成 chip 的工具名 */
  shown: string[];
  /** 折起来的部分；长度就是「+N more」的 N，空数组表示没有折叠 */
  hidden: string[];
}

/**
 * 展开时，或总数没超过 `limit`：全部当作 `shown`，`hidden` 为空。
 * 否则前 `limit` 个进 `shown`，其余进 `hidden`。
 */
export function visibleTools(tools: readonly string[], limit: number, expanded: boolean): VisibleTools {
  if (expanded || tools.length <= limit) {
    return { shown: [...tools], hidden: [] };
  }
  return { shown: tools.slice(0, limit), hidden: tools.slice(limit) };
}
