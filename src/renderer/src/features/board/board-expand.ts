/**
 * 对话里看板结果的「展开 / 收起」：限高与展开状态的纯逻辑 + 一份按 toolCallId 记在内存里的展开状态
 * （纯模块，不 import React，可被 node --test 直接加载；React 钩子在 PluginBoardResult.tsx）。
 *
 * 展开状态只存内存、不落盘：切会话再回来 / 虚拟化把这一行卸下又挂上都还记得，重启应用后回到收起。
 * 用 toolCallId 作键——它在整条会话里唯一，状态卡的缩略图点过来（`requestRevealBoard`）也靠它定位。
 */

import type { BoardCardSize } from "../../../../shared/plugin-board.ts";
import { containerLayout, gridHeight } from "../plugins/board-layout.ts";

/** 对话里看板结果收起时最高占窗口高度的几成：一张 2x2 的卡能占满一整屏，收起时限到约半屏 */
export const BOARD_RESULT_MAX_VH = 0.5;

export interface BoardClip {
  /** 收起时的限高（像素） */
  cap: number;
  /** 内容比限高高：有得展开 / 收起 */
  foldable: boolean;
  /** 此刻被裁着（可折叠且没展开） */
  clipped: boolean;
  /** 外框的 max-height；不裁 = null（完整显示） */
  maxHeight: number | null;
}

/**
 * 看板外框此刻要不要限高。`contentHeight` 是卡片网格排好后的整块高度（占位高度，与真实排版一致），
 * 所以收起 / 展开、卸 iframe / 挂 iframe 都不会让外框高度和真实高度对不上。
 */
export function boardClip(input: { contentHeight: number; windowHeight: number; expanded: boolean }): BoardClip {
  const cap = Math.round(input.windowHeight * BOARD_RESULT_MAX_VH);
  const foldable = input.contentHeight > cap;
  const clipped = foldable && !input.expanded;
  return { cap, foldable, clipped, maxHeight: clipped ? cap : null };
}

/**
 * 虚拟列表里一行看板结果比 `.board-result` 本体多出来的高度：`.board-result` 上下各 8px 的 margin（--space-2）
 * + 虚拟行的 padding-bottom（--chat-row-gap，实测 20px）。实测：看板 400 → 行 436，看板 326.7 → 行 362.7。
 */
export const BOARD_ROW_EXTRA = 36;

/**
 * 一行看板结果**还没挂载过**时的高度估值（给虚拟列表的 estimateSize 用）。
 *
 * 为什么要有它：未测行默认按 kind 估，`toolCall` 的先验是 230——对工具行合适，对看板结果差得远
 * （2x2 收起是 436、2x1 是 363，随宽度线性变）。往上滚进没挂载过的看板行时，估值被实测替换，
 * 总高一次跳 130–200px，只补偿「整行都在视口上方」的部分，其余就成了视口里的位移（实测 8 次看板进入、
 * 总高跳 +344 / +89 / −304，对应视口里 13 – 171px 的跳变）。看板的高度其实能从快照直接算出来
 * （与挂载后的占位同一个 `gridHeight`），所以直接给准。
 */
export function boardRowEstimate(
  board: { cards: readonly { size: BoardCardSize }[] },
  ctx: { columnWidth: number; windowHeight: number; expanded: boolean },
): number {
  const content = gridHeight(containerLayout(ctx.columnWidth), board.cards.map((card) => card.size));
  const clip = boardClip({ contentHeight: content, windowHeight: ctx.windowHeight, expanded: ctx.expanded });
  return (clip.maxHeight === null ? content : Math.min(content, clip.maxHeight)) + BOARD_ROW_EXTRA;
}

/**
 * 收起时滚动位置怎么补：展开的看板很长，「收起」钮在最底下，点完整块缩到半屏、顶部若本来就在视口上方，
 * 用户就迷路了。看板顶部在滚动容器顶部之上时，返回要加到 scrollTop 上的量（负数，上滚），让顶部落在容器顶下 margin 处；
 * 顶部本来就在视口里返回 0（不动）。
 */
export function collapseScrollDelta(hostTop: number, rootTop: number, margin: number): number {
  return hostTop < rootTop ? hostTop - rootTop - margin : 0;
}

/** 按 toolCallId 记哪些看板是展开的（订阅制，给 useSyncExternalStore 用） */
export class BoardExpandStore {
  private readonly open = new Set<string>();
  private readonly listeners = new Set<() => void>();

  has = (toolCallId: string): boolean => this.open.has(toolCallId);

  set(toolCallId: string, expanded: boolean): void {
    if (this.open.has(toolCallId) === expanded) return;
    if (expanded) this.open.add(toolCallId);
    else this.open.delete(toolCallId);
    for (const listener of [...this.listeners]) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** 模块级单份：对话里所有看板结果共用 */
export const boardExpandStore = new BoardExpandStore();
