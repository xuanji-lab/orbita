import { useRef, useState, type ComponentProps } from "react";
import { Icon, type IconName } from "./Icon";
import { useT } from "../locale.ts";
import { CompletionCard } from "../features/notify/CompletionCard";
import { BellCard, useBellDismiss, type NoticeRow } from "../features/notify/BellCard";

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
 * `--radius-sm`（md 太圆）。点亮与开关由 App 按模式算好传入。
 *
 * 底部：应用入口（Archived / Carryovers / Settings），**首页常驻**——它们是
 * 应用入口不是会话动作，不随会话消失（wafo 2026-09-22 裁决，覆盖 2026-09-12
 * 「底部只放会话动作」：复制转录已并入会话行的「导出」，右栏不再挂会话动作）。
 * 中间用弹性空隙隔开两组的语义。
 *
 * 顶部第五个入口 Sub-sessions（子会话 PR4c）：与 Files/Skills/MCP/辅助对话
 * 共用同一个面板位（互斥），只在主槽正看着一条**有子会话的根会话**时出现——
 * 入口数据（要不要出现、N 是多少、「在等你」几个）由 App 传入，本组件不自己算。
 * 面板删除后（2026-10-12）这里是父子沟通的唯一面板位：收件箱。
 */

/** 右栏面板位里放什么（"channels" 随父子会话面板一起删除：沟通回到两边对话流，子会话面板变收件箱） */
export type RightPanelKind =
  | "files"
  | "review"
  | "skills"
  | "mcp"
  | "terminal"
  | "drawer"
  | "subsessions"
  | "intent";

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
  /**
   * Sub-sessions 面板入口（子会话 PR4c）：null = 不出现（没在看根会话，或这条
   * 根会话没有子会话）。与 `panel` 共用互斥语义，走 `onPanel` 同一条切换逻辑。
   * `waiting` 是「在等你」（question + 待审批）的子会话数：右上角角标，为 0 不显示。
   * **入口不自己弹开**（2026-10-12 用户裁决）：需要你看的事用角标说话，不抢面板位。
   */
  /** 意图面板入口（实验功能 intent-system）：null = 不出现（实验开关关着） */
  intentAvailable: boolean;
  subSessions: { count: number; waiting: number } | null;
  /**
   * 后台会话跑完的提醒卡（2026-10-10）：弹在主槽右上角。null = 没有提醒。
   */
  completionNotice: Omit<ComponentProps<typeof CompletionCard>, "host"> | null;
  /**
   * 两张卡的弹出宿主：主槽（`.pane-main`）里的 `.pane-pop-host`，App 挂好传进来。
   * 卡片的开关与数据跟着入口住在右栏，渲染位置在主槽——层级属于内容面，不骑在
   * 右栏与内容面之间（用户 2026-10-10 第三轮）。
   */
  popHost: HTMLElement | null;
  /**
   * 右下角铃铛（2026-10-10 二轮）：未读清单的第二个入口。常驻；count 是未读数
   * （绿 + 红两档，角标只数它）；entries 是所有竖条亮着的根会话（等你 > 未读 >
   * 在跑，新在前），点行在主槽打开那条会话。状态与侧栏竖条同一份推导（App 算好）。
   */
  bell: {
    count: number;
    entries: readonly NoticeRow[];
    onOpen: (id: string) => void;
    /** 在辅助对话里打开（主槽不动） */
    onSideChat: (id: string) => void;
    onMarkAllRead: () => void;
  };
}) {
  const t = useT();
  // 铃铛锚点（外部关闭判定要排除它）+ 弹层开关；开关在本体（右栏不重建），不随内容变
  const [bellOpen, setBellOpen] = useState(false);
  const [bellAnchor, setBellAnchor] = useState<HTMLSpanElement | null>(null);
  const bellCardRef = useRef<HTMLDivElement | null>(null);
  useBellDismiss(bellOpen, () => setBellOpen(false), bellAnchor, bellCardRef);
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
        // 顶行与侧栏字标行同一条中心线（顶行坐到卡顶，行高 --titlebar-row），
        // 第一个入口与左侧折叠图标对齐——两边都钉在红绿灯中心那条线上
        padding: "0 0 var(--space-2)",
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
          height: "var(--titlebar-row)",
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
          label={t.rail.files}
          lit={props.panel === "files"}
          onClick={() => props.onPanel(props.panel === "files" ? null : "files")}
        />
      </span>
      <RailEntryButton
        icon="file-diff"
        label={t.rail.review}
        lit={props.panel === "review"}
        onClick={() => props.onPanel(props.panel === "review" ? null : "review")}
      />
      <RailEntryButton
        icon="book-open"
        label={t.rail.skills}
        lit={props.panel === "skills"}
        onClick={() => props.onPanel(props.panel === "skills" ? null : "skills")}
      />
      <RailEntryButton
        icon="plug"
        label={t.rail.mcp}
        lit={props.panel === "mcp"}
        onClick={() => props.onPanel(props.panel === "mcp" ? null : "mcp")}
      />
      {/* 终端（人工验收自己的开发）：与 Files 等共用面板位，收起面板不杀 PTY */}
      <RailEntryButton
        icon="square-terminal"
        label={t.rail.terminal}
        lit={props.panel === "terminal"}
        onClick={() => props.onPanel(props.panel === "terminal" ? null : "terminal")}
      />
      <RailEntryButton
        icon="panel-right"
        label={t.rail.sideChat}
        lit={props.panel === "drawer"}
        onClick={() => props.onPanel(props.panel === "drawer" ? null : "drawer")}
      />
      {props.intentAvailable && (
        <RailEntryButton
          icon="waypoints"
          label={t.rail.intent}
          lit={props.panel === "intent"}
          onClick={() => props.onPanel(props.panel === "intent" ? null : "intent")}
        />
      )}
      {props.subSessions !== null && (
        <RailEntryButton
          icon="git-fork"
          label={t.rail.subSessions(props.subSessions.count)}
          lit={props.panel === "subsessions"}
          onClick={() => props.onPanel(props.panel === "subsessions" ? null : "subsessions")}
          badge={props.subSessions.waiting}
        />
      )}
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
      {/* 铃铛在入口组最底（右下角）：它是常驻的状态入口，位置稳才扫得到 */}
      <span ref={setBellAnchor} style={{ display: "inline-flex" }}>
        <RailEntryButton
          icon="bell"
          label={t.rail.bell(props.bell.count)}
          lit={bellOpen}
          onClick={() => setBellOpen((open) => !open)}
          badge={props.bell.count}
        />
      </span>
      {bellOpen && (
        <BellCard
          host={props.popHost}
          cardRef={bellCardRef}
          entries={props.bell.entries}
          onOpen={(id) => {
            setBellOpen(false);
            props.bell.onOpen(id);
          }}
          onSideChat={(id) => {
            setBellOpen(false);
            props.bell.onSideChat(id);
          }}
          onMarkAllRead={props.bell.count > 0 ? props.bell.onMarkAllRead : null}
        />
      )}
    </aside>
  );
}

/**
 * 26px 入口方块：顶部三入口与底部应用入口**同规格同点亮配方**——点亮 =
 * `--glass-bg` + `--shadow-composer`（与面板融合的单层 token，见头注释），
 * 再点已点亮的由调用方表达成收起。badge（铃铛的未读角标）常驻在右上角，
 * 0 / 缺席不渲染。
 */
function RailEntryButton(props: {
  icon: IconName;
  label: string;
  lit: boolean;
  onClick: () => void;
  /** 未读角标；缺席或 0 不渲染 */
  badge?: number;
}) {
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
        // 角标的定位基准
        position: "relative",
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
      {props.badge !== undefined && props.badge > 0 && (
        <span className="rail-badge" aria-hidden="true">
          {props.badge > 99 ? "99+" : props.badge}
        </span>
      )}
    </button>
  );
}
