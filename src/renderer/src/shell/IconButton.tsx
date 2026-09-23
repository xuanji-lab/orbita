import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isPointerOutsideAnchor, placeTooltip } from "./tooltip-position.ts";

/** 悬停到 tooltip 出现的延迟（150–250ms 的中值）：太快手抖就闪，太慢感知等于没有 */
const TOOLTIP_DELAY_MS = 200;
/**
 * 打开后的最长存活时间，超时自动收——最后一道兜底。指针滑进侧栏顶 / 右栏顶行
 * 这类 `-webkit-app-region: drag` 区时，连 `pointermove` 都收不到（拖拽区不派发
 * 给页面），`mouseleave`/`blur` 也可能因为窗口本身没失焦而不触发；不给一个绝对
 * 上限的话 tooltip 就会一直挂在那（用户反馈过「Mark this task done」卡住不走）。
 */
const TOOLTIP_AUTO_CLOSE_MS = 5000;

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
 *
 * **收的兜底（2026-09-23）**：只认 `mouseleave`/`blur`/Esc 收不住——指针从按钮直接
 * 滑进拖拽区（侧栏顶、右栏顶行 `.titlebar`）或快速甩出窗口时收不到 `mouseleave`，
 * tooltip 会一直挂着。打开期间再挂三层：document 级 `pointermove` 判出界即收（只对
 * hover 打开的生效，见 `openedByPointerRef`）、`window` 的 `blur` 收、
 * `TOOLTIP_AUTO_CLOSE_MS` 超时自收。三者只在 `tooltipOpen` 为真时挂，关掉就摘。
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
  /** 调用方追加的 class（如任务行星标/更多键的 hover 浮现钩子），与内建的安静控件配方叠加 */
  className?: string;
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const delayRef = useRef<number | null>(null);
  /**
   * 这次打开是 hover 触发还是键盘 `:focus-visible` 触发——pointermove 出界规则
   * 只对前者生效（键盘用户的指针可能停在屏幕任何地方，出界判定对它没有意义）。
   * hover 路径在 `openTooltipWithDelay` 里置 true，键盘路径在 `onFocus` 里置 false，
   * 各自在自己触发时点亮，不需要在 close 时复位。
   */
  const openedByPointerRef = useRef(false);
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
    openedByPointerRef.current = true;
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

  // 三道兜底，只在打开期间挂、关掉就摘（不常驻）：
  //  - document 级 pointermove：指针出了按钮的框就收，但只认 hover 打开的
  //    （openedByPointerRef）——键盘聚焦打开时指针可能根本不在按钮附近
  //  - window blur：窗口整体失焦，不管是怎么打开的都收
  //  - 定时器：TOOLTIP_AUTO_CLOSE_MS 后强制收，拖拽区里连 pointermove 都收不到，
  //    这是最后一道
  useEffect(() => {
    if (!tooltipOpen) return;
    const onPointerMove = (event: PointerEvent): void => {
      if (!openedByPointerRef.current) return;
      const button = buttonRef.current;
      if (button === null) return;
      if (isPointerOutsideAnchor({ x: event.clientX, y: event.clientY }, button.getBoundingClientRect())) {
        closeTooltip();
      }
    };
    const onWindowBlur = (): void => closeTooltip();
    document.addEventListener("pointermove", onPointerMove);
    window.addEventListener("blur", onWindowBlur);
    const autoCloseTimer = window.setTimeout(closeTooltip, TOOLTIP_AUTO_CLOSE_MS);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", onWindowBlur);
      window.clearTimeout(autoCloseTimer);
    };
  }, [tooltipOpen]);

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
        onMouseEnter={openTooltipWithDelay}
        onMouseLeave={closeTooltip}
        onFocus={(event) => {
          // 键盘聚焦立即显示（不等 200ms）：Tab 路过就该听得到这颗键是什么。
          // 只认 :focus-visible——鼠标点下也会给焦点，不认的话点过的按钮一直挂着 tooltip
          if (tooltipEnabled && event.target.matches(":focus-visible")) {
            // 键盘打开：pointermove 出界规则不认这次打开（见 openedByPointerRef 的注释）
            openedByPointerRef.current = false;
            setTooltipOpen(true);
          }
        }}
        onBlur={closeTooltip}
        className={`quiet-control${props.variant === "soft" ? " icon-btn-soft" : ""}${props.className === undefined ? "" : ` ${props.className}`}`}
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
