import { useRef, useState, type ComponentProps } from "react";
import { Icon, type IconName } from "./Icon";
import { Menu, type MenuItem } from "./Menu";
import { useT } from "../locale.ts";
import { CompletionCard } from "../features/notify/CompletionCard";
import { BellCard, useBellDismiss, type NoticeRow } from "../features/notify/BellCard";

/**
 * 右图标条，32px，**常驻**（首页也可达）。与左栏同款「无自己的面」：直接坐在
 * layer 1 上。wafo 2026-09-12 裁定保持 32px 不加宽到 48——「左右对称」不取字面
 * 同宽，只保留「都是无面的窄条」。
 *
 * 顶部：几个入口（文件 / 审查 / 这条任务 / 能力 / 终端…），**共用一个面板位**（2026-09-12 裁决）：
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
  /** 能力：Skills 与 MCP 服务一张列表（2026-10-30 合并，原先是 "skills" | "mcp" 两个面板） */
  | "abilities"
  | "terminal"
  | "drawer"
  | "subsessions"
  | "intent"
  | "context";

/** 右栏的一个入口：顶部三入口与底部应用入口共用这一个 26px 方块规格 */
export interface RailEntry {
  /** 精简右栏按它分拣：哪些常驻、哪些收进「更多」 */
  id: "carryovers" | "archived" | "browser" | "memory" | "settings";
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
  /**
   * 精简右栏（实验功能 lean-rail，2026-10-30）：常驻只留「这条任务」、终端、内置浏览器
   * （文件面板开着时它也露出来，子会话有就露），其余收进底部的「更多」。
   */
  lean: boolean;
  /** 「更多 › 上下文」：直接落在「这条任务」的上下文页签（与输入框旁用量环同一条路） */
  onOpenContext: () => void;
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
   * （绿 + 红两档，角标只数它）；entries 是所有状态饼亮着的根会话（等你 > 未读 >
   * 在跑，新在前），点行在主槽打开那条会话。状态与侧栏状态饼同一份推导（App 算好）。
   */
  bell: {
    count: number;
    entries: readonly NoticeRow[];
    onOpen: (id: string) => void;
    /** 在辅助对话里打开（主槽不动） */
    onSideChat: (id: string) => void;
    onMarkAllRead: () => void;
    /** 清单被打开（记面板打开次数用） */
    onOpened: () => void;
  };
}) {
  const t = useT();
  // 铃铛锚点（外部关闭判定要排除它）+ 弹层开关；开关在本体（右栏不重建），不随内容变
  const [bellOpen, setBellOpen] = useState(false);
  const [bellAnchor, setBellAnchor] = useState<HTMLSpanElement | null>(null);
  const bellCardRef = useRef<HTMLDivElement | null>(null);
  useBellDismiss(bellOpen, () => setBellOpen(false), bellAnchor, bellCardRef);
  const openBell = (): void => {
    if (!bellOpen) props.bell.onOpened();
    setBellOpen(!bellOpen);
  };
  const toggle = (kind: RightPanelKind) => () => props.onPanel(props.panel === kind ? null : kind);
  const entry = (id: RailEntry["id"]): RailEntry | undefined => props.railEntries.find((each) => each.id === id);
  const bellCard = bellOpen && (
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
  );
  const subSessionsEntry = props.subSessions !== null && (
    <RailEntryButton
      icon="git-fork"
      label={t.rail.subSessions(props.subSessions.count)}
      lit={props.panel === "subsessions"}
      onClick={toggle("subsessions")}
      badge={props.subSessions.waiting}
    />
  );

  if (props.lean) {
    const browser = entry("browser");
    const settings = entry("settings");
    // 收进「更多」的：各自的点法与原来的入口一样（面板仍是开 / 关切换，子视图仍是互斥开关）
    const folded: (MenuItem & { lit: boolean })[] = [
      { id: "review", label: t.rail.review, icon: "file-diff", lit: props.panel === "review", onSelect: toggle("review") },
      { id: "context", label: t.taskPanel.tabContext, icon: "layers", lit: false, onSelect: props.onOpenContext },
      { id: "files", label: t.rail.files, icon: "folder", lit: props.panel === "files", onSelect: toggle("files") },
      { id: "abilities", label: t.rail.abilities, icon: "book-open", lit: props.panel === "abilities", onSelect: toggle("abilities") },
      ...(["memory", "carryovers", "archived"] as const).flatMap((id) => {
        const found = entry(id);
        return found === undefined
          ? []
          : [{ id, label: found.label, icon: found.icon, lit: found.lit, onSelect: found.onClick }];
      }),
      ...(props.intentAvailable
        ? [{ id: "intent", label: t.rail.intent, icon: "waypoints" as const, lit: props.panel === "intent", onSelect: toggle("intent") }]
        : []),
      { id: "bell", label: t.rail.bell(props.bell.count), icon: "bell", lit: bellOpen, onSelect: openBell },
    ];
    const foldedLit = folded.some((item) => item.lit);
    return (
      <aside className="right-rail" data-lean="">
        <RailEntryButton icon="list-todo" label={t.rail.context} lit={props.panel === "context"} onClick={toggle("context")} />
        <RailEntryButton icon="square-terminal" label={t.rail.terminal} lit={props.panel === "terminal"} onClick={toggle("terminal")} />
        {browser !== undefined && (
          <RailEntryButton icon={browser.icon} label={browser.label} lit={browser.lit} onClick={browser.onClick} />
        )}
        {/* 文件面板只在开着时露面：从链接 / 引用 / 左栏双击打开预览时有个地方关它 */}
        {props.panel === "files" && (
          <RailEntryButton icon="folder" label={t.rail.files} lit onClick={toggle("files")} />
        )}
        {subSessionsEntry}
        <span style={{ flex: 1 }} />
        {/* 「更多」也是通知清单的锚点：清单从菜单里打开，外部点击判定排除这颗键 */}
        <span ref={setBellAnchor} style={{ display: "inline-flex" }}>
          <Menu
            items={folded.map(({ lit: _lit, ...item }) => item)}
            placement="above"
            align="end"
            panelMinWidth={200}
            trigger={({ open, toggle: toggleMenu }) => (
              <RailEntryButton icon="ellipsis-vertical" label={t.common.more} lit={open || foldedLit} onClick={toggleMenu} />
            )}
          />
        </span>
        {settings !== undefined && (
          <RailEntryButton icon={settings.icon} label={settings.label} lit={settings.lit} onClick={settings.onClick} />
        )}
        {bellCard}
      </aside>
    );
  }

  return (
    <aside className="right-rail">
      <RailEntryButton icon="folder" label={t.rail.files} lit={props.panel === "files"} onClick={toggle("files")} />
      <RailEntryButton icon="file-diff" label={t.rail.review} lit={props.panel === "review"} onClick={toggle("review")} />
      {/* 这条任务（进度 + 上下文，2026-10-30）：它在做什么、做过什么、脑子里装了什么。紧跟审查——两者都是「看这条会话」 */}
      <RailEntryButton icon="list-todo" label={t.rail.context} lit={props.panel === "context"} onClick={toggle("context")} />
      {/* 能力（2026-10-30）：Skills 与 MCP 服务一张列表，页签在面板里（上次停在哪个页签由面板自己记） */}
      <RailEntryButton icon="book-open" label={t.rail.abilities} lit={props.panel === "abilities"} onClick={toggle("abilities")} />
      {/* 终端（人工验收自己的开发）：与 Files 等共用面板位，收起面板不杀 PTY */}
      <RailEntryButton icon="square-terminal" label={t.rail.terminal} lit={props.panel === "terminal"} onClick={toggle("terminal")} />
      {props.intentAvailable && (
        <RailEntryButton icon="waypoints" label={t.rail.intent} lit={props.panel === "intent"} onClick={toggle("intent")} />
      )}
      {subSessionsEntry}
      <span style={{ flex: 1 }} />
      {props.railEntries.map((each) => (
        <RailEntryButton key={each.id} icon={each.icon} label={each.label} lit={each.lit} onClick={each.onClick} />
      ))}
      {/* 铃铛在入口组最底（右下角）：它是常驻的状态入口，位置稳才扫得到 */}
      <span ref={setBellAnchor} style={{ display: "inline-flex" }}>
        <RailEntryButton icon="bell" label={t.rail.bell(props.bell.count)} lit={bellOpen} onClick={openBell} badge={props.bell.count} />
      </span>
      {bellCard}
    </aside>
  );
}

/**
 * 26px 入口方块：顶部三入口与底部应用入口**同规格同点亮配方**——点亮走
 * `.quiet-control[aria-pressed]` 的 mode 选中底（浅蓝 / 暗档黄，2026-10-19
 * 方案 B v2 用户点名保留；此前是 inline 的 `--glass-bg` 玻璃白，看不出选中）。
 * hover 也交给 CSS（quiet-control:hover），不再用 JS 模拟。再点已点亮的由
 * 调用方表达成收起。badge（铃铛的未读角标）常驻在右上角，0 / 缺席不渲染。
 */
function RailEntryButton(props: {
  icon: IconName;
  label: string;
  lit: boolean;
  onClick: () => void;
  /** 未读角标；缺席或 0 不渲染 */
  badge?: number;
}) {
  return (
    <button
      type="button"
      className="quiet-control"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.lit}
      onClick={props.onClick}
      style={{
        width: 28, // 控件台阶 24·28·32（control-scale.ts）
        height: 28,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "pointer",
        borderRadius: "var(--radius-sm)",
        // 角标的定位基准
        position: "relative",
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
