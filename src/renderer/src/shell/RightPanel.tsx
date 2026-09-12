import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Icon } from "../shell/Icon";
import { RIGHT_PANEL_WIDTH_MAX, RIGHT_PANEL_WIDTH_MIN } from "@shared/settings";

/**
 * 折叠中（closing）由调用方在「目标面板已置空、但还没卸载」的收起动画窗口里置真：
 * 面板宽度过渡回 0（与抽屉收起同款），动画走完调用方再卸载。面板内部零感知。
 */
export const RightPanelClosingContext = createContext(false);

/**
 * 右侧分屏面板的框架（规格 §3）：页头（标题区 + x）、内容区（120ms 淡入，
 * contentKey 换帧）、footer 动作区（发丝顶线分隔）。Skills / MCP 两个面板
 * 共用这一副骨架，各自把 header / 内容 / footer 塞进来。
 *
 * 两种容器形态：宽窗是 **pane 内的一列**，左缘一条竖线与主会话区分界（2026-09-12
 * 裁决：与辅助对话抽屉同款，不要间隔），展开动画也同款——width 0→目标 0.2s ease；
 * 窄窗（<960px）转右侧锚定覆盖层，那时才需要自己的面——玻璃底、圆角，
 * 阴影升 --shadow-popover，无遮罩不是 modal，进入保留滑入 + 淡入（right-panel-in）。
 * 关闭三出口：再点图标 / x / Esc。
 */
export function RightPanelFrame(props: {
  narrow: boolean;
  /** 页头标题区（x 与拖拽区由框架出）；list/detail 换头就换这个 */
  header: React.ReactNode;
  /** 内容切换的 key（换帧触发 120ms fade） */
  contentKey: string;
  /** 页头右侧、x 左边的槽（添加按钮等） */
  headerExtra?: React.ReactNode;
  footer?: React.ReactNode;
  /** 面板宽度（4-0 拖宽）。分栏态生效；窄窗覆盖层固定 320 不可拖 */
  width: number;
  /** 拖动中每帧回调（只改本地状态，不落盘） */
  onWidthChange: (width: number) => void;
  /** 松手 / 双击复位时回调（落盘） */
  onWidthCommit: (width: number) => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { narrow } = props;
  const closing = useContext(RightPanelClosingContext);
  const asideRef = useRef<HTMLElement | null>(null);
  /** 分栏态的展开/收起动画与抽屉同款（width 0↔目标，0.2s ease）：挂载下一拍才到位，过渡才会发生 */
  const [entered, setEntered] = useState(false);
  /** 拖宽中禁掉 width 过渡——实时跟手（同 .drawer.dragging 的纪律） */
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (narrow) return;
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [narrow]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  /**
   * 拖宽（4-0）：左移变宽。夹取两道：硬区间 280–560，以及 chat ≥ 480 的底线
   * （按下那一刻用 pane 当前宽度算出面板能长到的上限——拖动中 pane 收缩、面板
   * 变宽，总和不变，所以起点一次算准，不需要每帧重测）。拖动中不做动画；
   * 松手不 snap；双击热区回 320。
   */
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const panel = asideRef.current;
    if (panel === null) return;
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = panel.getBoundingClientRect().width;
    // 面板是 pane 的子元素（分栏形态），closest 拿它算 chat ≥480 的底线
    const pane = panel.closest("main.pane");
    const paneWidth = pane?.getBoundingClientRect().width ?? startWidth + 480;
    const maxByChat = startWidth + Math.max(0, paneWidth - 480);
    const max = Math.min(RIGHT_PANEL_WIDTH_MAX, maxByChat);
    const clamp = (value: number): number =>
      Math.min(max, Math.max(RIGHT_PANEL_WIDTH_MIN, Math.round(value)));
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
      style={{
        position: narrow ? "absolute" : "relative",
        // 分栏态：展开/收起动画与辅助对话抽屉同款——width 0↔目标 0.2s ease，拖宽中禁过渡
        width: narrow ? 320 : entered && !closing ? props.width : 0,
        flex: narrow ? undefined : "0 0 auto",
        overflow: "hidden",
        transition:
          narrow || resizing
            ? undefined
            : "width 0.2s ease, border-left-width 0.2s ease",
        // 窄窗覆盖层的定位基准是 .layer（pane 无 position）——右侧让过 rail 一条
        ...(narrow
          ? {
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
          : {
              borderLeft: `${entered && !closing ? 1 : 0}px solid var(--color-border-default)`,
            }),
      }}
    >
      {/*
        内容固定宽，外层 width 动画时它只被 overflow hidden 逐渐「拉开」——
        与抽屉的 drawer-inner 同一个道理，动画期间内容不 reflow。
      */}
      <div
        style={{
          width: narrow ? 320 : props.width,
          height: "100%",
          display: "grid",
          gridTemplateRows: "auto minmax(0,1fr) auto",
        }}
      >
      {/* 拖宽热区：左缘 6px 骑在竖线上；双击回 320 */}
      {!narrow && (
        <span
          onPointerDown={startResize}
          onDoubleClick={() => props.onWidthCommit(320)}
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
        <PanelIconButton title="Close" onClick={props.onClose}>
          <Icon name="x" size={16} />
        </PanelIconButton>
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
    </aside>
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
