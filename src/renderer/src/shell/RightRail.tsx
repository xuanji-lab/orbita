import { Icon, type IconName } from "./Icon";

/**
 * 右图标条，32px，**常驻**（首页也可达）。与左栏同款「无自己的面」：直接坐在
 * layer 1 上。wafo 2026-09-12 裁定保持 32px 不加宽到 48——「左右对称」不取字面
 * 同宽，只保留「都是无面的窄条」。
 *
 * 顶部：四个入口（Files / Skills / MCP / 辅助对话），**共用一个面板位**（2026-09-12 裁决）：
 * 同一时刻至多点亮一个，再点已点亮的 = 收起。点亮 = 单层
 * `--glass-bg` + `--shadow-composer`：图标与面板都是 layer 1 的子级，各自的
 * 背景都在 layer 1 之上再叠一层 .60，合成同色——所以用同一个单层 token 就
 * 天然与面板融合，不需要手调第二层值（规格 §1.1）。32px 条里 26px 的方块用
 * `--radius-sm`（md 太圆）。
 *
 * 底部：应用入口（Archived / Carryovers / Settings），**首页常驻**——它们是
 * 应用入口不是会话动作，不随会话消失（wafo 2026-09-22 裁决，覆盖 2026-09-12
 * 「底部只放会话动作」：复制转录已并入会话行的「导出」，右栏不再挂会话动作）。
 * 中间用弹性空隙隔开两组的语义。
 */

export type RightPanelKind = "files" | "skills" | "mcp" | "drawer";

/** 右栏的一个入口：顶部三入口与底部应用入口共用这一个 26px 方块规格 */
export interface RailEntry {
  icon: IconName;
  /** tooltip 与读屏共用这一句 */
  label: string;
  /** 对应视图开着时点亮（aria-pressed） */
  lit: boolean;
  onClick: () => void;
}

export function RightRail(props: {
  panel: RightPanelKind | null;
  onPanel: (next: RightPanelKind | null) => void;
  /** 底部应用入口组（Carryovers / Archived / Settings），调用方组装；顺序即堆叠顺序 */
  railEntries: RailEntry[];
}) {
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
      {/* 顶部这行兼作拖拽区（.titlebar）；行内住 Files 入口，与左侧折叠图标同行同高
          （2026-09-22 文件面板加入：顶行让给最常用的 Files，Skills 顺延一格）。
          paddingInlineStart: 0——豁免 darwin 给 .titlebar 统一加的 66px 红绿灯净空：
          红绿灯在窗口左上，这条 32px 窄条在最右，让净空会把 icon 推出可视区外
          （overflow:hidden，A-0 复验 BUG-3）。 */}
      <span
        className="titlebar"
        style={{
          height: 34,
          width: "100%",
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          paddingInlineStart: 0,
        }}
      >
        <RailEntryButton
          icon="folder"
          label="Files"
          lit={props.panel === "files"}
          onClick={() => props.onPanel(props.panel === "files" ? null : "files")}
        />
      </span>
      <RailEntryButton
        icon="book-open"
        label="Skills"
        lit={props.panel === "skills"}
        onClick={() => props.onPanel(props.panel === "skills" ? null : "skills")}
      />
      <RailEntryButton
        icon="plug"
        label="MCP servers"
        lit={props.panel === "mcp"}
        onClick={() => props.onPanel(props.panel === "mcp" ? null : "mcp")}
      />
      <RailEntryButton
        icon="panel-right"
        label="辅助对话 Ctrl+Alt+D"
        lit={props.panel === "drawer"}
        onClick={() => props.onPanel(props.panel === "drawer" ? null : "drawer")}
      />
      <span style={{ flex: 1 }} />
      {props.railEntries.map((entry) => (
        <RailEntryButton
          key={entry.label}
          icon={entry.icon}
          label={entry.label}
          lit={entry.lit}
          onClick={entry.onClick}
        />
      ))}
    </aside>
  );
}

/**
 * 26px 入口方块：顶部三入口与底部应用入口**同规格同点亮配方**——点亮 =
 * `--glass-bg` + `--shadow-composer`（与面板融合的单层 token，见头注释），
 * 再点已点亮的由调用方表达成收起。
 */
function RailEntryButton(props: { icon: IconName; label: string; lit: boolean; onClick: () => void }) {
  const lit = props.lit;
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      aria-pressed={lit}
      onClick={props.onClick}
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
      <Icon name={props.icon} size={16} />
    </button>
  );
}
