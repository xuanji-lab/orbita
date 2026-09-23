import { createPortal } from "react-dom";
import { useHoverTooltip } from "./useHoverTooltip.ts";

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
 *
 * **收的兜底（2026-09-23）**：只认 `mouseleave`/`blur`/Esc 收不住——指针从按钮直接
 * 滑进拖拽区（侧栏顶、右栏顶行 `.titlebar`）或快速甩出窗口时收不到 `mouseleave`，
 * tooltip 会一直挂着。打开期间再挂三层：document 级 `pointermove` 判出界即收（只对
 * hover 打开的生效）、`window` 的 `blur` 收、超时自收。三者只在打开期间挂，关掉就摘。
 *
 * **延迟 / 定位 / portal / 出界 / 失焦 / 超时 / Esc 这套状态机在 `useHoverTooltip`
 * 里**（2026-09-23 抽出）：skill 列表的行 hover tooltip 是第二个消费者，只是延迟时长
 * 不同（这里 200ms，skill 行 350ms）。tooltip 的具体视觉——这里是单行 caption——
 * 仍然留在这个组件自己画，hook 只回答「什么时候显示、显示在哪」。
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
  const box = props.size ?? 32;
  const disabled = props.disabled === true;
  const active = props.active === true;
  const text = (props.title ?? props.label).trim();
  const tooltipEnabled = text !== "";
  const tooltip = useHoverTooltip<HTMLButtonElement>(TOOLTIP_DELAY_MS, tooltipEnabled);

  return (
    <>
      <button
        ref={tooltip.anchorRef}
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
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
        onFocus={tooltip.handlers.onFocus}
        onBlur={tooltip.handlers.onBlur}
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
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            role="tooltip"
            style={{
              position: "fixed",
              top: tooltip.placement?.top ?? 0,
              left: tooltip.placement?.left ?? 0,
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
              opacity: tooltip.placement === null ? 0 : 1,
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
