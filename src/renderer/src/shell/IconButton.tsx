import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip } from "./tooltip-position.ts";

/** 悬停到 tooltip 出现的延迟（150–250ms 的中值）：太快手抖就闪，太慢感知等于没有 */
const TOOLTIP_DELAY_MS = 200;

/**
 * 纯图标控件（设计系统 `components/core/IconButton.jsx` 的移植）。
 *
 * 两条硬规则落在这里：
 *  - **hover 是中性抬升**：填 `--color-bg-hover`、文字从 secondary 升到 primary，不染 accent、不位移
 *  - **玻璃上禁用不用 opacity**：调暗的字在半透明面上既不是墨也不是壁纸，改用实色 tertiary
 *
 * **tooltip 是自绘的，不再用原生 `title`**（2026-09-22 真机反馈：macOS 原生 tooltip
 * 约 2 秒才出现，遗留事项行的 corner-up-right / corner-down-left hover 分不清谁是谁）。
 * 定位走 portal + fixed——侧栏和面板是 overflow:hidden，::after 方案会被裁掉。
 * 这是对设计系统的一处偏离：readme 说「不发明 Tooltip 组件，icons get their meaning
 * from `title`」，但原生延迟不可调；IconButton 是所有纯图标控件的收口，改一处处处生效。
 */
export function IconButton(props: {
  label: string;
  onClick?: () => void;
  /** 右键透传（同一个按钮挂备选手势时用，如遗留事项的「继续」：左键新开 / 右键续原会话） */
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  size?: number;
  /** soft = 一层极轻的面（设计系统模板里右图标条用的就是它）；默认 ghost 完全透明 */
  variant?: "ghost" | "soft";
  active?: boolean;
  disabled?: boolean;
  /** tooltip 文案；不传退回 label。只进自绘 tooltip，不再挂到 button 上（防双 tooltip） */
  title?: string;
  /** 开合开关用（折叠 chevron 这类）：读屏要听得到「这块内容现在是收着的」 */
  ariaExpanded?: boolean;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const delayRef = useRef<number | null>(null);
  const box = props.size ?? 32;
  const disabled = props.disabled === true;
  const active = props.active === true;
  const text = (props.title ?? props.label).trim();
  const tooltipEnabled = text !== "";

  const closeTooltip = (): void => {
    if (delayRef.current !== null) {
      window.clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    setTooltipOpen(false);
  };
  const openTooltipWithDelay = (): void => {
    if (!tooltipEnabled) return;
    if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    delayRef.current = window.setTimeout(() => setTooltipOpen(true), TOOLTIP_DELAY_MS);
  };

  // Esc 立即收（hover 场景焦点不在按钮上，得听窗口级按键）；关组件时清掉未触发的定时器
  useEffect(() => {
    if (!tooltipOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setTooltipOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tooltipOpen]);
  useEffect(() => {
    return () => {
      if (delayRef.current !== null) window.clearTimeout(delayRef.current);
    };
  }, []);

  // 打开后先以透明渲染一帧，量出按钮与 tooltip 的实际几何再落位——避免先出现在左上角再跳
  useLayoutEffect(() => {
    if (!tooltipOpen) {
      setPlacement(null);
      return;
    }
    const button = buttonRef.current;
    const tip = tooltipRef.current;
    if (button === null || tip === null) return;
    const anchor = button.getBoundingClientRect();
    const next = placeTooltip(
      { top: anchor.top, bottom: anchor.bottom, left: anchor.left, right: anchor.right },
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (next.visible) setPlacement({ top: next.top, left: next.left });
    else setTooltipOpen(false);
  }, [tooltipOpen]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={props.label}
        aria-pressed={active || undefined}
        aria-expanded={props.ariaExpanded}
        /**
         * 不用原生 `disabled`：禁用控件收不到鼠标事件，hover 解释无从谈起——
         * 而「禁用更需要解释」（如遗留事项跳转按钮：来源已删才禁）。改用
         * aria-disabled + 拦截点击，读屏语义不变，悬停与键盘聚焦仍然可达。
         */
        aria-disabled={disabled || undefined}
        onClick={disabled ? undefined : props.onClick}
        onContextMenu={props.onContextMenu}
        onMouseEnter={() => {
          setHover(true);
          openTooltipWithDelay();
        }}
        onMouseLeave={() => {
          setHover(false);
          closeTooltip();
        }}
        onFocus={(event) => {
          // 键盘聚焦立即显示（不等 200ms）：Tab 路过就该听得到这颗键是什么。
          // 只认 :focus-visible——鼠标点下也会给焦点，不认的话点过的按钮一直挂着 tooltip
          if (tooltipEnabled && event.target.matches(":focus-visible")) setTooltipOpen(true);
        }}
        onBlur={closeTooltip}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flex: "0 0 auto",
          width: box,
          height: box,
          padding: 0,
          border: 0,
          borderRadius: "var(--radius-md)",
          background: active
            ? "var(--color-mode-active-bg)"
            : hover && !disabled
              ? "var(--option-hover-bg)"
              : props.variant === "soft"
                ? "var(--color-bg-muted)"
                : "transparent",
          color: disabled
            ? "var(--color-text-tertiary)"
            : active
              ? "var(--color-mode-active-fg)"
              : hover
                ? "var(--color-text-primary)"
                : "var(--color-text-secondary)",
          cursor: disabled ? "not-allowed" : "pointer",
          transition: "var(--transition-hover)",
          ...props.style,
        }}
      >
        {props.children}
      </button>
      {tooltipOpen &&
        createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: placement?.top ?? 0,
              left: placement?.left ?? 0,
              maxWidth: 240,
              padding: "2px 8px",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-bg-panel)",
              boxShadow: "var(--shadow-popover)",
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-caption)",
              lineHeight: "var(--line-height-caption)",
              pointerEvents: "none",
              // 浮层顶格：高于 Menu 的 portal（40）与 SkillsPanel 的命令条（30）
              zIndex: 70,
              // 未落位前不显形，落位后从透明过渡进来；出场上不拖沓
              opacity: placement === null ? 0 : 1,
              transition: "opacity var(--duration-fast) var(--ease-standard)",
            }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
