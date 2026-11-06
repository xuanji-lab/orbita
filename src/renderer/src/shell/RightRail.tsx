import { Fragment, useRef, useState, type ComponentProps } from "react";
import { Icon, type IconName } from "./Icon";
import { Menu, type MenuItem } from "./Menu";
import { useT } from "../locale.ts";
import { layoutRail, withGroupRules, type RailPlacement } from "./rail-groups.ts";
import { FEATURE_ICON } from "./feature-icons.ts";
import { CompletionCard } from "../features/notify/CompletionCard";
import { BellCard, useBellDismiss, type NoticeRow } from "../features/notify/BellCard";

/**
 * 右图标条，32px，**常驻**（首页也可达）。与左栏同款「无自己的面」：直接坐在
 * layer 1 上。wafo 2026-09-12 裁定保持 32px 不加宽到 48——「左右对称」不取字面
 * 同宽，只保留「都是无面的窄条」。
 *
 * **入口按类分组**（2026-10-31 用户裁决，原话：「会对右栏进行分类……每一类之间没有分隔，
 * 但是类和类之间有一个小横线做分隔」「全部都在右上，然后右下就简单一点」）：
 * 组的划分与理由见 `rail-groups.ts`，规矩见设计系统 readme「Rail entries are grouped」。
 * 右上堆前四组（这条会话 / 工作面 / 智能体 / 收纳），右下只留「应用」组（设置、通知）。
 * 此前是「上面一串、下面一串」，两串之间靠弹性空隙隔开，入口归哪串凭历史而不凭类。
 *
 * 面板类入口（文件 / 审查 / 这条任务 / 能力 / 终端 / 意图 / 子会话）**共用一个面板位**
 * （2026-09-12 裁决）：同一时刻至多点亮一个，再点已点亮的 = 收起。点亮 = 单层
 * `--glass-bg` + `--shadow-composer`：图标与面板都是 layer 1 的子级，各自的
 * 背景都在 layer 1 之上再叠一层 .60，合成同色——所以用同一个单层 token 就
 * 天然与面板融合，不需要手调第二层值（规格 §1.1）。32px 条里 26px 的方块用
 * `--radius-sm`（md 太圆）。点亮与开关由 App 按模式算好传入。
 *
 * 应用入口（Archived / Carryovers / Memory / Settings / 浏览器）由 App 组装成 `railEntries`
 * 传入，**首页常驻**——它们是应用入口不是会话动作，不随会话消失（wafo 2026-09-22 裁决，
 * 覆盖 2026-09-12「底部只放会话动作」：复制转录已并入会话行的「导出」，右栏不再挂会话动作）。
 *
 * 子会话入口（子会话 PR4c）：与 Files/Skills/MCP/辅助对话共用同一个面板位（互斥），
 * 只在主槽正看着一条**有子会话的根会话**时出现——入口数据（要不要出现、N 是多少、
 * 「在等你」几个）由 App 传入，本组件不自己算。面板删除后（2026-10-12）这里是父子沟通的
 * 唯一面板位：收件箱。
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
  | "context"
  | "automation"
  /** 插件页的右栏单列版（实验功能 plugins）；全屏版是设置页的「插件」页签 */
  | "plugins";

/**
 * App 传给右栏的应用级入口（右栏上其余入口由面板状态推出，不走这里）。
 * 它们在条上的分组与精简态去留不由调用方定，由 RightRail 按 id 登记（见本文件的 `items`）。
 */
export interface RailEntry {
  id: "carryovers" | "archived" | "browser" | "memory" | "board" | "settings";
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
   * 精简右栏（实验功能 lean-rail，2026-10-30）：常驻只留「这条任务」、文件、终端、内置浏览器
   * （子会话有就露）和设置，其余收进右下的「更多」。文件常驻是 2026-10-31 用户的裁决
   * （「文件面板不应该被收纳」）；条上与「更多」里都沿用常规态的分组，组间一条线。
   */
  lean: boolean;
  /** 「更多 › 上下文」：直接落在「这条任务」的上下文页签（与输入框旁用量环同一条路） */
  onOpenContext: () => void;
  /** 应用级入口（遗留 / 归档 / 浏览器 / 记忆 / 设置），调用方组装；条上的组与顺序由 RightRail 定，与数组顺序无关 */
  railEntries: RailEntry[];
  /**
   * Sub-sessions 面板入口（子会话 PR4c）：null = 不出现（没在看根会话，或这条
   * 根会话没有子会话）。与 `panel` 共用互斥语义，走 `onPanel` 同一条切换逻辑。
   * `waiting` 是「在等你」（question + 待审批）的子会话数：右上角角标，为 0 不显示。
   * **入口不自己弹开**（2026-10-12 用户裁决）：需要你看的事用角标说话，不抢面板位。
   */
  /** 意图面板入口（实验功能 intent-system）：null = 不出现（实验开关关着） */
  intentAvailable: boolean;
  /**
   * 自动化面板入口（实验功能 automation）：null = 不出现（开关关着）；running 是正在跑的自动化数，
   * 角标只在有运行时出现（没有「未读」这类计数——自动化的结果在面板里那条任务下面看）。
   * 归「智能体」组、精简态收进「更多」（菜单项的文案带运行数）。
   */
  automation: { running: number } | null;
  /**
   * 插件入口（实验功能 plugins）：false = 不出现（开关关着）。与 Files 等共用右栏面板位（走 `onPanel`，
   * 互斥、再点收起）；想要全屏版去设置里的「插件」页签。
   */
  pluginsAvailable: boolean;
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
  /** App 传入的入口 → 右栏条目（没传 = 对应功能没开，不出现） */
  const fromApp = (id: RailEntry["id"], place: RailPlacement): RailItem[] => {
    const found = entry(id);
    return found === undefined
      ? []
      : [{ id, ...place, icon: found.icon, label: found.label, lit: found.lit, onSelect: found.onClick }];
  };
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

  // 全部入口，**组内顺序即数组顺序**（常规态的堆叠顺序，也是精简态「更多」里的行序）。
  // 分组的理由见 rail-groups.ts；pinned = 精简态常驻在条上
  const items: RailItem[] = [
    // 这条会话在做什么、做过什么、脑子里装了什么
    { id: "context", group: "session", pinned: true, icon: FEATURE_ICON.task, label: t.rail.context, lit: props.panel === "context", onSelect: toggle("context") },
    { id: "review", group: "session", pinned: false, icon: FEATURE_ICON.review, label: t.rail.review, lit: props.panel === "review", onSelect: toggle("review") },
    // 文件跟审查、会话放一组（用户 2026-11-05）；精简态也常驻（用户 2026-10-31：文件面板不应该被收纳）
    { id: "files", group: "session", pinned: true, icon: FEATURE_ICON.files, label: t.rail.files, lit: props.panel === "files", onSelect: toggle("files") },
    // 「更多 › 上下文」：直接落在「这条任务」的上下文页签（与输入框旁用量环同一条路）；常规态条上没有它
    { id: "context-tab", group: "session", pinned: false, moreOnly: true, icon: "layers", label: t.taskPanel.tabContext, lit: false, onSelect: props.onOpenContext },
    ...(props.subSessions === null
      ? []
      : [
          {
            id: "subsessions",
            group: "session" as const,
            pinned: true,
            icon: FEATURE_ICON.subsessions,
            label: t.rail.subSessions(props.subSessions.count),
            lit: props.panel === "subsessions",
            onSelect: toggle("subsessions"),
            badge: props.subSessions.waiting,
          },
        ]),
    // 终端（人工验收自己的开发）：收起面板不杀 PTY
    { id: "terminal", group: "agent", pinned: true, icon: FEATURE_ICON.terminal, label: t.rail.terminal, lit: props.panel === "terminal", onSelect: toggle("terminal") },
    ...fromApp("browser", { group: "agent", pinned: true }),
    // 智能体会什么、记得什么。能力：Skills 与 MCP 服务一张列表，页签在面板里（上次停在哪个页签由面板自己记）
    // 插件页已把技能与 MCP 当插件显示：plugins 开着时不再单列这个入口
    ...(props.pluginsAvailable
      ? []
      : [{ id: "abilities", group: "agent" as const, pinned: false, icon: FEATURE_ICON.abilities, label: t.rail.abilities, lit: props.panel === "abilities", onSelect: toggle("abilities") }]),
    ...(props.pluginsAvailable
      ? [{ id: "plugins", group: "agent" as const, pinned: true, icon: FEATURE_ICON.plugins, label: t.rail.plugins, lit: props.panel === "plugins", onSelect: toggle("plugins") }]
      : []),
    ...fromApp("memory", { group: "agent", pinned: false }),
    ...(props.intentAvailable
      ? [
          {
            id: "intent",
            group: "agent" as const,
            pinned: false,
            icon: FEATURE_ICON.intent,
            label: t.rail.intent,
            lit: props.panel === "intent",
            onSelect: toggle("intent"),
          },
        ]
      : []),
    ...(props.automation === null
      ? []
      : [
          {
            id: "automation",
            group: "agent" as const,
            pinned: false,
            icon: FEATURE_ICON.automation,
            label: t.automation.railLabel(props.automation.running),
            lit: props.panel === "automation",
            onSelect: toggle("automation"),
            badge: props.automation.running,
          },
        ]),
    // 收起来以后再看的
    ...fromApp("carryovers", { group: "shelf", pinned: false }),
    ...fromApp("archived", { group: "shelf", pinned: false }),
    // 应用级：看板（实验功能 plugins）、设置、通知。铃铛在右下角最底：它是常驻的状态入口，位置稳才扫得到
    ...fromApp("board", { group: "app", pinned: false }),
    ...fromApp("settings", { group: "app", pinned: true }),
    { id: "bell", group: "app", pinned: false, icon: FEATURE_ICON.bell, label: t.rail.bell(props.bell.count), lit: bellOpen, onSelect: openBell, badge: props.bell.count },
  ];
  const layout = layoutRail(items, props.lean);
  const renderItem = (item: RailItem) => {
    const button = (
      <RailEntryButton
        key={item.id}
        icon={item.icon}
        {...(item.glyph === undefined ? {} : { glyph: item.glyph })}
        label={item.label}
        lit={item.lit}
        onClick={item.onSelect}
        badge={item.badge}
      />
    );
    // 铃铛的清单从它自己（常规态）或「更多」（精简态）弹出，外部点击判定要排除这个锚点
    return item.id === "bell" ? (
      <span key={item.id} ref={setBellAnchor} style={{ display: "inline-flex" }}>
        {button}
      </span>
    ) : (
      button
    );
  };
  const moreItems = layout.more.flatMap((part) => part.items);
  // 「更多」菜单：与条上同一套组序，组间一条分隔线。菜单不画点亮（点亮只用来让「更多」键自己亮）
  const moreMenu = withGroupRules<MenuItem, MenuItem>(
    layout.more.map((part) => ({
      group: part.group,
      items: part.items.map((item) => ({ id: item.id, label: item.label, icon: item.icon, onSelect: item.onSelect })),
    })),
    (before) => ({ id: `rule:${before}`, label: "", rule: true }),
  );

  return (
    <aside className="right-rail" data-lean={props.lean ? "" : undefined}>
      <div className="rail-stack">
        {layout.stack.map((part, index) => (
          <Fragment key={part.group}>
            {/* 组间一条细线；组内没有分隔。线是装饰，组的语义由 group 的标签给读屏 */}
            {index > 0 && <span className="rail-sep" aria-hidden="true" />}
            <div className="rail-group" role="group" aria-label={t.rail.groups[part.group]}>
              {part.items.map(renderItem)}
            </div>
          </Fragment>
        ))}
      </div>
      <span className="rail-spacer" />
      <div className="rail-group" role="group" aria-label={t.rail.groups.app}>
        {props.lean && moreItems.length > 0 && (
          // 「更多」也是通知清单的锚点：清单从菜单里打开，外部点击判定排除这颗键
          <span ref={setBellAnchor} style={{ display: "inline-flex" }}>
            <Menu
              items={moreMenu}
              placement="above"
              align="end"
              panelMinWidth={200}
              trigger={({ open, toggle: toggleMenu }) => (
                <RailEntryButton
                  icon="ellipsis-vertical"
                  label={t.common.more}
                  lit={open || moreItems.some((item) => item.lit)}
                  onClick={toggleMenu}
                />
              )}
            />
          </span>
        )}
        {layout.dock.map(renderItem)}
      </div>
      {bellCard}
    </aside>
  );
}

/** 右栏上的一个入口：排布信息（RailPlacement）+ 条上画它所需要的图标、文案与点法 */
interface RailItem extends RailPlacement {
  id: string;
  icon: IconName;
  /** 有它就画首字代替图标（插件面板页签）；「更多」菜单里仍用 icon */
  glyph?: string;
  /** tooltip 与读屏共用这一句 */
  label: string;
  lit: boolean;
  onSelect: () => void;
  /** 角标（铃铛未读 / 子会话在等你）；缺席或 0 不渲染 */
  badge?: number;
}

/**
 * 28px 入口方块（控件台阶 24·28·32）：右栏所有入口**同规格同点亮配方**——点亮走
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
