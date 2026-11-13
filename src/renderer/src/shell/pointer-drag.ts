/**
 * 拖把手（右栏 / 左栏拖宽、意图面板拖高）共用的指针拖拽。
 *
 * 为什么不在 window 上听 pointerup：松手时鼠标若落在沙箱 iframe（看板卡）上，pointerup 进了 iframe，
 * 主窗口收不到——光标锁在 col-resize、文字选不了、pointermove 监听还在，宽度一直跟着鼠标走（实测）。
 * 所以：
 * - 把手 `setPointerCapture`，pointermove / pointerup 都在把手上收——捕获期间事件无论落在哪里（含 iframe 上方）都归把手；
 * - `pointercancel` / `lostpointercapture`（捕获被系统收走、把手被卸掉）/ 窗口失焦也收尾，按最后一次的位移提交；
 * - 拖拽期间 `<html>` 上挂 `data-pointer-drag`，样式表据此让所有 iframe `pointer-events: none` 兜底。
 * 收尾只做一次：还原光标与选择、摘掉标记、摘掉监听，然后回调 `onEnd`。
 */

/** 拖拽期间挂在 `<html>` 上的标记；styles.css 靠它给 iframe 加 pointer-events: none */
export const POINTER_DRAG_ATTR = "data-pointer-drag";

export interface PointerDragDelta {
  /** 相对按下点的位移（px） */
  x: number;
  y: number;
}

export interface PointerDragOptions {
  /** 拖拽期间全窗口的光标 */
  cursor: "col-resize" | "row-resize";
  onMove: (delta: PointerDragDelta) => void;
  /** 收尾：松手、取消、丢失捕获、窗口失焦都走这里，传最后一次的位移 */
  onEnd: (delta: PointerDragDelta) => void;
}

/** 在把手的 pointerdown 里调用。只认主键；返回是否开始了拖拽。 */
export function startPointerDrag(event: React.PointerEvent<HTMLElement>, options: PointerDragOptions): boolean {
  if (event.button !== 0) return false;
  const handle = event.currentTarget;
  const { pointerId, clientX: startX, clientY: startY } = event;
  event.preventDefault();

  const body = document.body;
  const root = document.documentElement;
  // 拖动期间全文选择与光标都固定成拖拽语义，收尾还原
  const previousSelect = body.style.userSelect;
  const previousCursor = body.style.cursor;
  body.style.userSelect = "none";
  body.style.cursor = options.cursor;
  root.setAttribute(POINTER_DRAG_ATTR, "");
  handle.setPointerCapture(pointerId);

  let last: PointerDragDelta = { x: 0, y: 0 };
  let ended = false;
  const track = (ev: PointerEvent): void => {
    last = { x: ev.clientX - startX, y: ev.clientY - startY };
  };
  const move = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    track(ev);
    options.onMove(last);
  };
  const up = (ev: PointerEvent): void => {
    if (ev.pointerId !== pointerId) return;
    track(ev);
    end();
  };
  const lost = (ev: PointerEvent): void => {
    if (ev.pointerId === pointerId) end();
  };
  function end(): void {
    if (ended) return;
    ended = true;
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", up);
    handle.removeEventListener("pointercancel", lost);
    handle.removeEventListener("lostpointercapture", lost);
    window.removeEventListener("blur", end);
    body.style.userSelect = previousSelect;
    body.style.cursor = previousCursor;
    root.removeAttribute(POINTER_DRAG_ATTR);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    options.onEnd(last);
  }
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", up);
  handle.addEventListener("pointercancel", lost);
  handle.addEventListener("lostpointercapture", lost);
  window.addEventListener("blur", end);
  return true;
}
