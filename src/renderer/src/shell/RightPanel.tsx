import { useEffect, useState } from "react";
import { Icon } from "../shell/Icon";

/**
 * 右侧分屏面板的框架（规格 §3）：页头（标题区 + x）、内容区（120ms 淡入，
 * contentKey 换帧）、footer 动作区（发丝顶线分隔）。Skills / MCP 两个面板
 * 共用这一副骨架，各自把 header / 内容 / footer 塞进来。
 *
 * 两种容器形态（规格 §1.3）：分屏 320px；窄窗（<960px）转右侧锚定覆盖层，
 * 阴影升 --shadow-popover，无遮罩不是 modal。进入 220ms
 * --duration-enter --ease-out-quint 滑入。关闭三出口：再点图标 / x / Esc。
 */
export function RightPanelFrame(props: {
  narrow: boolean;
  /** 页头标题区（x 与拖拽区由框架出）；list/detail 换头就换这个 */
  header: React.ReactNode;
  /** 内容切换的 key（换帧触发 120ms fade） */
  contentKey: string;
  footer?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const { narrow } = props;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  return (
    <aside
      className="pane"
      style={{
        flex: narrow ? undefined : "0 0 320px",
        width: narrow ? 320 : undefined,
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr) auto",
        animation: "right-panel-in var(--duration-enter) var(--ease-out-quint)",
        ...(narrow
          ? {
              position: "absolute",
              top: "var(--space-3)",
              bottom: "var(--space-3)",
              right: "calc(var(--space-3) + 32px + var(--space-3))",
              boxShadow: "var(--shadow-popover)",
              zIndex: 20,
            }
          : {}),
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
