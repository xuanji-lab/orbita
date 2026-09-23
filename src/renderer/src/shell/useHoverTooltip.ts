import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isPointerOutsideAnchor, placeTooltip, type PlaceTooltipOptions } from "./tooltip-position.ts";

/**
 * 打开后的最长存活时间，超时自动收——最后一道兜底。指针滑进侧栏顶 / 右栏顶行
 * 这类 `-webkit-app-region: drag` 区时，连 `pointermove` 都收不到（拖拽区不派发
 * 给页面），`mouseleave`/`blur` 也可能因为窗口本身没失焦而不触发；不给一个绝对
 * 上限的话 tooltip 就会一直挂在那。与 IconButton 原实现同一个值。
 */
const TOOLTIP_AUTO_CLOSE_MS = 5000;

export interface HoverTooltipState<T extends HTMLElement> {
  /** tooltip 此刻是否该显示（延迟已过，或键盘 :focus-visible 触发） */
  open: boolean;
  /** 首帧定位前为 null——调用方据此把 tooltip 渲染成透明，避免先出现在左上角再跳 */
  placement: { top: number; left: number } | null;
  /** 挂到触发 tooltip 的锚点元素上（tooltip 相对它定位、判出界也量它） */
  anchorRef: RefObject<T | null>;
  /** 挂到 tooltip 自身的浮层元素上——量它的实际尺寸才能算出落点 */
  tooltipRef: RefObject<HTMLDivElement | null>;
  /** 原样展开到锚点元素的 JSX 属性上 */
  handlers: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: (event: React.FocusEvent<T>) => void;
    onBlur: () => void;
  };
}

/**
 * `IconButton` 自绘 tooltip 那套「延迟打开 / 定位 / 指针出界 / 窗口失焦 / 5s 超时 /
 * Esc」状态机抽出来的 hook——两个消费者共用（IconButton 200ms、skill 行 350ms），
 * 只有延迟时长不同。**portal 与 tooltip 的具体视觉不在这里**：IconButton 是单行
 * caption，skill 行是名字 + 描述 + 归属三段，两边长得不一样，交给各自的调用方
 * `createPortal` 自己的内容；这里只回答「什么时候该显示、显示在哪」。
 *
 * `enabled=false` 时（如 IconButton 没有 label/title 文案）打开与键盘触发都不生效，
 * 但 `onBlur`/Esc 这类收的路径始终挂着——同 IconButton 原实现，不因为禁用就少注册。
 *
 * `place` 原样转给 `placeTooltip`（`side`/`align`/`alignOffset`）——不传时用
 * 它的默认值（上方、居中），IconButton 不传，保持现状；skill 行传
 * `{ side: "below", align: "start", alignOffset: 10 }`。
 */
export function useHoverTooltip<T extends HTMLElement>(
  delayMs: number,
  enabled = true,
  place?: PlaceTooltipOptions,
): HoverTooltipState<T> {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<T | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const delayRef = useRef<number | null>(null);
  /**
   * 这次打开是 hover 触发还是键盘 `:focus-visible` 触发——pointermove 出界规则
   * 只对前者生效（键盘用户的指针可能停在屏幕任何地方，出界判定对它没有意义）。
   */
  const openedByPointerRef = useRef(false);

  const close = (): void => {
    if (delayRef.current !== null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    setOpen(false);
  };
  const openWithDelay = (): void => {
    if (!enabled) return;
    openedByPointerRef.current = true;
    if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    delayRef.current = window.setTimeout(() => setOpen(true), delayMs);
  };

  // Esc 立即收（hover 场景焦点不在锚点上，得听窗口级按键）；关组件时清掉未触发的定时器
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    return () => {
      if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    };
  }, []);

  // 三道兜底，只在打开期间挂、关掉就摘（不常驻）：pointermove 出界（只认 hover
  // 打开的）、window blur（不管怎么打开的）、定时器超时强制收。
  useEffect(() => {
    if (!open) return;
    const onPointerMove = (event: PointerEvent): void => {
      if (!openedByPointerRef.current) return;
      const anchor = anchorRef.current;
      if (anchor === null) return;
      if (isPointerOutsideAnchor({ x: event.clientX, y: event.clientY }, anchor.getBoundingClientRect())) {
        close();
      }
    };
    const onWindowBlur = (): void => close();
    document.addEventListener("pointermove", onPointerMove);
    window.addEventListener("blur", onWindowBlur);
    const autoCloseTimer = window.setTimeout(close, TOOLTIP_AUTO_CLOSE_MS);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onWindowBlur);
      window.clearTimeout(autoCloseTimer);
    };
  }, [open]);

  // 打开后先以透明渲染一帧，量出锚点与 tooltip 的实际几何再落位——避免先出现在左上角再跳
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const anchor = anchorRef.current;
    const tip = tooltipRef.current;
    if (anchor === null || tip === null) return;
    const box = anchor.getBoundingClientRect();
    const next = placeTooltip(
      { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      place,
    );
    if (next.visible) setPlacement({ top: next.top, left: next.left });
    else setOpen(false);
  }, [open]);

  return {
    open,
    placement,
    anchorRef,
    tooltipRef,
    handlers: {
      onMouseEnter: openWithDelay,
      onMouseLeave: close,
      onFocus: (event) => {
        // 键盘聚焦立即显示（不等延迟）；只认 :focus-visible——鼠标点下也会给焦点，
        // 不认的话点过的控件会一直挂着 tooltip。
        if (enabled && event.target.matches(":focus-visible")) {
          openedByPointerRef.current = false;
          setOpen(true);
        }
      },
      onBlur: close,
    },
  };
}
