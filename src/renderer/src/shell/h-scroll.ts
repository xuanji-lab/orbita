import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 横向滚动条的共用件：工作区选择条（WorkspaceFilterBar）与辅助对话胶囊里的标签区
 * （DrawerCap）都是「放不下就横滚、滚动条藏起、被裁的一侧淡出、指定的那档滚进视野」。
 * 滚轮换算是纯函数（node --test 直接测），hook 只管挂监听与量边。
 */

/** 一次滚轮事件里滚动换算需要的字段（WheelEvent 的子集，测试里不必造整个事件） */
export interface WheelLike {
  deltaX: number;
  deltaY: number;
  /** 0 = 像素，1 = 行，2 = 页（鼠标滚轮在个别平台上报行） */
  deltaMode: number;
  shiftKey: boolean;
}

const LINE_PX = 16;

/**
 * 把滚轮事件换成横向滚动的增量；不该接管就返回 null（交还给浏览器原生行为）。
 * - 这一条放不下才接管（`canScroll`），放得下时竖滚轮要继续传给外面的滚动区；
 * - 竖向分量占主导（普通竖滚轮 / 某些平台上未被系统换轴的 Shift+滚轮）→ 换成横向；
 * - 横向分量占主导（触控板横划、macOS 已把 Shift+滚轮换了轴）→ 原样走，不重复滚。
 * Shift 与不按 Shift 在这里同样处理：鼠标没有横滚，Shift+滚轮是用户明示的「横着滚」，
 * 普通竖滚轮落在这一条上也是同一个意图。
 */
export function wheelToScrollDelta(event: WheelLike, canScroll: boolean): number | null {
  if (!canScroll) return null;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return null;
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? LINE_PX * 20 : 1;
  return event.deltaY * unit;
}

/**
 * 要把某一档滚进视野时，该把 scrollLeft 设成多少；已经完整可见就返回 null（不动）。
 * `inset` 是贴边时多留的一点呼吸，免得被淡出遮住。
 */
export function revealScrollLeft(
  view: { scrollLeft: number; clientWidth: number },
  item: { offsetLeft: number; offsetWidth: number },
  inset = 8,
): number | null {
  if (item.offsetLeft < view.scrollLeft) return Math.max(0, item.offsetLeft - inset);
  if (item.offsetLeft + item.offsetWidth > view.scrollLeft + view.clientWidth) {
    return item.offsetLeft + item.offsetWidth - view.clientWidth + inset;
  }
  return null;
}

/** 两端是否还有被裁掉的内容：只在真有时才挂淡出，贴边不挂（否则最左一档永远被淡掉一截） */
export function overflowEdges(view: {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}): { start: boolean; end: boolean } {
  return {
    start: view.scrollLeft > 1,
    end: view.scrollLeft + view.clientWidth < view.scrollWidth - 1,
  };
}

/**
 * 挂在横滚容器上：返回 ref（回调式）、淡出标记（给 data-fade-start / data-fade-end）与 onScroll。
 * `revealSelector` 命中的那个子项在每次依赖变化 / 栏宽变化时滚进视野（只动这一条自己的
 * scrollLeft，不连祖先一起滚）。滚轮用原生非被动监听：接管时 preventDefault，
 * 否则 Shift+滚轮会被浏览器再横滚一遍（双倍速）。
 * ref 用回调 + state 存节点：容器可能晚于首次渲染才挂上（portal 进工具栏胶囊，宿主
 * 要等一帧才有），effect 必须在节点真的到手时才跑，不能只在首次渲染跑一次。
 */
export function useHScroll(revealSelector: string | null, deps: readonly unknown[]): {
  ref: (node: HTMLDivElement | null) => void;
  fade: { start: boolean; end: boolean };
  onScroll: () => void;
} {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [fade, setFade] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const measure = useCallback(() => {
    if (el === null) return;
    const next = overflowEdges(el);
    setFade((now) => (now.start === next.start && now.end === next.end ? now : next));
  }, [el]);
  const reveal = useCallback(() => {
    if (el === null || revealSelector === null) return;
    const item = el.querySelector<HTMLElement>(revealSelector);
    if (item === null) return;
    const target = revealScrollLeft(el, item);
    if (target !== null) el.scrollLeft = target;
  }, [el, revealSelector]);

  useEffect(() => {
    reveal();
    measure();
    if (el === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      reveal();
      measure();
    });
    observer.observe(el);
    return () => observer.disconnect();
    // deps 由调用方给（选项集 / 选中项变了要重来一次）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, measure, reveal, ...deps]);

  useEffect(() => {
    if (el === null) return;
    const onWheel = (event: WheelEvent): void => {
      const delta = wheelToScrollDelta(event, el.scrollWidth > el.clientWidth);
      if (delta === null) return;
      event.preventDefault();
      el.scrollLeft += delta;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [el]);

  return { ref: setEl, fade, onScroll: measure };
}
