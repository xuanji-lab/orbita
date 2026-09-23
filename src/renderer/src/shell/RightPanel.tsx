import { useRef, useState } from "react";
import { Icon } from "../shell/Icon";
import { clampRightPanelWidth, RIGHT_PANEL_WIDTH_DEFAULT } from "@shared/settings";
import { usePaneTotalWidth } from "./side-width.ts";

/**
 * 右侧面板壳（2026-09-13 裁决）：Skills / MCP / 辅助对话三个菜单共用这**一个**
 * 常驻挂载的分栏——宽度以 class 切换驱动过渡（与抽屉同一套机制），展开、收起
 * 只有一条动画路径；面板间切换是同一个壳换内容，不存在「折叠再展开」。
 *
 * 宽度变量 `--right-panel-w` 由调用方注入（面板位唯一的宽度记忆，Q3：共用）。
 * 拖宽热区骑在左缘竖线上，拖动中禁过渡（同 .drawer.dragging 的纪律）实时跟手；
 * 双击热区回 320。窄窗（<960px）转右侧锚定覆盖层，进入滑入 + 淡入（right-panel-in）。
 */
export function RightPanelSlot(props: {
  open: boolean;
  width: number;
  narrow: boolean;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  children: React.ReactNode;
}) {
  const { narrow, open } = props;
  const asideRef = useRef<HTMLElement | null>(null);
  /** 拖宽中禁掉 width 过渡——实时跟手（同 .drawer.dragging 的纪律） */
  const [resizing, setResizing] = useState(false);
  /**
   * 区间是 pane（chat 主区 + 右栏）的 1/3–2/3，所以**渲染时也要夹一次**，不只拖动时：
   * 盘上那个宽度可能是在更宽的窗口（或另一台显示器）上存的。只夹渲染值、
   * 不回写 settings；窄窗转覆盖层时宽度写死 320，那时不量也不夹。
   */
  const paneTotal = usePaneTotalWidth(asideRef, !narrow);
  const width = paneTotal > 0 ? clampRightPanelWidth(props.width, paneTotal) : props.width;

  /**
   * 拖宽（4-0）：左移变宽。区间**按 pane 算**——右栏 ∈ [P/3, 2P/3]，
   * P = chat 主区 + 右栏（2026-09-22 wafo 裁决：这一对只管 chat 与右栏，与左侧栏无关），
   * 地板见 clampRightPanelWidth。
   * P 在拖动中恒定：pane 让出多少面板就长多少，所以不必每帧重测。
   * 拖动中不做动画；松手不 snap；双击热区回 320（同样夹一次）。
   */
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const panel = asideRef.current;
    if (panel === null) return;
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    const clamp = (value: number): number => clampRightPanelWidth(value, paneTotal);
    // 拖动期间全文选择与光标都固定成拖拽语义，松手还原
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      props.onWidthChange(clamp(startWidth - (ev.clientX - startX)));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      setResizing(false);
      props.onWidthCommit(clamp(startWidth - (ev.clientX - startX)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  return (
    <aside
      ref={asideRef}
      className={`right-panel-slot${open ? " open" : ""}${resizing ? " dragging" : ""}`}
      style={
        {
          "--right-panel-w": `${narrow ? RIGHT_PANEL_WIDTH_DEFAULT : width}px`,
          // 窄窗覆盖层的定位基准是 .layer（pane 无 position）——右侧让过 rail 一条；
          // 那时壳需要自己的面：玻璃底、圆角，阴影升 popover
          ...(narrow && open
            ? {
                position: "absolute",
                top: "var(--space-3)",
                bottom: "var(--space-3)",
                right: "calc(var(--space-3) + 32px + var(--space-3))",
                background: "var(--glass-bg)",
                border: 0,
                borderRadius: "var(--radius-xl)",
                boxShadow: "var(--shadow-popover)",
                zIndex: 20,
                animation: "right-panel-in var(--duration-enter) var(--ease-out-quint)",
              }
            : {}),
        } as React.CSSProperties
      }
    >
      {/* 拖宽热区：左缘 6px 骑在竖线上；双击回 320 */}
      {!narrow && (
        <span
          onPointerDown={startResize}
          onDoubleClick={() =>
            props.onWidthCommit(clampRightPanelWidth(RIGHT_PANEL_WIDTH_DEFAULT, paneTotal))
          }
          title="Drag to resize · double-click to reset"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 5,
          }}
        />
      )}
      <div className="right-panel-slot-inner">{props.children}</div>
    </aside>
  );
}

/**
 * 面板内容的版式骨架：页头（标题区 + x）、内容区（120ms 淡入，contentKey 换帧）、
 * footer 动作区（发丝顶线分隔）。Skills / MCP 两个面板共用这一副骨架。
 * 宽度、竖线与开合动画都在 RightPanelSlot（壳）上，这里只管内容怎么排。
 */
export function RightPanelFrame(props: {
  /** 页头标题区；x 按钮由框架按 onClose 出 */
  header: React.ReactNode;
  /** 内容切换的 key（换帧触发 120ms fade） */
  contentKey: string;
  /** 页头右侧、x 左边的槽（添加按钮等） */
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  onClose?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr) auto",
      }}
    >
      <header
        className="titlebar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          height: 30,
          padding: "12px 14px",
          boxSizing: "content-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        {props.header}
        <span style={{ flex: 1 }} />
        {props.headerExtra}
        {props.onClose && (
          <PanelIconButton title="Close" onClick={props.onClose}>
            <Icon name="x" size={16} />
          </PanelIconButton>
        )}
      </header>

      <div
        key={props.contentKey}
        className="scroll"
        style={{ minHeight: 0, animation: "right-panel-fade 120ms var(--ease-out-quint)" }}
      >
        {props.children}
      </div>

      {props.footer !== undefined && (
        <footer
          style={{
            borderTop: "1px solid var(--color-border-subtle)",
            padding: "var(--space-3) var(--space-4)",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
          }}
        >
          {props.footer}
        </footer>
      )}
    </div>
  );
}

/** 面板内的 26px 图标方块（x / ←）：hover 中性抬升，永不点亮。 */
export function PanelIconButton(props: {
  title: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      disabled={disabled}
      onClick={props.onClick}
      className="no-drag"
      style={{
        width: 26,
        height: 26,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
        cursor: disabled ? "default" : "pointer",
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--color-bg-hover)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {props.children}
    </button>
  );
}

/** 面板 footer 的次级按钮（sm 高度，中性面）。variant=danger 给破坏性动作。 */
export function PanelButton(props: {
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const disabled = props.disabled === true;
  const danger = props.danger === true;
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={disabled}
      title={props.title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "var(--control-height-sm)",
        padding: "0 var(--space-3)",
        background: danger ? "transparent" : "var(--color-bg-muted)",
        color: danger ? "var(--color-danger)" : "var(--color-text-primary)",
        border: danger ? "1px solid var(--color-danger)" : 0,
        borderRadius: "var(--radius-md)",
        font: "inherit",
        fontSize: "var(--font-size-control)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {props.children}
    </button>
  );
}

/** 面板里的一行小字（caption/tertiary），说明与空态用。 */
export function PanelLine(props: { children: React.ReactNode; danger?: boolean }) {
  return (
    <p
      role={props.danger === true ? "alert" : undefined}
      style={{
        margin: 0,
        fontSize: "var(--font-size-caption)",
        color: props.danger === true ? "var(--color-danger)" : "var(--color-text-tertiary)",
      }}
    >
      {props.children}
    </p>
  );
}
