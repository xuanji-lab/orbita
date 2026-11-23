/**
 * 对话里看板结果的「展开 / 收起」：限高与展开状态的纯逻辑 + 一份按 toolCallId 记在内存里的展开状态
 * （纯模块，不 import React，可被 node --test 直接加载；React 钩子在 PluginBoardResult.tsx）。
 *
 * 展开状态只存内存、不落盘：切会话再回来 / 虚拟化把这一行卸下又挂上都还记得，重启应用后回到收起。
 * 用 toolCallId 作键——它在整条会话里唯一，状态卡的缩略图点过来（`requestRevealBoard`）也靠它定位。
 */

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
