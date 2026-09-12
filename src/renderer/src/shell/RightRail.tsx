import { useEffect, useState } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * 右图标条，32px，**常驻**（首页也可达）。与左栏同款「无自己的面」：直接坐在
 * layer 1 上。wafo 2026-09-12 裁定保持 32px 不加宽到 48——「左右对称」不取字面
 * 同宽，只保留「都是无面的窄条」。
 *
 * 顶部：skills / mcp 两个入口（各开一个右侧分屏面板，互斥）+ 抽屉开关（right-drawer-X
 * 并入本条，2026-09-12 裁决：原标题栏上的两枚动作图标住进这里）。点亮 = 单层
 * `--glass-bg` + `--shadow-composer`：图标与面板都是 layer 1 的子级，各自的
 * 背景都在 layer 1 之上再叠一层 .60，合成同色——所以用同一个单层 token 就
 * 天然与面板融合，不需要手调第二层值（规格 §1.1）。32px 条里 26px 的方块用
 * `--radius-sm`（md 太圆）。
 *
 * 底部：会话动作（复制转录等），**只在有会话时出现**——它承载的是「对这个会话
 * 做点什么」，首页没有会话可做。中间用弹性空隙隔开两组的语义。
 */
export type RightPanelKind = "skills" | "mcp";

export function RightRail(props: {
  panel: RightPanelKind | null;
  onPanel: (next: RightPanelKind | null) => void;
  /** 会话动作区：调用方塞什么就长什么；false = 没有会话，不渲染这一段 */
  sessionActions?: false | React.ReactNode;
  /** 抽屉开关（辅助对话）：点亮 = 抽屉开着 */
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}) {
  const entry = (kind: RightPanelKind, icon: IconName, label: string) => {
    const lit = props.panel === kind;
    return (
      <button
        key={kind}
        type="button"
        title={label}
        aria-pressed={lit}
        onClick={() => props.onPanel(lit ? null : kind)}
        style={{
          width: 26,
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: 0,
          cursor: "pointer",
          borderRadius: "var(--radius-sm)",
          background: lit ? "var(--glass-bg)" : "transparent",
          boxShadow: lit ? "var(--shadow-composer)" : "none",
          color: lit ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        }}
        onMouseEnter={(e) => {
          if (lit) return;
          e.currentTarget.style.background = "var(--color-bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (lit) return;
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Icon name={icon} size={16} />
      </button>
    );
  };

  return (
    <aside
      style={{
        flex: "0 0 auto",
        width: 32,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--space-2)",
        // 顶行与侧栏字标行同行同高（padding-top 一致），第一个入口与左侧折叠图标对齐
        padding: "var(--space-2) 0",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      {/* 顶部这行兼作拖拽区（.titlebar）；Skills 入口住在行内与折叠图标同行 */}
      <span
        className="titlebar"
        style={{
          height: 34,
          width: "100%",
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {entry("skills", "book-open", "Skills")}
      </span>
      {entry("mcp", "plug", "MCP servers")}
      {/* 抽屉开关（辅助对话）：点亮语义与面板入口一致——开着就亮 */}
      <button
        type="button"
        title="辅助对话 Ctrl+Alt+D"
        aria-pressed={props.drawerOpen}
        onClick={props.onToggleDrawer}
        style={{
          width: 26,
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: 0,
          cursor: "pointer",
          borderRadius: "var(--radius-sm)",
          background: props.drawerOpen ? "var(--glass-bg)" : "transparent",
          boxShadow: props.drawerOpen ? "var(--shadow-composer)" : "none",
          color: props.drawerOpen ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        }}
        onMouseEnter={(e) => {
          if (props.drawerOpen) return;
          e.currentTarget.style.background = "var(--color-bg-hover)";
        }}
        onMouseLeave={(e) => {
          if (props.drawerOpen) return;
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Icon name="panel-right" size={16} />
      </button>
      <span style={{ flex: 1 }} />
      {props.sessionActions !== false && props.sessionActions}
    </aside>
  );
}

/** 会话动作区（RightRail 底部）：复制转录。从旧 ActionRail 原样搬来。 */
export function SessionActions(props: { onCopyTranscript: () => void; canCopy: boolean }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <RailAction
      label={copied ? "Transcript copied" : "Copy transcript"}
      disabled={!props.canCopy}
      onClick={() => {
        props.onCopyTranscript();
        setCopied(true);
      }}
    >
      {/* 复制成功用图标换字形，不用颜色——颜色是第二信号 */}
      <Icon name={copied ? "check" : "copy"} size={16} />
    </RailAction>
  );
}

/** 会话动作的 26px 方块（与顶部入口同规格，但永不点亮——它们不是开关）。 */
function RailAction(props: {
  label: string;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const disabled = props.disabled === true;
  return (
    <button
      type="button"
      title={props.label}
      disabled={disabled}
      onClick={props.onClick}
      style={{
        width: 26,
        height: 26,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-sm)",
        background: "transparent",
        // 玻璃上禁用不用 opacity：调暗的字在半透明面上既不是墨也不是壁纸，改用实色 tertiary
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
