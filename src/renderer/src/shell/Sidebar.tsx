import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { Chip } from "./Chip";
import { InlineName } from "./InlineName";
import { Menu, type MenuItem } from "./Menu";
import { api } from "../api";
import type { ChatSession } from "../features/chat/useChatSession";
import { childSessions, isSessionDone, rootSessions, type Carryover, type SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "@shared/settings";
import { SETTINGS_TABS, type SettingsTab } from "../features/settings/SettingsView";
import { describeList } from "../features/chat/load-state.ts";
import { shouldExitSubview } from "./subview-exit.ts";
import { nextCompletion } from "./completion-mark.ts";
import { rowStatusIcon } from "./row-status.ts";
import { nextFilterRowMode } from "./filter-row-compact.ts";
import { canResumeInSource } from "../features/chat/carryover-resume.ts";
import {
  SESSIONS_PREVIEW_LIMIT,
  TASKS_FOLD_KEY,
  foldKeyForWorkspace,
  toggleGroupFold,
  toggleGroupFull,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";
import { useT } from "../locale.ts";
import type { Messages } from "../messages-en.ts";

/** 中卡盖着的面。`null` = 聊天。三者互斥，所以是联合类型而不是几个 boolean。 */
export type Overlay = "settings" | null;

/** 窗口窄于这条线就自动折成图标条：288px 的侧栏在 960px 以下会把内容面挤得太瘦。 */
const COLLAPSE_BREAKPOINT = 960;

/**
 * 闲置建议线：open 且未归档、最后一次活动超过这个天数的会话，行内轻提示
 * 「Mark done?」。**纯派生不落盘**——建议只是当下的一句提醒，不是会话状态；
 * 每次渲染按 updatedAt 现算，不弹通知、不加角标，hover 才出现。
 */
const IDLE_SUGGEST_DAYS = 7;
const IDLE_SUGGEST_MS = IDLE_SUGGEST_DAYS * 24 * 60 * 60 * 1000;

/** 完成状态筛选的单选组三档：全部 / 进行中 / 已完成（Starred 是叠加开关，正交） */
type StatusFilter = "all" | "active" | "done";

/**
 * 会话的未办遗留数（角标、Has todos 筛选共一口径）：按 sourceSessionId 现算。
 * 抽出来是因为两个消费者（行内角标 / 筛选管线）用同一个「还有几件没办」的判定，
 * 各写一份迟早漂移。
 */
function openTodoCount(carryovers: readonly Carryover[], sessionId: string): number {
  return carryovers.filter((item) => item.sourceSessionId === sessionId && item.status === "open").length;
}

/**
 * 遗留事项面板的分组：按来源会话归堆，组序跟会话列表（最近的在前）；
 * 来源会话已删的堆到最后（标题换占位，跳转不可用）。
 */
function groupCarryovers(
  carryovers: readonly Carryover[],
  sessions: readonly SessionMeta[],
): { session: SessionMeta | null; items: Carryover[] }[] {
  const bySource = new Map<string, Carryover[]>();
  for (const item of carryovers) {
    const list = bySource.get(item.sourceSessionId) ?? [];
    list.push(item);
    bySource.set(item.sourceSessionId, list);
  }
  const groups: { session: SessionMeta | null; items: Carryover[] }[] = [];
  for (const meta of sessions) {
    const items = bySource.get(meta.id);
    if (items !== undefined) groups.push({ session: meta, items });
  }
  for (const [source, items] of bySource) {
    if (sessions.some((meta) => meta.id === source)) continue;
    groups.push({ session: null, items });
  }
  return groups;
}

/**
 * 筛选扑空的空态文案：按激活的组合说清「为什么什么都没有、怎么才有」，
 * 不给一条对不上当前筛选的提示。
 */
function filterEmptyText(
  status: StatusFilter,
  starredOnly: boolean,
  hasTodosOnly: boolean,
  t: Messages,
): string {
  if (hasTodosOnly) return t.sidebar.emptyHasTodos;
  if (status === "active") return starredOnly ? t.sidebar.emptyActiveStarred : t.sidebar.emptyActive;
  if (status === "done") return starredOnly ? t.sidebar.emptyDoneStarred : t.sidebar.emptyDone;
  return t.sidebar.emptyStarred;
}

/**
 * 左栏，默认 288px，**可拖宽**（240–400，双击回 288）。**它自己没有面**——不填色、不描边、不分割线，直接坐在 layer 1 上，
 * 结构完全由中卡的边缘给出（设计系统 *Layout*：both sidebars are unbounded）。
 *
 * 只列真实存在的东西：本分支还没有会话存储，所以「会话列表」目前最多一条——
 * 就是当前这个 session。**不铺假数据**；没做的（编排、归档）按设计系统的
 * 规矩「显示、禁用、标注 planned」，不藏也不假装。
 *
 * 进设置时**换的是这块列表，不是弹一个窗**：tab 列表就长在这里，和会话行同一套
 * 处理（透明、hover 中性、选中加重），右边还是同一张内容面。设置因此和聊天是
 * 同一个壳的两种内容，而不是叠在壳上的另一层。
 */
export function Sidebar(props: {
  session: ChatSession;
  /**
   * 中卡现在盖着哪个面。**三者互斥是事实，所以用一个联合类型而不是两个 boolean**
   * ——两个 boolean 能表达「同时打开」这种不存在的状态，而那正是 bug 的住处。
   */
  overlay: Overlay;
  settingsTab: SettingsTab;
  onSettingsTab: (tab: SettingsTab) => void;
  onOverlay: (next: Overlay) => void;
  /**
   * Archived / Carryovers 两个子视图的开关由 App 持有（2026-09-22：入口迁到右栏
   * 底部，状态跟着入口走，侧栏只剩受控渲染）。**子视图本体仍在侧栏**：换掉
   * 主列表区，不弹窗。
   */
  showArchived: boolean;
  showCarryovers: boolean;
  onShowArchived: (next: boolean) => void;
  onShowCarryovers: (next: boolean) => void;
  /** 当前宽度（px）。拖动中由调用方只改本地 state，松手才落 settings */
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
}) {
  const t = useT();
  const { session } = props;
  const asideRef = useRef<HTMLElement | null>(null);
  /** 拖宽中禁掉 width 过渡——实时跟手（同右侧面板的 .dragging 纪律） */
  const [resizing, setResizing] = useState(false);
  const settingsOpen = props.overlay === "settings";
  /**
   * 筛选行的完整 / 紧凑态：容器比四个带字 chip 的自然宽度窄就只画图标。
   * 判定在 `filter-row-compact.ts`（纯函数，带 hysteresis），这里只负责量宽度。
   */
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const [filterCompact, setFilterCompact] = useState(false);
  const filterFullWidth = useRef<number | null>(null);
  useEffect(() => {
    const row = filterRowRef.current;
    if (row === null) return;
    const measure = (): void => {
      const next = nextFilterRowMode({
        compact: filterCompact,
        fullWidth: filterFullWidth.current,
        containerWidth: row.clientWidth,
        contentWidth: row.scrollWidth,
      });
      filterFullWidth.current = next.fullWidth;
      if (next.compact !== filterCompact) setFilterCompact(next.compact);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
    // 筛选行可能整个不渲染（无会话 / Archived / Settings 视图），ref 空时不装观察者；
    // 它回来时靠下面这几个依赖重跑一次。live 在后面才算，这里用 session.sessions.length 代替
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterCompact, session.sessions.length, settingsOpen, props.showArchived, props.showCarryovers]);
  /**
   * 「Starred」叠加开关的开合，与状态筛选正交——星标是价值标记，与任务
   * 做没做完是两个问题，组合起来（如 Active + Starred）是合法且有意义的视图。
   * **只作用于主浏览列表**（Workspaces + Tasks）：Archived 是存储位置视图、
   * Settings 是另一块列表，都不受（也不该隐形地受）筛选。
   */
  const [starredOnly, setStarredOnly] = useState(false);
  /**
   * 完成状态筛选：单选组（All / Active / Done 互斥，点一个顶掉另一个）。
   * 默认 All = 无过滤；与 Starred 是两条独立的开关，叠加生效。
   */
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  /**
   * 「Has todos」叠加开关（收尾仪式的数据源落地后启用）：筛出**还有未办遗留**
   * 的会话——口径与角标同一份（open 数 > 0），事项全部办完的会话不再出现在
   * 这个视图里（它已经没有要办的事了，找它去 Done）。
   */
  const [hasTodosOnly, setHasTodosOnly] = useState(false);
  /**
   * 命名新建工作区：Workspaces 列表顶部那行就地编辑（InlineName）开没开着。
   * 「+」菜单里选「New workspace…」置 true；Enter / Esc / 点别处（失焦提交，
   * 空名不提交）都会收掉。**不持久化**——一个没提交的名字不值得活过重启。
   */
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  /**
   * 折叠态：窗口跨过断点时自动跟，`panel-left` 随时手动开合。
   * **手动状态不持久化**——窗口宽度本身不持久化，持久化一个和宽度绑定的状态会打架。
   */
  const [collapsed, setCollapsed] = useState(false);
  /**
   * 分组状态：哪些组折叠着、哪些组点了 Show more 全量铺开。状态本体在
   * `sidebar-fold.ts`；同样**不持久化**，理由同上——列表每次启动从盘上重读。
   */
  const [groups, setGroups] = useState<SidebarGroupState>({
    folds: new Set<string>(),
    full: new Set<string>(),
  });
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${COLLAPSE_BREAKPOINT - 1}px)`);
    const sync = () => setCollapsed(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  const width = props.width;
  /** 高亮哪一条：盖着别的面时谁也不高亮；否则在看历史就是那条，不然是活着的那条 */
  const openId = props.overlay !== null ? null : (session.sessionId ?? session.opened?.id ?? null);

  /**
   * 新建任务顺带退出设置页（wafo 2026-09-03：此前停在 Settings 里点 New Task
   * 没反应，得再按一次 Settings 才回得去——用户的心智是「新建 = 回到对话」）。
   */
  const startNewTask = (): void => {
    props.onOverlay(null);
    setCollapsed(false);
    // 新任务落在 TASKS 里——不能落进一个收着的组里无声无息
    setGroups((current) => unfoldGroup(current, TASKS_FOLD_KEY));
    session.newTask();
  };
  /**
   * 不属于任何工作区的会话。**也包括归属指向已移除工作区的那些**——
   * 移除工作区不该让它的会话从界面上消失，它们只是回到 TASKS 下。
   */
  const known = new Set(session.workspaces.map((w) => w.id));
  /**
   * 左栏只列**根会话**：子会话是母会话的附属物，从母会话的右栏 Sub-sessions
   * 入口到达，永不进这里（也不进 Archived——它没有归档语义）。
   */
  const roots = rootSessions(session.sessions);
  /** 归档的从主列表里移走——**不是删除**，它们收在底部那一行后面 */
  const live = roots.filter((m) => !m.archived);
  const archived = roots.filter((m) => m.archived);
  /**
   * 子视图空了就自动退回主列表——否则停在一个空视图里，而唯一的出口（底部
   * 那条行）正好因为 N 为 0 而禁用。判定与理由在 `subview-exit.ts`。
   */
  useEffect(() => {
    if (shouldExitSubview(props.showArchived, archived.length)) props.onShowArchived(false);
  }, [props.showArchived, props.onShowArchived, archived.length]);
  useEffect(() => {
    if (shouldExitSubview(props.showCarryovers, session.carryovers.length)) props.onShowCarryovers(false);
  }, [props.showCarryovers, props.onShowCarryovers, session.carryovers.length]);
  // 两个节点各自的读取进度：加载中 / 读失败 / 真的空（D-3）
  const workspaceList = describeList(session.loads.workspaces, session.workspaces.length);
  // 用 roots.length 不用 session.sessions.length：这里描述的是左栏那份列表
  // （只列根会话，子会话 PR4c 2.3），两个数字不一致会出现「读到 0 条」误报或反之
  const sessionList = describeList(session.loads.sessions, roots.length);
  /**
   * 主列表的筛选管线（筛选区 chips）。状态（All/Active/Done，单选组）、星标与
   * Has todos（两个叠加开关）三条正交条件串在同一个 filter 里。**只作用于主浏览
   * 列表**——Archived / Carryovers 是存储与事项视图，不受（也不该隐形地受）筛选。
   */
  const filtered = statusFilter !== "all" || starredOnly || hasTodosOnly;
  const scoped = live.filter((m) => {
    if (statusFilter === "active" && isSessionDone(m)) return false;
    if (statusFilter === "done" && !isSessionDone(m)) return false;
    if (starredOnly && m.starred !== true) return false;
    if (hasTodosOnly && openTodoCount(session.carryovers, m.id) === 0) return false;
    return true;
  });
  const loose = scoped.filter((m) => m.workspaceId === null || !known.has(m.workspaceId));
  // 筛选开着时，没有命中会话的工作区组整个不显示——一排空组头比没有更吵
  const workspaceMatches = filtered
    ? session.workspaces.filter((workspace) => scoped.some((m) => m.workspaceId === workspace.id))
    : session.workspaces;
  const tasksFolded = groups.folds.has(TASKS_FOLD_KEY);
  // TASKS 的超长截断：默认列前 N 条，其余收进「Show N more」
  const tasksFull = groups.full.has(TASKS_FOLD_KEY);
  const looseVisible = tasksFull ? loose : loose.slice(0, SESSIONS_PREVIEW_LIMIT);
  const open = (id: string) => {
    props.onOverlay(null);
    session.openSession(id);
  };

  /**
   * 拖宽：右移变宽（与右侧面板同一套机制，只是方向相反）。**区间是固定像素 240–400**
   * ——右栏那条「pane 的 1/3–2/3」不管左栏（2026-09-22 wafo 澄清：那一对说的是
   * chat 主区与右栏）；
   * 拖动中不做动画、全文选择与光标固定成拖拽语义，松手还原；双击热区回 288。
   * 对话面（`main.pane`）是 `flex: 1`，侧栏变宽它自己就让出来——用户要的正是
   * 「靠右侧 chat view 的宽度来调节」（2026-09-22 wafo）。
   */
  const startResize = (event: React.PointerEvent): void => {
    if (event.button !== 0) return;
    const aside = asideRef.current;
    if (aside === null) return;
    event.preventDefault();
    setResizing(true);
    const startX = event.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const clamp = (value: number): number =>
      Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
    const previousSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    const move = (ev: PointerEvent): void => {
      props.onWidthChange(clamp(startWidth + (ev.clientX - startX)));
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener("pointermove", move);
      document.body.style.userSelect = previousSelect;
      document.body.style.cursor = previousCursor;
      setResizing(false);
      props.onWidthCommit(clamp(startWidth + (ev.clientX - startX)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up, { once: true });
  };

  // —— 折叠态：48px 图标条（RailButton 规格：32px 方块、tooltip 即标签）。
  // 折叠期间列表不可达，要切会话先展开。Archived / Carryovers / Settings
  // 不在这里重复摆入口：它们的唯一入口在右栏底部（2026-09-22 裁决），
  // 折叠态也能点到（右栏不折叠）。
  if (collapsed) {
    return (
      <aside
        style={{
          width: 48,
          flex: "0 0 48px",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          padding: "var(--space-2) 0",
          background: "transparent",
          overflow: "hidden",
          transition: "width var(--duration-fast) var(--ease-standard)",
        }}
      >
        {/* 顶栏仍兼窗口拖拽区：48px 里没有 logo 的位置 */}
        <div className="titlebar" style={{ height: 34, width: "100%" }} />
        <RailButton icon="panel-left" title={t.sidebar.expand} onClick={() => setCollapsed(false)} />
        <RailButton
          icon="plus"
          title={t.common.newTask}
          accent
          onClick={startNewTask}
        />
      </aside>
    );
  }

  return (
    <>
    <aside
      ref={asideRef}
      style={{
        width,
        flex: `0 0 ${width}px`,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-2) var(--space-3)",
        background: "transparent",
        overflow: "hidden",
        // 拖动中禁过渡：160ms 的宽度动画会让跟手变成拖一根皮筋
        transition: resizing ? "none" : "width var(--duration-fast) var(--ease-standard)",
      }}
    >
      {/*
        顶栏兼作标题栏：`titleBarStyle: "hiddenInset"` 之后这是窗口唯一的可拖区域，
        macOS 上还要给红黄绿三个键让净空——见 styles.css 的 `.titlebar`。
        没有 logo：品牌就是衬线体里的小写 orbita（设计系统 *No logo*）。
      */}
      <div
        className="titlebar"
        style={{
          display: "flex",
          alignItems: "center",
          height: 34,
          fontFamily: "var(--font-family-brand)",
          fontSize: 22,
          fontWeight: 500,
          lineHeight: 1,
          letterSpacing: "0.01em",
          color: "var(--color-text-primary)",
        }}
      >
        orbita
        <IconButton
          label={t.sidebar.collapse}
          title={t.sidebar.collapseTip}
          size={24}
          onClick={() => setCollapsed(true)}
          style={{ marginInlineStart: "auto", color: "var(--color-text-tertiary)" }}
        >
          <Icon name="panel-left" size={14} />
        </IconButton>
      </div>

      <div role="tablist" style={{ display: "flex", gap: 4 }}>
        <ModeChip icon="bot" active>
          {t.sidebar.agentMode}
        </ModeChip>
        <ModeChip icon="workflow" disabled title={t.sidebar.orchestratePlanned}>
          {t.sidebar.orchestrate}
        </ModeChip>
      </div>

      {/* 一屏一个 accent：主操作（新建 / 发送）与模式选中，别处一律中性 */}
      <button
        type="button"
        onClick={startNewTask}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: "100%",
          height: 32,
          padding: "0 10px",
          border: 0,
          borderRadius: "var(--radius-md)",
          background: "var(--color-accent)",
          color: "var(--color-accent-fg)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          fontWeight: "var(--weight-medium)",
          cursor: "pointer",
          transition: "var(--transition-hover)",
        }}
      >
        <Icon name="plus" size={16} />
        {t.common.newTask}
      </button>

      {/**
        筛选区：会话浏览的过滤 chips。状态是单选组（All / Active / Done 互斥，
        点一个顶掉另一个），Starred 是叠加开关——两者正交，可组合出
        「进行中且星标」这样的视图。**只在主列表视图显示**，且没有任何会话时
        筛选无从谈起，不摆。
      */}
      {live.length > 0 && !settingsOpen && !props.showArchived && !props.showCarryovers && (
        <div
          ref={filterRowRef}
          style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden" }}
        >
          <Chip
            icon="list"
            compact={filterCompact}
            active={statusFilter === "all"}
            title={t.sidebar.filterAllTip}
            onClick={() => setStatusFilter("all")}
          >
            {t.sidebar.filterAll}
          </Chip>
          <Chip
            icon="play"
            compact={filterCompact}
            active={statusFilter === "active"}
            title={t.sidebar.filterActiveTip}
            onClick={() => setStatusFilter("active")}
          >
            {t.sidebar.filterActive}
          </Chip>
          <Chip
            icon="check"
            compact={filterCompact}
            active={statusFilter === "done"}
            title={t.sidebar.filterDoneTip}
            onClick={() => setStatusFilter("done")}
          >
            {t.sidebar.filterDone}
          </Chip>
          <Chip
            icon="star"
            compact={filterCompact}
            active={starredOnly}
            title={t.sidebar.filterStarredTip}
            onClick={() => setStarredOnly((value) => !value)}
          >
            {t.sidebar.filterStarred}
          </Chip>
          {/* 灯泡 = 「这条会话还留着 idea / 没办完的事」（wafo 2026-09-22 裁决） */}
          <Chip
            icon="lightbulb"
            compact={filterCompact}
            active={hasTodosOnly}
            title={t.sidebar.filterTodosTip}
            onClick={() => setHasTodosOnly((value) => !value)}
          >
            {t.sidebar.filterTodos}
          </Chip>
        </div>
      )}

      <div
        className="scroll"
        style={{
          flex: 1,
          minHeight: 0,
          marginRight: "calc(-1 * var(--space-3))",
          paddingRight: "var(--space-3)",
        }}
      >
        {props.showArchived && !settingsOpen ? (
          <>
            {/*
              标题行左端的返回键是 Archived 视图的**显式出口**。以前出去只能再点一次
              底部那条 toggle，而它既不像一个「返回」，又会在归档空了时禁用。
              这是一个子视图，子视图就该在它自己的标题旁边带着回去的路。
            */}
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
              <IconButton
                label={t.sidebar.backToTasks}
                title={t.sidebar.backToTasksTip}
                size={20}
                onClick={() => props.onShowArchived(false)}
                style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-secondary)" }}
              >
                <Icon name="chevron-left" size={13} strokeWidth={1.8} />
              </IconButton>
              <NodeLabel>{t.sidebar.archived}</NodeLabel>
            </div>
            {archived.map((meta) => (
              <SessionRow
                key={meta.id}
                meta={meta}
                session={session}
                active={meta.id === openId}
                onClick={() => open(meta.id)}
              />
            ))}
          </>
        ) : props.showCarryovers && !settingsOpen ? (
          <CarryoverPanel
            carryovers={session.carryovers}
            sessions={session.sessions}
            onSetStatus={session.setCarryoverStatus}
            onBack={() => props.onShowCarryovers(false)}
            onResumeNew={(item) => {
              // 开工即回对话：退出面板（下次进重新开），新会话落在来源会话的组里
              // （cwd / 归属跟随它）——不能落进一个收着的组里无声无息
              props.onShowCarryovers(false);
              props.onOverlay(null);
              setCollapsed(false);
              const source = session.sessions.find((m) => m.id === item.sourceSessionId);
              setGroups((current) =>
                source?.workspaceId != null
                  ? unfoldGroup(current, foldKeyForWorkspace(source.workspaceId))
                  : unfoldGroup(current, TASKS_FOLD_KEY),
              );
              session.startCarryoverTask(item);
            }}
            onResumeInSource={(item) => {
              // 右键备选：续跑原会话——跳回去看它接着干（同 onOpenTask 的退场）
              props.onShowCarryovers(false);
              props.onOverlay(null);
              session.continueCarryoverInSource(item);
            }}
            onOpenTask={(id) => {
              // 看完事项跳回对话：退出面板、切到那条会话（面板下次进重新开）
              props.onShowCarryovers(false);
              open(id);
            }}
          />
        ) : settingsOpen ? (
          <>
            <NodeLabel>{t.common.settings}</NodeLabel>
            {SETTINGS_TABS.map((tab) => (
              <NavRow
                key={tab.id}
                icon={tab.icon}
                label={t.settings.tabs[tab.id]}
                active={props.settingsTab === tab.id}
                onClick={() => props.onSettingsTab(tab.id)}
              />
            ))}
          </>
        ) : filtered && scoped.length === 0 ? (
          /* 筛选扑空：一条空态说清「为什么什么都没有、怎么才有」，而非留白两节空头 */
          <Empty>{filterEmptyText(statusFilter, starredOnly, hasTodosOnly, t)}</Empty>
        ) : (
          <>
            {(!filtered || workspaceMatches.length > 0) && (
              <>
                <NodeHeader
                  label={t.sidebar.workspaces}
                  addLabel={t.sidebar.addWorkspace}
                  addIcon="folder-plus"
                  addMenu={[
                    // 命名新建：icon 用 plus——folder-plus 留给「选一个已有文件夹」，
                    // 两种添法在菜单里各占一个符号
                    {
                      id: "new-workspace",
                      label: t.sidebar.newWorkspace,
                      icon: "plus",
                      onSelect: () => setCreatingWorkspace(true),
                    },
                    {
                      id: "add-folder",
                      label: t.sidebar.addFolder,
                      icon: "folder-plus",
                      onSelect: session.addWorkspace,
                    },
                  ]}
                />
                {creatingWorkspace && (
                  // 就地命名：与工作区组头同一套 icon 槽与行高，像「正在出生的那一行」。
                  // Enter 提交、Esc 放弃；失焦即提交（InlineName 的死规矩），空名不提交
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "20px 24px minmax(0,1fr)",
                      alignItems: "center",
                      gap: "var(--space-1)",
                      minHeight: "var(--control-height-md)",
                    }}
                  >
                    <span />
                    <span
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 24,
                        height: 24,
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      <Icon name="folder" size={14} strokeWidth={1.8} />
                    </span>
                    <InlineName
                      editing
                      value=""
                      placeholder={t.sidebar.workspaceName}
                      onCommit={(name) => {
                        setCreatingWorkspace(false);
                        const trimmed = name.trim();
                        if (trimmed !== "") session.createWorkspace(trimmed);
                      }}
                      onCancel={() => setCreatingWorkspace(false)}
                    />
                  </div>
                )}
                {/*
                  读失败时错误行贴在列表上方，旧列表照常列（失败不清空手里那份）；
                  只有从没读成功过才是空空的错误行 + 什么都不列（none）。
                */}
                {workspaceList.error !== null && (
                  <ListError message={workspaceList.error} onRetry={session.reloadWorkspaces} />
                )}
                {workspaceList.body === "loading" ? (
                  <Empty>{t.sidebar.loadingWorkspaces}</Empty>
                ) : workspaceList.body === "empty" ? (
                  <Empty>{t.sidebar.noWorkspace}</Empty>
                ) : workspaceList.body === "list" ? (
                  workspaceMatches.map((workspace) => (
                    <WorkspaceGroup
                      key={workspace.id}
                      workspace={workspace}
                      sessions={scoped.filter((m) => m.workspaceId === workspace.id)}
                      session={session}
                      openId={openId}
                      folded={groups.folds.has(foldKeyForWorkspace(workspace.id))}
                      onToggleFold={() =>
                        setGroups((current) =>
                          toggleGroupFold(current, foldKeyForWorkspace(workspace.id)),
                        )
                      }
                      full={groups.full.has(foldKeyForWorkspace(workspace.id))}
                      onToggleFull={() =>
                        setGroups((current) =>
                          toggleGroupFull(current, foldKeyForWorkspace(workspace.id)),
                        )
                      }
                      onNewTask={() => {
                        // 新任务落进这个组——先展开，不能让会话落进一个收着的组里无声无息
                        setGroups((current) =>
                          unfoldGroup(current, foldKeyForWorkspace(workspace.id)),
                        );
                        session.newTaskIn(workspace);
                      }}
                      onRename={(name) => session.renameWorkspace(workspace.id, name)}
                      onRemove={() => session.removeWorkspace(workspace.id)}
                      onOpen={open}
                    />
                  ))
                ) : null}
              </>
            )}

            {(!filtered || loose.length > 0) && (
              <div style={{ marginTop: "var(--space-3)" }}>
                {/**
                  TASKS 节点列的是**落盘的会话**。今天全部会话都挂在这里而不是挂到
                  **不属于任何工作区**的那些。这就是设计系统里 TASKS 与 WORKSPACES
                  两个节点的区别，也是「+ New task」与工作区那个「+」的区别。
                */}
                <NodeHeader
                  label={t.sidebar.tasks}
                  addLabel={t.common.newTask}
                  addIcon="plus"
                  onAdd={() => {
                    // 同上：新任务落 TASKS，先展开再建
                    setGroups((current) => unfoldGroup(current, TASKS_FOLD_KEY));
                    session.newTask();
                  }}
                  folded={tasksFolded}
                  onToggleFold={
                    loose.length > 0
                      ? () => setGroups((current) => toggleGroupFold(current, TASKS_FOLD_KEY))
                      : undefined
                  }
                />
                {sessionList.error !== null && (
                  <ListError message={sessionList.error} onRetry={session.reloadSessions} />
                )}
                {sessionList.body === "loading" ? (
                  <Empty>{t.sidebar.loadingTasks}</Empty>
                ) : sessionList.body === "none" ? null : sessionList.body === "empty" ? (
                  <Empty>{t.sidebar.noTask}</Empty>
                ) : tasksFolded ? null : (
                  <>
                    {looseVisible.map((meta) => (
                      <SessionRow
                        key={meta.id}
                        meta={meta}
                        session={session}
                        active={meta.id === openId}
                        onClick={() => open(meta.id)}
                      />
                    ))}
                    {loose.length > SESSIONS_PREVIEW_LIMIT && (
                      <ShowAllRow
                        full={tasksFull}
                        hidden={loose.length - SESSIONS_PREVIEW_LIMIT}
                        onClick={() =>
                          setGroups((current) => toggleGroupFull(current, TASKS_FOLD_KEY))
                        }
                      />
                    )}
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </aside>
    {/*
      拖宽热区：侧栏与对话面之间那道缝里的 6px，紧贴面的左缘。
      **不放在 aside 里**：aside 是 overflow:hidden 的，放里面会被裁；也不压在
      面上（那会抢走对话面左缘那一条的点击）。定位基准是 `.layer`（唯一带
      position 的祖先），所以 left = 左内边距 + 侧栏宽 + 缝−热区宽。
      绝对定位不占 flex 位，不会给 .layer 多出一列。
    */}
    <span
      onPointerDown={startResize}
      onDoubleClick={() => props.onWidthCommit(SIDEBAR_WIDTH_DEFAULT)}
      title={t.common.dragResize}
      style={{
        position: "absolute",
        left: `calc(var(--space-3) + ${width}px + var(--space-3) - 6px)`,
        top: "var(--space-3)",
        bottom: "var(--space-3)",
        width: 6,
        cursor: "col-resize",
        zIndex: 5,
      }}
    />
    </>
  );
}

/**
 * 一个工作区，连同它自己的会话。
 *
 * **行首的 chevron 折叠这一组**：会话开得太多时，把不看的组收起来。开合只认
 * chevron（VS Code 同款纪律）——行身保持双击改名一条干净的路，两个手势不打架。
 * 折叠只藏会话行，工作区头永远在：归属关系不能跟着藏掉。
 *
 * 改名走**双击名字**：设计系统的纪律是克制，288px 的一行里再挂一个铅笔键
 * 就开始堆图标了；tooltip 负责把这句话讲出来（*Tooltips carry the second half
 * of the sentence*）。移除走两段式，和删会话一致。
 */
function WorkspaceGroup(props: {
  workspace: Workspace;
  sessions: SessionMeta[];
  session: ChatSession;
  openId: string | null;
  folded: boolean;
  onToggleFold: () => void;
  full: boolean;
  onToggleFull: () => void;
  onNewTask: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 超过预览数只列前 N 条，其余收进「Show N more」；点了才全量铺开
  const truncated = !props.full && props.sessions.length > SESSIONS_PREVIEW_LIMIT;
  const visible = truncated ? props.sessions.slice(0, SESSIONS_PREVIEW_LIMIT) : props.sessions;

  const commit = () => {
    if (editing !== null) props.onRename(editing);
    setEditing(null);
  };

  return (
    <div
      // 组本身不再垫 padding：之前上下各 8px 加 28 的行高 = 44，三个空组排在一起
      // 比下方 32px 的任务行松一截，像三块各自为政的卡（2026-09-21 wafo）。
      // 组头行高改成与 NavRow 同一个 token，两种行在同一张列表里等高。
      className="workspace-group"
      onMouseLeave={() => setArmed(false)}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "20px 24px minmax(0,1fr) auto 26px",
          alignItems: "center",
          gap: "var(--space-1)",
          minHeight: "var(--control-height-md)",
        }}
      >
        {/* 空组没有可折的东西，开关就不摆——一个点了什么都不发生的开关比没有更吵 */}
        {props.sessions.length > 0 ? (
          <IconButton
            label={props.folded ? t.sidebar.expandGroup : t.sidebar.collapseGroup}
            ariaExpanded={!props.folded}
            size={20}
            onClick={props.onToggleFold}
            style={{ color: "var(--color-text-tertiary)" }}
          >
            <FoldChevron folded={props.folded} />
          </IconButton>
        ) : (
          <span />
        )}

        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 24,
            height: 24,
            color: "var(--color-text-secondary)",
          }}
        >
          <Icon name="folder" size={14} strokeWidth={1.8} />
        </span>

        {editing === null ? (
          <strong
            title={t.sidebar.workspacePathTip(props.workspace.path)}
            onDoubleClick={() => setEditing(props.workspace.name)}
            style={{
              minWidth: 0,
              fontSize: "var(--font-size-control)",
              fontWeight: "var(--weight-semibold)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "default",
            }}
          >
            {props.workspace.name}
          </strong>
        ) : (
          <input
            autoFocus
            value={editing}
            onChange={(event) => setEditing(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") commit();
              // Esc 放弃这次改名，不留一个半截名字
              if (event.key === "Escape") setEditing(null);
            }}
            style={{
              minWidth: 0,
              width: "100%",
              height: 22,
              padding: "0 4px",
              border: 0,
              borderRadius: "var(--radius-xs)",
              background: "var(--color-bg-panel)",
              color: "var(--color-text-primary)",
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-control)",
              fontWeight: "var(--weight-semibold)",
              outline: "none",
              boxShadow: "var(--focus-ring)",
            }}
          />
        )}

        <IconButton
          label={armed ? t.sidebar.removeArmed : t.sidebar.remove}
          title={
            armed
              ? t.sidebar.removeArmedTip
              : t.sidebar.removeTip
          }
          size={20}
          onClick={() => (armed ? props.onRemove() : setArmed(true))}
          className="reveal workspace-group-remove"
          style={{
            borderRadius: "var(--radius-xs)",
            color: armed ? "var(--color-danger)" : "var(--color-text-tertiary)",
            // armed（二次确认已按下）常显，不等 hover——armed 只有 mouseleave 才清
            opacity: armed ? 1 : undefined,
          }}
        >
          <Icon name="trash-2" size={11} />
        </IconButton>

        <IconButton label={t.sidebar.newTaskInWorkspace} size={26} onClick={props.onNewTask}>
          <Icon name="plus" size={14} />
        </IconButton>
      </div>

      {!props.folded && (
        <>
          {visible.map((meta) => (
            <SessionRow
              key={meta.id}
              meta={meta}
              session={props.session}
              active={meta.id === props.openId}
              onClick={() => props.onOpen(meta.id)}
            />
          ))}
          {props.sessions.length > SESSIONS_PREVIEW_LIMIT && (
            <ShowAllRow
              full={props.full}
              hidden={props.sessions.length - SESSIONS_PREVIEW_LIMIT}
              onClick={props.onToggleFull}
            />
          )}
        </>
      )}
    </div>
  );
}

/** 分组标题：机器面的小字用 business/mono，字号 micro，大写加字距 */
function NodeLabel(props: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        fontFamily: "var(--font-family-business)",
        fontSize: "var(--font-size-micro)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        fontWeight: "var(--weight-bold)",
        color: "var(--color-text-secondary)",
      }}
    >
      {props.children}
    </span>
  );
}

function NodeHeader(props: {
  label: string;
  addLabel: string;
  addIcon: IconName;
  /**
   * 「+」点开的菜单：同一颗键给多种添法（Workspaces：命名新建 / 选已有文件夹）。
   * 与 onAdd 二选一——传了它 onAdd 就不解析。
   */
  addMenu?: MenuItem[];
  onAdd?: () => void;
  /** 传了 onToggleFold 就说明这个节点的孩子可折叠：label 变成开合按钮（chevron + 名字） */
  folded?: boolean;
  onToggleFold?: (() => void) | undefined;
}) {
  const addButton = (onClick: () => void, open: boolean): React.ReactNode => (
    <IconButton label={props.addLabel} size={26} active={open} onClick={onClick}>
      <Icon name={props.addIcon} size={14} />
    </IconButton>
  );
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 26px",
        alignItems: "center",
        gap: 2,
        minHeight: 28,
      }}
    >
      {props.onToggleFold !== undefined ? (
        <FoldHeaderButton
          label={props.label}
          folded={props.folded === true}
          onToggle={props.onToggleFold}
        />
      ) : (
        <NodeLabel>{props.label}</NodeLabel>
      )}
      {props.addMenu !== undefined ? (
        <Menu
          items={props.addMenu}
          // 「+」贴着侧栏右缘：菜单右缘对齐按钮，向左展开（窄侧栏放不下会回落）
          align="end"
          panelMinWidth={200}
          trigger={({ open, toggle }) => addButton(toggle, open)}
        />
      ) : props.onAdd !== undefined ? (
        addButton(props.onAdd, false)
      ) : null}
    </div>
  );
}

/**
 * 折叠 chevron：展开是 chevron-down，收起转 -90°。转场用 motion token——
 * `--duration-fast` 正是设计系统给 chevron 定的 160ms。
 */
function FoldChevron(props: { folded: boolean }) {
  return (
    <Icon
      name="chevron-down"
      size={12}
      strokeWidth={1.8}
      style={{
        transform: props.folded ? "rotate(-90deg)" : "rotate(0deg)",
        transition: "transform var(--duration-fast) var(--ease-standard)",
      }}
    />
  );
}

/**
 * 节点级的开合按钮（TASKS 用）：chevron + 名字整块可点，比工作区组的
 * 单个 chevron 大——它折的是整个 loose 列表，是最常用的那一刀。
 */
function FoldHeaderButton(props: { label: string; folded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={!props.folded}
      onClick={props.onToggle}
      className="fold-header-btn"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        minWidth: 0,
        minHeight: 28,
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-xs)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <FoldChevron folded={props.folded} />
      <NodeLabel>{props.label}</NodeLabel>
    </button>
  );
}

/**
 * 「Show N more / Show less」行：一组超过预览数时垫在列表尾。**条数写进文案**——
 * 被藏起来多少这件事不能是悄悄的。双向：铺开后原地变成「Show less」，
 * 点一下收回最近的 N 条（排序保证前 N 条就是最近 N 条，置顶恒在最前）。
 */
function ShowAllRow(props: { full: boolean; hidden: number; onClick: () => void }) {
  const t = useT();
  return (
    <NavRow
      icon={props.full ? "chevron-up" : "chevron-down"}
      label={props.full ? t.sidebar.showLess : t.sidebar.showMore(props.hidden)}
      active={false}
      tone="var(--color-text-tertiary)"
      onClick={props.onClick}
    />
  );
}

/**
 * 侧栏里的一行导航。**会话行、设置 tab、Archived、Settings 全都是它**——
 * 它们本来就是一回事：前导 13px 图标槽 + 一行文字，整条可点（不是只有图标可点）。
 *
 * hover 与选中都走 `--option-hover-bg` / `--option-active-bg`，两个值在 styles.css
 * 里一处定义；`.option-row` 的三态配方与取舍也写在那儿。
 */
function NavRow(props: {
  /** `null` = 这一行没有图标可画（会话行的空状态槽）。槽仍然占位，标题才对得齐 */
  icon: IconName | null;
  label: string;
  active: boolean;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  tone?: string;
  spin?: boolean;
  /** 图标槽的悬停说明（会话行用它讲状态） */
  iconTitle?: string;
  /** 整行的悬停说明（planned 的东西用它讲为什么点不动） */
  hint?: string;
  style?: React.CSSProperties;
}) {
  const disabled = props.disabled === true;
  const clickable = !disabled && props.onClick !== undefined;
  return (
    <button
      type="button"
      className="option-row"
      title={props.hint}
      disabled={disabled}
      aria-pressed={clickable ? props.active : undefined}
      // 选中的视觉与是否可点无关（原 selectionStyle({ selected: props.active, … })
      // 不看 clickable）；aria-pressed 只在可点时才挂——两者分开，样式只认 data-active
      data-active={props.active || undefined}
      onClick={props.onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        minHeight: "var(--control-height-md)",
        margin: "2px 0",
        padding: "var(--space-1) var(--space-2) var(--space-1) var(--space-1)",
        border: 0,
        borderRadius: "var(--radius-sm)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : clickable ? "pointer" : "default",
        ...props.style,
      }}
    >
      <span
        title={props.iconTitle}
        style={{
          display: "grid",
          placeItems: "center",
          flex: "0 0 auto",
          color: disabled ? "var(--color-text-tertiary)" : (props.tone ?? "var(--color-text-secondary)"),
        }}
      >
        {props.icon === null ? (
          // 空槽：不画任何东西，但占与图标等宽的位置——有标记的行和没标记的行标题对齐
          <span style={{ width: 13, height: 13 }} />
        ) : (
          <Icon name={props.icon} size={13} strokeWidth={1.8} spin={props.spin ?? false} />
        )}
      </span>
      <span
        style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {props.label}
      </span>
    </button>
  );
}

/**
 * 一条会话。状态槽在最前面——**状态优先用图标与文字，颜色是第二信号**。
 *
 * 右边是**一个星标键加三个点**，不是一排图标：288px 的一行挂不下六个动作。
 * 星标是唯一挂在行上的动作——它是一天里按得最多的那个（Proma 的悬停即星标，
 * 2026-09-22 wafo 点名），走菜单等于「点两下菜单换一个布尔」。
 * **两处破坏性/有去处的动作在菜单里仍然是两段式**——删除要确认，
 * 转移要选目标——都靠 `keepOpen` 把菜单原地换成第二组项，
 * 「先讲后果再动作」不因为换了容器就省掉。
 */
function SessionRow(props: {
  meta: SessionMeta;
  session: ChatSession;
  active: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const { meta, session } = props;
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<"main" | "move" | "delete" | "archive" | "archive-done">(
    "main",
  );
  /**
   * 删除确认步要说的「工作台里有几个文件」。删会话连带删工作台，确认项先把
   * 后果说出来（提示后删，Proma 是不提示直接删，我们多这一句）。null = 没拉到
   * 或里面没文件，文案退回光秃秃的 Delete permanently。
   */
  const [workbenchFiles, setWorkbenchFiles] = useState<number | null>(null);
  const live = meta.id === session.sessionId;
  // 行的运行态查它自己的槽：后台在跑的会话切走了也照样转圈，与「当前看哪条」无关
  const running = session.phaseOf(meta.id) !== "idle";
  // 失败同样查槽：后台会话重试耗尽（turnError）也亮 Failed，不止正看着的那条
  const failed = !running && (session.turnErrorOf(meta.id) !== null || (live && session.error !== null));
  const done = isSessionDone(meta);
  /**
   * 行首状态槽：running > failed > pinned > 空。优先级与理由在
   * `row-status.ts`（纯函数 + 测试）。`null` = 这一行没什么可说，槽留空。
   */
  const status = rowStatusIcon({ running, failed, pinned: meta.pinned === true }, t);
  // 这条会话的未办遗留数（行尾角标，与筛选同口径）
  const openTodos = openTodoCount(session.carryovers, meta.id);
  // 批量归档的目标数（清理入口随处可点，但只收已完成且未归档的）。子会话不参与
  // 归档（session.ts 的契约），`archiveDoneSessions` 的目标同样已过 rootSessions
  // 过滤——这里的显示数必须与它的实际目标数一致，否则按钮上写的数比真做的多
  const doneCount = rootSessions(session.sessions).filter(
    (m) => isSessionDone(m) && !m.archived,
  ).length;
  /**
   * 闲置建议：open 且未归档、最后一次活动超过 7 天——纯派生（每次渲染按
   * updatedAt 现算，不落盘），hover 才出现的一个轻提示，不弹通知不加角标。
   */
  const idleSuggested = !done && !meta.archived && Date.now() - meta.updatedAt > IDLE_SUGGEST_MS;
  // 删父连带删子（session.ts 的级联契约）：删除确认要把这个后果说出来，不能只
  // 提工作台文件数——子会话数是更容易被忽略、也更重的一条后果（子会话 PR4c 2.4）
  const childCount = childSessions(session.sessions, meta.id).length;

  /**
   * 进删除确认步：异步拉工作台文件数，到了再补进文案——拉取不阻塞菜单，
   * 一次 stat 失败也不该堵住删除。
   */
  const enterDeleteStep = () => {
    setStep("delete");
    setWorkbenchFiles(null);
    api.session
      .workbenchStat(meta.id)
      .then((stat) => {
        if (stat.exists && stat.fileCount > 0) setWorkbenchFiles(stat.fileCount);
      })
      .catch(() => undefined);
  };
  /** 退出删除确认步（Cancel / 菜单重开）：文件数一并清掉，下次进重新拉 */
  const exitDeleteStep = () => {
    setStep("main");
    setWorkbenchFiles(null);
  };

  const items: MenuItem[] =
    step === "delete"
      ? [
          { id: "cancel", label: t.common.cancel, icon: "x", keepOpen: true, onSelect: exitDeleteStep },
          {
            id: "confirm",
            label: t.sidebar.deletePermanently,
            // 后果说清楚才能删：子会话数摆在文件数前面——它更容易被忽略，也是
            // 删除唯一会连带删掉别的会话的后果。走 hint 而不是拼进 label：菜单
            // 最宽 200px，「N sub-sessions · M files」这类全称经常放不下（拼进去
            // 会被 ellipsis 吃掉，等于没提示），改用更紧凑的「N sub · M files」
            // （机器事实，允许省掉单复数语法糖）。都没有就不出 hint。
            ...(childCount === 0 && workbenchFiles === null
              ? {}
              : {
                  hint: [
                    childCount > 0 ? t.sidebar.deleteHintSub(childCount) : null,
                    workbenchFiles === null ? null : t.sidebar.deleteHintFiles(workbenchFiles),
                  ]
                    .filter((part): part is string => part !== null)
                    .join(" · "),
                }),
            icon: "trash-2",
            danger: true,
            onSelect: () => session.removeSession(meta.id),
          },
        ]
      : step === "archive"
        ? [
            /**
             * 归档的**二次确认**（wafo 2026-09-22）。上一版这里是「先做，再给一条
             * 撤销条」，用户用下来要的不是撤销而是确认：一条会自己走掉的提示把“没做对”
             * 的补救窗口变成了限时题，而确认把判断放在动作发生之前，不计时。
             * 与 Delete 同款：菜单内原地换第二组项，不开模态框。不带 danger——
             * 归档不是破坏性动作，只是换个地方放。
             */
            { id: "cancel", label: t.common.cancel, icon: "x", keepOpen: true, onSelect: () => setStep("main") },
            {
              id: "confirm",
              label: t.sidebar.archiveTask,
              icon: "archive",
              onSelect: () => session.archiveSession(meta.id, true),
            },
          ]
      : step === "archive-done"
        ? [
            { id: "cancel", label: t.common.cancel, icon: "x", keepOpen: true, onSelect: () => setStep("main") },
            {
              id: "confirm",
              label: t.sidebar.archiveDoneTasks(doneCount),
              icon: "archive",
              onSelect: () => session.archiveDoneSessions(),
            },
          ]
        : step === "move"
        ? [
            {
              id: "none",
              label: t.sidebar.noWorkspaceTarget,
              icon: "folder",
              checked: meta.workspaceId === null,
              onSelect: () => session.moveSession(meta.id, null),
            },
            ...session.workspaces.map((workspace) => ({
              id: workspace.id,
              label: workspace.name,
              icon: "folder" as const,
              checked: meta.workspaceId === workspace.id,
              onSelect: () => session.moveSession(meta.id, workspace.id),
            })),
          ]
        : [
            { id: "rename", label: t.common.rename, icon: "pencil-line", onSelect: () => setEditing(true) },
            {
              id: "pin",
              label: meta.pinned ? t.sidebar.unpin : t.sidebar.pin,
              icon: meta.pinned ? "pin-off" : "pin",
              onSelect: () => session.pinSession(meta.id, !meta.pinned),
            },
            // Star / Unstar 与 Mark done / Reopen 都不在这儿——它们已经是行上的悬停标记
            // （一次点击，不必开菜单）。同一个动作留两个入口只会让菜单更长、更难扫
            {
              id: "move",
              label: t.sidebar.moveTo,
              icon: "folder",
              keepOpen: true,
              onSelect: () => setStep("move"),
            },
            {
              id: "export",
              label: t.sidebar.exportMarkdown,
              icon: "download",
              onSelect: () => session.exportSession(meta.id),
            },
            // Unarchive 不确认（一步）：它本身就是一次恢复，再问一遍是白收一道必答题。
            // Archive 走两段式（同 Delete）：它把会话从主列表拿走，点错了不在原处。
            meta.archived
              ? {
                  id: "archive",
                  label: t.sidebar.unarchive,
                  icon: "archive-restore" as const,
                  onSelect: () => session.archiveSession(meta.id, false),
                }
              : {
                  id: "archive",
                  label: t.sidebar.archive,
                  icon: "archive" as const,
                  keepOpen: true,
                  onSelect: () => setStep("archive"),
                },
            // 批量清理：收走全部已完成的会话。入口随处可点（清理不挑入口），但
            // 数量与后果写在文案里，且与删除一样走两段式——批量动作先讲清楚再动
            ...(doneCount > 0
              ? [
                  {
                    id: "archive-done",
                    label: t.sidebar.archiveAllDone(doneCount),
                    icon: "archive" as const,
                    keepOpen: true,
                    onSelect: () => setStep("archive-done"),
                  },
                ]
              : []),
            {
              id: "delete",
              label: t.sidebar.deleteTask,
              icon: "trash-2",
              danger: true,
              keepOpen: true,
              onSelect: enterDeleteStep,
            },
          ];

  return (
    <div className="task-row" style={{ display: "flex", alignItems: "center", gap: 2 }}>
      {editing ? (
        <span style={{ flex: 1, minWidth: 0, padding: "var(--space-1)" }}>
          <InlineName
            editing
            value={meta.title}
            onCommit={(value) => {
              setEditing(false);
              session.renameSession(meta.id, value);
            }}
            onCancel={() => setEditing(false)}
            style={{ height: 22, fontSize: "var(--font-size-control)" }}
          >
            {null}
          </InlineName>
        </span>
      ) : (
        <NavRow
          icon={status?.icon ?? null}
          label={meta.title === "" ? t.common.newTask : meta.title}
          tone={status?.tone}
          spin={status?.spin ?? false}
          iconTitle={status?.label}
          active={props.active}
          onClick={props.onClick}
          style={{ flex: 1, minWidth: 0 }}
        />
      )}
      {/**
        星标：**既是标识也是开关**，独立小槽，不占状态位——状态位归运行态
        （running/failed/idle），置顶已占了 idle 档，再挤进去就要三选一。
        已星标常显（实心，**accent 色**），未星标只在悬停/键盘聚焦时浮出描边形（tertiary）——
        列表静止时不摆一排灰星星。星标用 accent 是 wafo 2026-09-22 的裁决（「主题的 accent
        是什么色就是什么色」）：它是用户亲手点亮的标记，靠颜色一眼找到是它的全部目的，
        与「accent 只给主操作」的冲突在于：它不是操作入口，是状态。
      */}
      <IconButton
        label={meta.starred === true ? t.sidebar.unstar : t.sidebar.star}
        title={meta.starred === true ? t.sidebar.starredTip : t.sidebar.star}
        size={20}
        onClick={() => session.starSession(meta.id, meta.starred !== true)}
        className="reveal"
        style={{
          borderRadius: "var(--radius-xs)",
          color: meta.starred === true ? "var(--color-accent)" : "var(--color-text-tertiary)",
          // 已星标常显，不等 hover / 键盘聚焦
          opacity: meta.starred === true ? 1 : undefined,
        }}
      >
        <Icon name="star" size={13} strokeWidth={1.8} fill={meta.starred === true} />
      </IconButton>
      {/**
        完成标记：**与星标同一条行内标记规则**（wafo 2026-09-22，「之后的标也沿用这个逻辑」）：
        hover / 键盘聚焦时浮出描边勾（tertiary），点一下即落定；落定后常显、accent；再点 = Reopen。
        图标是单纯的 `check`，不是圈勾——行首状态槽不再画完成，勾只在这里出现一次。
        tooltip 兼任闲置建议：超过 7 天没动静的任务，建议写在这个开关的 tooltip 里，
        不另摆一个建议按钮。done_with_todos 不换这里的图标——完成就是完成，
        「还差几件」由右边那个灯泡角标单独说。
      */}
      <IconButton
        label={done ? t.sidebar.reopen : t.sidebar.markDone}
        title={
          done
            ? openTodos > 0
              ? t.sidebar.doneWithTodos(openTodos)
              : t.sidebar.doneTip
            : idleSuggested
              ? t.sidebar.idleSuggest(IDLE_SUGGEST_DAYS)
              : t.sidebar.markDone
        }
        size={20}
        onClick={() =>
          session.setCompletionSession(meta.id, nextCompletion(meta.completion ?? "open"))
        }
        className="reveal"
        style={{
          borderRadius: "var(--radius-xs)",
          color: done ? "var(--color-accent)" : "var(--color-text-tertiary)",
          // 已完成常显，不等 hover / 键盘聚焦
          opacity: done ? 1 : undefined,
        }}
      >
        <Icon name="check" size={13} strokeWidth={done ? 3 : 1.8} />
      </IconButton>
      {/**
        遗留角标：完成标记右边的一个数字——收尾时扫出来、这条会话还没办的事项数
        （按 sourceSessionId 现算，与 Has todos 筛选同口径），办完就消失。
        **不再画第二个 circle-check**：完成这件事左边那个标记已经说了，
        角标只补「还差几件」这一句。槽序：星 → 完成 → 角标。
      */}
      {done && openTodos > 0 && (
        <span
          title={t.sidebar.openTodosLeft(openTodos)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 2,
            flex: "0 0 auto",
            marginInlineStart: -2,
            fontFamily: "var(--font-family-business)",
            fontSize: "var(--font-size-micro)",
            fontWeight: "var(--weight-semibold)",
            lineHeight: 1,
            color: "var(--color-text-secondary)",
          }}
        >
          {/* 灯泡与「Has todos」筛选同一个符号：光看数字读不出它数的是什么 */}
          <Icon name="lightbulb" size={12} strokeWidth={1.8} />
          {openTodos}
        </span>
      )}
      <Menu
        items={items}
        align="end"
        // 会话行的菜单开在**行的右侧**：开在下方会盖住紧挨着的下一条会话，
        // 想看别的会话就得先关菜单（2026-09-22 wafo）。窄窗右侧装不下时
        // placeMenu 自己回落到下方。宽度按 Proma 的行动作菜单收到 160，上限 240：
        // 200 装不下「Delete permanently」+ 工作台文件数 hint，label 会被截成半句
        placement="right"
        panelMinWidth={160}
        panelMaxWidth={240}
        trigger={({ open, toggle }) => (
          <IconButton
            label={t.sidebar.taskActions}
            size={20}
            onClick={() => {
              exitDeleteStep();
              toggle();
            }}
            className="reveal"
            style={{
              borderRadius: "var(--radius-xs)",
              color: open ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              // 菜单开着时常显，不等 hover / 键盘聚焦
              opacity: open ? 1 : undefined,
            }}
          >
            <Icon name="ellipsis-vertical" size={13} />
          </IconButton>
        )}
      />
    </div>
  );
}

/**
 * 遗留事项面板（侧栏的 Carryovers 视图）：按来源会话分组，每条可勾办结、
 * 可跳回来源会话、可带上下文开工（左键新开一单 / 右键续跑原会话）。
 * **勾选即写盘**（carryoverSetStatus），角标与筛选跟着引擎缓存自动刷新；
 * 跳回原文今天只到「跳到那条会话」——滚动定位到 sourceMessageRange 首条
 * 需要消息序号 → DOM 的定位基建，还没有第二处消费者，先不做（TODO：
 * 「跳回原文」的滚动定位，等定位基建立项后接 sourceMessageRange[0]）。
 */
function CarryoverPanel(props: {
  carryovers: readonly Carryover[];
  sessions: readonly SessionMeta[];
  onSetStatus: (id: string, status: Carryover["status"]) => void;
  /** 方案 A：新开一单带上下文开工（面板主入口） */
  onResumeNew: (item: Carryover) => void;
  /** 方案 B：以遗留事项为用户消息续跑原会话（同一按钮的右键备选） */
  onResumeInSource: (item: Carryover) => void;
  onOpenTask: (sessionId: string) => void;
  /** 显式出口：标题行左端的返回键 */
  onBack: () => void;
}) {
  const t = useT();
  const groups = groupCarryovers(props.carryovers, props.sessions);
  /**
   * 标题行左端的返回键是本面板的**显式出口**（与 Archived 同款）：出去不该只能
   * 再点一次底部那条 toggle——它既不像一个「返回」，又会在清单空了时禁用。
   */
  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
      <IconButton
        label={t.sidebar.backToTasks}
        title={t.sidebar.backToTasksTip}
        size={20}
        onClick={props.onBack}
        style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-secondary)" }}
      >
        <Icon name="chevron-left" size={13} strokeWidth={1.8} />
      </IconButton>
      <NodeLabel>{t.sidebar.carryovers}</NodeLabel>
    </div>
  );
  if (groups.length === 0) {
    return (
      <>
        {header}
        <Empty>{t.sidebar.noCarryovers}</Empty>
      </>
    );
  }
  return (
    <>
      {header}
      {groups.map((group) => (
        <div
          key={group.session?.id ?? group.items[0]?.sourceSessionId}
          style={{ marginBottom: "var(--space-3)" }}
        >
          {/**
            组头就是来源会话：标题可点（跳回原文），来源已删的组换占位标题、
            不可点。全组办结的组仍列出（办结的是历史，不是消失）。
          */}
          <button
            type="button"
            disabled={group.session === null}
            onClick={() => {
              if (group.session !== null) props.onOpenTask(group.session.id);
            }}
            title={group.session === null ? t.sidebar.sourceDeleted : t.sidebar.openSource}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              width: "100%",
              minHeight: 28,
              padding: 0,
              border: 0,
              background: "transparent",
              textAlign: "left",
              cursor: group.session === null ? "default" : "pointer",
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-control)",
              fontWeight: "var(--weight-semibold)",
              color:
                group.session === null
                  ? "var(--color-text-tertiary)"
                  : "var(--color-text-primary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {group.session === null ? (
              <Icon name="circle-off" size={13} strokeWidth={1.8} />
            ) : (
              <Icon name="message-square" size={13} strokeWidth={1.8} />
            )}
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
              {group.session === null
                ? t.sidebar.deletedTask
                : group.session.title === ""
                  ? t.common.newTask
                  : group.session.title}
            </span>
          </button>
          {group.items.map((item) => (
            <CarryoverRow
              key={item.id}
              item={item}
              canJump={group.session !== null}
              canResume={canResumeInSource(item, props.sessions)}
              onSetStatus={props.onSetStatus}
              onResumeNew={() => props.onResumeNew(item)}
              onResumeInSource={() => props.onResumeInSource(item)}
              onJump={() => {
                if (group.session !== null) props.onOpenTask(group.session.id);
              }}
            />
          ))}
        </div>
      ))}
    </>
  );
}

/** 面板里的一条遗留事项：勾选办结 / 标题 / 摘录 / 带上下文开工 / 跳回原文。 */
function CarryoverRow(props: {
  item: Carryover;
  canJump: boolean;
  /** 方案 B 可用：来源会话在且有 pi 本子（导入的只读会话没有，右键不拦截） */
  canResume: boolean;
  onSetStatus: (id: string, status: Carryover["status"]) => void;
  onResumeNew: () => void;
  onResumeInSource: () => void;
  onJump: () => void;
}) {
  const t = useT();
  const { item } = props;
  const done = item.status === "done";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0,1fr) auto",
        gap: "var(--space-2)",
        alignItems: "start",
        padding: "var(--space-1) var(--space-2) var(--space-1) var(--space-1)",
        borderRadius: "var(--radius-sm)",
        minHeight: "var(--control-height-md)",
      }}
    >
      <input
        type="checkbox"
        checked={done}
        aria-label={item.title}
        title={done ? t.sidebar.reopenItem : t.sidebar.markItemDone}
        onChange={(event) => props.onSetStatus(item.id, event.target.checked ? "done" : "open")}
        style={{ marginTop: 3, accentColor: "var(--color-accent)" }}
      />
      <div style={{ minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: "var(--font-size-control)",
            color: done ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
            textDecoration: done ? "line-through" : "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {item.title}
        </span>
        {item.detail !== "" && (
          <span
            title={item.detail}
            style={{
              display: "block",
              fontSize: "var(--font-size-micro)",
              lineHeight: "var(--line-height-caption)",
              color: "var(--color-text-tertiary)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {item.detail}
          </span>
        )}
      </div>
      {/**
        带上下文开工：左键新开一单（主入口，键盘可达），右键续跑原会话（备选，
        不可用时右键不拦截——原生菜单出来，诚实）。办结的行也能开工：勾了又想
        跟进是合法场景。tooltip 把右键那半句讲出来（设计系统：tooltip 讲完句子
        的另一半）。
      */}
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <IconButton
          label={t.sidebar.continueWithContext}
          title={
            props.canResume
              ? t.sidebar.continueTipResumable
              : t.sidebar.continueTip
          }
          size={20}
          onClick={props.onResumeNew}
          onContextMenu={
            props.canResume
              ? (event) => {
                  event.preventDefault();
                  props.onResumeInSource();
                }
              : undefined
          }
          style={{ color: "var(--color-text-secondary)" }}
        >
          <Icon name="corner-up-right" size={11} strokeWidth={1.8} />
        </IconButton>
        {/**
          跳回原文：今天只到「跳到那条会话」——滚动定位到 sourceMessageRange 首条
          需要消息序号→DOM 的定位基建，还没有第二处消费者（TODO，见 CarryoverPanel）。
        */}
        <IconButton
          label={t.sidebar.jumpToSource}
          title={props.canJump ? t.sidebar.jumpToSourceTip : t.sidebar.sourceDeleted}
          size={20}
          disabled={!props.canJump}
          onClick={props.onJump}
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <Icon name="corner-down-left" size={11} strokeWidth={1.8} />
        </IconButton>
      </span>
    </div>
  );
}

function Empty(props: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "var(--space-2) 0",
        padding: "0 var(--space-1)",
        fontSize: "var(--font-size-caption)",
        lineHeight: "var(--line-height-caption)",
        color: "var(--color-text-secondary)",
      }}
    >
      {props.children}
    </p>
  );
}

/**
 * 列表加载失败的就地错误行。**失败要长成失败的样子**——吞成空列表会让用户
 * 以为记录丢了；这一行给出原因和一个重试入口，恢复不需要重新找路。
 */
function ListError(props: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <p
      style={{
        margin: "var(--space-2) 0",
        padding: "0 var(--space-1)",
        display: "flex",
        alignItems: "baseline",
        gap: 6,
        flexWrap: "wrap",
        fontSize: "var(--font-size-caption)",
        lineHeight: "var(--line-height-caption)",
        color: "var(--color-text-secondary)",
      }}
    >
      <Icon
        name="triangle-alert"
        size={12}
        strokeWidth={1.8}
        style={{ color: "var(--color-danger)", flex: "0 0 auto", alignSelf: "center" }}
      />
      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{props.message}</span>
      <button
        type="button"
        onClick={props.onRetry}
        style={{
          border: 0,
          background: "transparent",
          padding: 0,
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-caption)",
          color: "var(--color-text-primary)",
          textDecoration: "underline",
          cursor: "pointer",
        }}
      >
        {t.common.retry}
      </button>
    </p>
  );
}

/**
 * 折叠图标条上的按钮（设计系统 components/navigation/RailButton）：
 * 48px rail 里的 32px 方块，**tooltip 是它唯一的标签**。
 * 当前项用模式选中色（R4-03 修正：明蓝暗黄，图标条当前项同款）；
 * accent 只给 New task 这个主操作。
 */
function RailButton(props: {
  icon: IconName;
  title: string;
  active?: boolean;
  accent?: boolean;
  onClick?: () => void;
}) {
  const active = props.active === true;
  const accent = props.accent === true;
  return (
    <button
      type="button"
      className="quiet-control rail-btn"
      title={props.title}
      aria-label={props.title}
      aria-pressed={active || accent ? true : undefined}
      data-accent={accent || undefined}
      onClick={props.onClick}
      style={{
        display: "grid",
        placeItems: "center",
        width: 32,
        height: 32,
        flex: "0 0 auto",
        border: 0,
        borderRadius: "var(--radius-md)",
        cursor: "pointer",
      }}
    >
      <Icon name={props.icon} size={16} />
    </button>
  );
}

/**
 * 模式选择。**不走 `selection.ts` 那条通用规则**——设计系统 readme 点名了它：
 * 「the selected mode reads blue on the light theme and yellow on the dark」，
 * 它的选中是 accent **文字**，不是 accent 底 + 墨色字。
 */
function ModeChip(props: {
  icon: IconName;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      title={props.title}
      className="quiet-control mode-tab"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        flex: 1,
        minWidth: 0,
        padding: "4px 8px",
        border: 0,
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontWeight: "var(--weight-medium)",
        whiteSpace: "nowrap",
      }}
    >
      <Icon name={props.icon} size={14} />
      {props.children}
    </button>
  );
}
