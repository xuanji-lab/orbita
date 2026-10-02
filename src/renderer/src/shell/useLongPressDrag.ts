import { useCallback, useRef, useState } from "react";
import {
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  ORBITA_TOKEN_MIME,
  encodeTokenPayload,
  longPressArmed,
  type OrbitaTokenPayload,
} from "./panel-token.ts";

/**
 * 长按拖拽源（Skills 行 / MCP 卡片共用）。
 *
 * 按住约 300ms 且位移不超容差 → 进入可拖状态（`armed`）：这时才把
 * `draggable` 挂到元素上、随后移动触发原生 HTML5 拖拽。**先按后挂为什么可行**：
 * Blink 在指针越过拖拽阈值的那次 mousemove 上重新求值 `DraggableNode`
 * （MouseEventManager::HandleDrag），`mouse_down_may_start_drag_` 本身不依赖
 * draggable（MouseEventManager::HandleMousePressEvent 只看单击 / 链接 / 选区），
 * 所以 mousedown 时还不可拖的元素，按住中途挂上 draggable 依然能起拖。
 * 反过来，300ms 窗口内元素不可拖 → 这一次手势被 Blink 判死（no element is
 * draggable），点击照常派发——QueueStrip 2026-09-12 的「整行 draggable 吞
 * 点击」事故在这里天然不存在：**不武装就永远不可拖**。
 *
 * 短按（< 300ms 松手）不受影响，click 照走；长按后松手（没拖）的 click 会被
 * 捕获阶段拦下——按住 300ms 已表达拖拽意图，不该再当一次点选。
 *
 * 负载用 getter 取：行在等待期里数据可能刷新（reload），起拖那一刻读到最新的。
 */
export function useLongPressDrag(getPayload: () => OrbitaTokenPayload | null): {
  /** 已进入可拖状态（draggable 已挂上） */
  armed: boolean;
  /** 原生拖拽进行中（dragstart → dragend） */
  dragging: boolean;
  handlers: {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
    onDragStart: (event: React.DragEvent<HTMLElement>) => void;
    onDragEnd: (event: React.DragEvent<HTMLElement>) => void;
  };
} {
  const [armed, setArmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 长按后松手要吞掉的 click（见上）；下一次 pointerdown 重置 */
  const suppressClickRef = useRef(false);
  const getPayloadRef = useRef(getPayload);
  getPayloadRef.current = getPayload;

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    // 只认鼠标主键：HTML5 拖拽本身也只有鼠标一条路，触点 / 笔不掺和
    if (event.button !== 0 || event.pointerType !== "mouse") return;
    suppressClickRef.current = false;
    const start = { x: event.clientX, y: event.clientY, at: performance.now() };
    let moved = 0;
    let alive = true;
    const detach = (): void => {
      alive = false;
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
    const tryArm = (): void => {
      if (!alive || !longPressArmed(performance.now() - start.at, moved)) return;
      setArmed(true);
    };
    // 两路判定共用 longPressArmed：静止按时靠定时器，期间有微动靠 move 事件重算
    const timer = window.setTimeout(tryArm, LONG_PRESS_MS);
    const onMove = (ev: PointerEvent): void => {
      if (!alive) return;
      moved = Math.max(
        moved,
        Math.hypot(ev.clientX - start.x, ev.clientY - start.y),
      );
      if (moved > LONG_PRESS_MOVE_TOLERANCE_PX) detach();
    };
    const onUp = (): void => {
      // 按住超过长按时长才松手：吞 click（拖拽意图），哪怕没真的起拖
      if (performance.now() - start.at >= LONG_PRESS_MS) suppressClickRef.current = true;
      detach();
    };
    const onCancel = (): void => detach();
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }, []);

  const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>): void => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const onDragStart = useCallback((event: React.DragEvent<HTMLElement>): void => {
    const payload = getPayloadRef.current();
    if (payload === null) {
      event.preventDefault();
      return;
    }
    // text/plain 让拖到任何文本框都落得下一段可读文字；自定义 MIME 给输入框做补空格
    event.dataTransfer.setData("text/plain", payload.token);
    event.dataTransfer.setData(ORBITA_TOKEN_MIME, encodeTokenPayload(payload));
    event.dataTransfer.effectAllowed = "copy";
    setDragging(true);
  }, []);

  const onDragEnd = useCallback((): void => {
    setDragging(false);
    setArmed(false);
  }, []);

  return {
    armed,
    dragging,
    handlers: { onPointerDown, onClickCapture, onDragStart, onDragEnd },
  };
}
