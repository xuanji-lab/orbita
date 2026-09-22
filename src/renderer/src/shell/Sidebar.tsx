import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { Chip } from "./Chip";
import { selectionStyle } from "./selection";
import { InlineName } from "./InlineName";
import { Menu, type MenuItem } from "./Menu";
import type { ChatSession } from "../features/chat/useChatSession";
import { isSessionDone, type SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from "@shared/settings";
import { SETTINGS_TABS, type SettingsTab } from "../features/settings/SettingsView";
import { describeList } from "../features/chat/load-state.ts";
import { shouldExitArchived } from "./archived-view.ts";
import { nextCompletion } from "./completion-mark.ts";
import {
  SESSIONS_PREVIEW_LIMIT,
  TASKS_FOLD_KEY,
  foldKeyForWorkspace,
  toggleGroupFold,
  toggleGroupFull,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";

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

/**
 * 归档后那条撤销提示待多久。**归档走「先做、给一个撤销」而不是「先问再做」**：
 * 归档不是删除，数据一条不少，为它摆一个模态确认是拿一次必答题去换一次误操作；
 * 撤销把代价放在真的点错的那几秒里，而不是每一次归档上。
 * 6 秒是「看一眼列表发现不对」够用、又不至于在侧栏底部常驻一条的长度。
 */
const ARCHIVE_UNDO_MS = 6000;

/** 完成状态筛选的单选组三档：全部 / 进行中 / 已完成（Starred 是叠加开关，正交） */
type StatusFilter = "all" | "active" | "done";

/**
 * 筛选扑空的空态文案：按激活的组合说清「为什么什么都没有、怎么才有」，
 * 不给一条对不上当前筛选的提示。
 */
function filterEmptyText(status: StatusFilter, starredOnly: boolean): string {
  if (status === "active")
    return starredOnly
      ? "No active starred tasks. Clear the Starred filter to see the rest."
      : "No active tasks right now — everything is done.";
  if (status === "done")
    return starredOnly
      ? "No starred tasks done yet."
      : "No done tasks yet. Mark a task done from its menu to find it here.";
  return "No starred tasks yet. Hover a task and click its star to find it here.";
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
  /** 当前宽度（px）。拖动中由调用方只改本地 state，松手才落 settings */
  width: number;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
}) {
  const { session } = props;
  const asideRef = useRef<HTMLElement | null>(null);
  /** 拖宽中禁掉 width 过渡——实时跟手（同右侧面板的 .dragging 纪律） */
  const [resizing, setResizing] = useState(false);
  const settingsOpen = props.overlay === "settings";
  const [showArchived, setShowArchived] = useState(false);
  /**
   * 刚归档的那一条（带标题，提示里要说清楚收走的是谁）。`null` = 没有待撤销的动作。
   * 只记一条：连着归两条时后一条顶掉前一条的提示——堆栈式撤销要在侧栏底部堆一叠条，
   * 而「刚手滑了一下」要撤的总是最后那一下。
   */
  const [undo, setUndo] = useState<{ id: string; title: string } | null>(null);
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
  /** 归档的从主列表里移走——**不是删除**，它们收在底部那一行后面 */
  const live = session.sessions.filter((m) => !m.archived);
  const archived = session.sessions.filter((m) => m.archived);
  /**
   * 归档空了就自动退回主列表——否则停在一个空视图里，而唯一的出口（底部
   * 「Archived (N)」）正好因为 N 为 0 而禁用。判定与理由在 `archived-view.ts`。
   */
  useEffect(() => {
    if (shouldExitArchived(showArchived, archived.length)) setShowArchived(false);
  }, [showArchived, archived.length]);
  /** 撤销提示自己会走：6 秒后消失，不需要用户关它。新的归档重置计时。 */
  useEffect(() => {
    if (undo === null) return;
    const timer = window.setTimeout(() => setUndo(null), ARCHIVE_UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [undo]);
  /**
   * 归档 / 取消归档都走这里，为的是归档那一下能顺手挂上撤销。
   * 取消归档不需要撤销（它本身就是一次恢复），顺手清掉旧提示。
   */
  const setArchived = (meta: SessionMeta, next: boolean): void => {
    session.archiveSession(meta.id, next);
    setUndo(next ? { id: meta.id, title: meta.title } : null);
  };
  // 两个节点各自的读取进度：加载中 / 读失败 / 真的空（D-3）
  const workspaceList = describeList(session.loads.workspaces, session.workspaces.length);
  const sessionList = describeList(session.loads.sessions, session.sessions.length);
  /**
   * 主列表的筛选管线（筛选区 chips）。状态（All/Active/Done，单选组）与星标
   * （叠加开关）两条正交条件串在同一个 filter 里；组语义：状态三选一互斥，
   * Starred 可与任一状态叠加（如「进行中且星标」）。**只作用于主浏览列表**
   * ——Archived 是存储位置视图，不受（也不该隐形地受）筛选。
   */
  const filtered = statusFilter !== "all" || starredOnly;
  const scoped = live.filter((m) => {
    if (statusFilter === "active" && isSessionDone(m)) return false;
    if (statusFilter === "done" && !isSessionDone(m)) return false;
    if (starredOnly && m.starred !== true) return false;
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

  // —— 折叠态：48px 图标条（RailButton 规格：32px 方块、tooltip 即标签、
  // 底部 archive + settings 簇）。折叠期间列表不可达，要切会话先展开。
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
        <RailButton icon="panel-left" title="Expand sidebar" onClick={() => setCollapsed(false)} />
        <RailButton
          icon="plus"
          title="New task"
          accent
          onClick={startNewTask}
        />
        <span style={{ flex: 1 }} />
        <RailButton
          icon="archive"
          title={`Archived (${session.sessions.filter((m) => m.archived).length})`}
          active={showArchived && !settingsOpen}
          onClick={() => {
            setCollapsed(false);
            setShowArchived(true);
          }}
        />
        <RailButton
          icon="settings"
          title="Settings"
          active={settingsOpen}
          onClick={() => {
            setCollapsed(false);
            props.onOverlay("settings");
          }}
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
          label="Collapse sidebar"
          title="Collapse to the icon rail"
          size={24}
          onClick={() => setCollapsed(true)}
          style={{ marginInlineStart: "auto", color: "var(--color-text-tertiary)" }}
        >
          <Icon name="panel-left" size={14} />
        </IconButton>
      </div>

      <div role="tablist" style={{ display: "flex", gap: 4 }}>
        <ModeChip icon="bot" active>
          Agent mode
        </ModeChip>
        <ModeChip icon="workflow" disabled title="Orchestration mode (planned)">
          Orchestrate
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
        New task
      </button>

      {/**
        筛选区：会话浏览的过滤 chips。状态是单选组（All / Active / Done 互斥，
        点一个顶掉另一个），Starred 是叠加开关——两者正交，可组合出
        「进行中且星标」这样的视图。**只在主列表视图显示**，且没有任何会话时
        筛选无从谈起，不摆。
      */}
      {live.length > 0 && !settingsOpen && !showArchived && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Chip
            icon="list"
            active={statusFilter === "all"}
            title="All tasks"
            onClick={() => setStatusFilter("all")}
          >
            All
          </Chip>
          <Chip
            icon="play"
            active={statusFilter === "active"}
            title="Tasks still in progress"
            onClick={() => setStatusFilter("active")}
          >
            Active
          </Chip>
          <Chip
            icon="circle-check"
            active={statusFilter === "done"}
            title="Completed tasks"
            onClick={() => setStatusFilter("done")}
          >
            Done
          </Chip>
          <Chip
            icon="star"
            active={starredOnly}
            title="Show starred tasks only"
            onClick={() => setStarredOnly((value) => !value)}
          >
            Starred
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
        {showArchived && !settingsOpen ? (
          <>
            {/*
              标题行左端的返回键是 Archived 视图的**显式出口**。以前出去只能再点一次
              底部那条 toggle，而它既不像一个「返回」，又会在归档空了时禁用。
              这是一个子视图，子视图就该在它自己的标题旁边带着回去的路。
            */}
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
              <IconButton
                label="Back to tasks"
                title="Back to the task list"
                size={20}
                onClick={() => setShowArchived(false)}
                style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-secondary)" }}
              >
                <Icon name="chevron-left" size={13} strokeWidth={1.8} />
              </IconButton>
              <NodeLabel>Archived</NodeLabel>
            </div>
            {archived.map((meta) => (
              <SessionRow
                key={meta.id}
                meta={meta}
                session={session}
                active={meta.id === openId}
                onClick={() => open(meta.id)}
                onArchive={(next) => setArchived(meta, next)}
              />
            ))}
          </>
        ) : settingsOpen ? (
          <>
            <NodeLabel>Settings</NodeLabel>
            {SETTINGS_TABS.map((tab) => (
              <NavRow
                key={tab.id}
                icon={tab.icon}
                label={tab.label}
                active={props.settingsTab === tab.id}
                onClick={() => props.onSettingsTab(tab.id)}
              />
            ))}
          </>
        ) : filtered && scoped.length === 0 ? (
          /* 筛选扑空：一条空态说清「为什么什么都没有、怎么才有」，而非留白两节空头 */
          <Empty>{filterEmptyText(statusFilter, starredOnly)}</Empty>
        ) : (
          <>
            {(!filtered || workspaceMatches.length > 0) && (
              <>
                <NodeHeader
                  label="Workspaces"
                  addLabel="Add a workspace folder"
                  addIcon="folder-plus"
                  onAdd={session.addWorkspace}
                />
                {/*
                  读失败时错误行贴在列表上方，旧列表照常列（失败不清空手里那份）；
                  只有从没读成功过才是空空的错误行 + 什么都不列（none）。
                */}
                {workspaceList.error !== null && (
                  <ListError message={workspaceList.error} onRetry={session.reloadWorkspaces} />
                )}
                {workspaceList.body === "loading" ? (
                  <Empty>Loading workspaces…</Empty>
                ) : workspaceList.body === "empty" ? (
                  <Empty>No workspace yet. Add the folder the agent may read.</Empty>
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
                      onArchive={setArchived}
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
                  label="Tasks"
                  addLabel="New task"
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
                  <Empty>Loading tasks…</Empty>
                ) : sessionList.body === "none" ? null : sessionList.body === "empty" ? (
                  <Empty>No task yet. The one you start lands here.</Empty>
                ) : tasksFolded ? null : (
                  <>
                    {looseVisible.map((meta) => (
                      <SessionRow
                        key={meta.id}
                        meta={meta}
                        session={session}
                        active={meta.id === openId}
                        onClick={() => open(meta.id)}
                        onArchive={(next) => setArchived(meta, next)}
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

      {/*
        刚归档了什么的轻提示，压在 Archived 行上方——动作的去处就在它下面一行，
        「收到哪了」不需要另外解释。只在主列表与 Archived 视图里出，不压到 Settings 上。
      */}
      {undo !== null && !settingsOpen && (
        <UndoStrip
          title={undo.title}
          onUndo={() => {
            session.archiveSession(undo.id, false);
            setUndo(null);
          }}
        />
      )}
      {/* 整条可点，不是只有图标可点——和 New task 一样是一整根横条 */}
      {/*
        归档不是删除：它把会话从主列表移走，收在这一行后面。
        一条都没有时禁用——一个点了什么都不发生的入口比禁用更让人困惑。
        **但正在 Archived 视图里时永不禁用**：那时它不是「进去」而是「出来」，
        把人关在里面的正是这一句禁用（main 上的 bug）。
      */}
      <NavRow
        icon="archive"
        label={`Archived (${archived.length})`}
        hint={
          showArchived
            ? "Back to the task list"
            : archived.length === 0
              ? "Nothing archived yet"
              : "Archived tasks"
        }
        active={showArchived && !settingsOpen}
        disabled={archived.length === 0 && !showArchived}
        onClick={() => setShowArchived((value) => !value)}
      />
      <NavRow
        icon="settings"
        label="Settings"
        active={settingsOpen}
        onClick={() => props.onOverlay(settingsOpen ? null : "settings")}
      />
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
      title="Drag to resize · double-click to reset"
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
  /** 归档走侧栏那一层（它要顺手挂撤销提示），不在行里直接改存储 */
  onArchive: (meta: SessionMeta, next: boolean) => void;
}) {
  const [hover, setHover] = useState(false);
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
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => {
        setHover(false);
        setArmed(false);
      }}
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
            label={props.folded ? "Expand group" : "Collapse group"}
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
            title={`${props.workspace.path} · double-click to rename`}
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
          label={armed ? "Remove from the list? Click again." : "Remove from the list"}
          title={
            armed
              ? "Click again to remove. The folder and its tasks stay — the tasks move to Tasks."
              : "Remove from the list. The folder on disk is not touched."
          }
          size={20}
          onClick={() => (armed ? props.onRemove() : setArmed(true))}
          style={{
            borderRadius: "var(--radius-xs)",
            color: armed ? "var(--color-danger)" : "var(--color-text-tertiary)",
            opacity: hover || armed ? 1 : 0,
            transition: "opacity var(--duration-instant) var(--ease-standard)",
          }}
        >
          <Icon name="trash-2" size={11} />
        </IconButton>

        <IconButton label="New task in this workspace" size={26} onClick={props.onNewTask}>
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
              onArchive={(next) => props.onArchive(meta, next)}
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
  onAdd: () => void;
  /** 传了 onToggleFold 就说明这个节点的孩子可折叠：label 变成开合按钮（chevron + 名字） */
  folded?: boolean;
  onToggleFold?: (() => void) | undefined;
}) {
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
      <IconButton label={props.addLabel} size={26} onClick={props.onAdd}>
        <Icon name={props.addIcon} size={14} />
      </IconButton>
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
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      aria-expanded={!props.folded}
      onClick={props.onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        minWidth: 0,
        minHeight: 28,
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-xs)",
        background: hover ? "var(--option-hover-bg)" : "transparent",
        cursor: "pointer",
        textAlign: "left",
        transition: "var(--transition-hover)",
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
  return (
    <NavRow
      icon={props.full ? "chevron-up" : "chevron-down"}
      label={props.full ? "Show less" : `Show ${props.hidden} more`}
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
 * 里一处定义，选中态的两个候选与取舍也写在那儿。
 */
function NavRow(props: {
  icon: IconName;
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
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const clickable = !disabled && props.onClick !== undefined;
  return (
    <button
      type="button"
      title={props.hint}
      disabled={disabled}
      aria-pressed={clickable ? props.active : undefined}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        ...selectionStyle({ selected: props.active, hover: hover && clickable, disabled }),
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
        <Icon name={props.icon} size={13} strokeWidth={1.8} spin={props.spin ?? false} />
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
  /** 翻归档位。行里不直接调 store：归档要带出一条撤销提示，而那条提示住在侧栏底部 */
  onArchive: (next: boolean) => void;
}) {
  const { meta, session } = props;
  const [hover, setHover] = useState(false);
  /**
   * 行内有东西拿到**键盘**焦点。悬停出现的键必须也为键盘出现——只认 hover 的话，
   * Tab 到星标键时它还是 opacity 0，焦点环落在一个看不见的方块上。
   * **只认 :focus-visible**：鼠标点星也会让按钮拿到焦点，若认普通 focus，点过的那行会
   * 一直挂着描边星直到焦点走开（wafo 2026-09-22 实测：「点了别的行，之前那个描边星才消失」）。
   * React 的 onFocus/onBlur 走 focusin/focusout，会从子节点冒上来。
   */
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<"main" | "move" | "delete" | "archive-done">("main");
  const live = meta.id === session.sessionId;
  // 行的运行态查它自己的槽：后台在跑的会话切走了也照样转圈，与「当前看哪条」无关
  const running = session.phaseOf(meta.id) !== "idle";
  // 失败同样查槽：后台会话重试耗尽（turnError）也亮 Failed，不止正看着的那条
  const failed = !running && (session.turnErrorOf(meta.id) !== null || (live && session.error !== null));
  /**
   * 置顶图标**只顶替 idle 那一档**。正在跑或失败时状态优先——
   * 置顶是用户的偏好，运行中是正在发生的事，后者更该被看见。
   */
  const idle = !(running || failed);
  const done = isSessionDone(meta);
  // 批量归档的目标数（清理入口随处可点，但只收已完成且未归档的）
  const doneCount = session.sessions.filter(
    (m) => isSessionDone(m) && !m.archived,
  ).length;
  /**
   * 闲置建议：open 且未归档、最后一次活动超过 7 天——纯派生（每次渲染按
   * updatedAt 现算，不落盘），hover 才出现的一个轻提示，不弹通知不加角标。
   */
  const idleSuggested = !done && !meta.archived && Date.now() - meta.updatedAt > IDLE_SUGGEST_MS;
  const status = running
    ? { icon: "loader-circle" as const, tone: "var(--color-accent)", label: "Running", spin: true }
    : failed
      ? { icon: "triangle-alert" as const, tone: "var(--color-danger)", label: "Failed", spin: false }
      : { icon: "check" as const, tone: "var(--color-text-tertiary)", label: "Idle", spin: false };

  const items: MenuItem[] =
    step === "delete"
      ? [
          { id: "cancel", label: "Cancel", icon: "x", keepOpen: true, onSelect: () => setStep("main") },
          {
            id: "confirm",
            label: "Delete permanently",
            icon: "trash-2",
            danger: true,
            onSelect: () => session.removeSession(meta.id),
          },
        ]
      : step === "archive-done"
        ? [
            { id: "cancel", label: "Cancel", icon: "x", keepOpen: true, onSelect: () => setStep("main") },
            {
              id: "confirm",
              label: `Archive ${doneCount} done task${doneCount === 1 ? "" : "s"}`,
              icon: "archive",
              onSelect: () => session.archiveDoneSessions(),
            },
          ]
        : step === "move"
        ? [
            {
              id: "none",
              label: "No workspace",
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
            { id: "rename", label: "Rename", icon: "pencil-line", onSelect: () => setEditing(true) },
            {
              id: "pin",
              label: meta.pinned ? "Unpin" : "Pin to top",
              icon: meta.pinned ? "pin-off" : "pin",
              onSelect: () => session.pinSession(meta.id, !meta.pinned),
            },
            // Star / Unstar 与 Mark done / Reopen 都不在这儿——它们已经是行上的悬停标记
            // （一次点击，不必开菜单）。同一个动作留两个入口只会让菜单更长、更难扫
            {
              id: "move",
              label: "Move to…",
              icon: "folder",
              keepOpen: true,
              onSelect: () => setStep("move"),
            },
            {
              id: "export",
              label: "Export as Markdown…",
              icon: "download",
              onSelect: () => session.exportSession(meta.id),
            },
            {
              id: "archive",
              label: meta.archived ? "Unarchive" : "Archive",
              icon: meta.archived ? "archive-restore" : "archive",
              onSelect: () => props.onArchive(meta.archived !== true),
            },
            // 批量清理：收走全部已完成的会话。入口随处可点（清理不挑入口），但
            // 数量与后果写在文案里，且与删除一样走两段式——批量动作先讲清楚再动
            ...(doneCount > 0
              ? [
                  {
                    id: "archive-done",
                    label: `Archive all done (${doneCount})…`,
                    icon: "archive" as const,
                    keepOpen: true,
                    onSelect: () => setStep("archive-done"),
                  },
                ]
              : []),
            {
              id: "delete",
              label: "Delete task…",
              icon: "trash-2",
              danger: true,
              keepOpen: true,
              onSelect: () => setStep("delete"),
            },
          ];

  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 2 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={() => setFocused(false)}
    >
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
          icon={idle && meta.pinned ? "pin" : status.icon}
          label={meta.title === "" ? "New task" : meta.title}
          tone={idle && meta.pinned ? "var(--color-text-secondary)" : status.tone}
          spin={status.spin}
          iconTitle={idle && meta.pinned ? "Pinned" : status.label}
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
        label={meta.starred === true ? "Unstar this task" : "Star this task"}
        title={meta.starred === true ? "Starred · click to unstar" : "Star this task"}
        size={20}
        onClick={() => session.starSession(meta.id, meta.starred !== true)}
        style={{
          borderRadius: "var(--radius-xs)",
          color: meta.starred === true ? "var(--color-accent)" : "var(--color-text-tertiary)",
          opacity: meta.starred === true || hover || focused ? 1 : 0,
          transition: "opacity var(--duration-instant) var(--ease-standard)",
        }}
      >
        <Icon name="star" size={13} strokeWidth={1.8} fill={meta.starred === true} />
      </IconButton>
      {/**
        完成标记：**与星标同一条行内标记规则**（星在前、完成在后，并列同一槽）：
        行 hover / 键盘聚焦时浮出描边形（tertiary），点一下即落定；落定后常显、实心、accent，
        再点一下就是 Reopen。行与行互不影响。这是 wafo 2026-09-22 定下的通用规则
        （「之后的标也沿用这个逻辑」），不再为它单独发明一种交互。
        不占状态位、不随运行态消失；未完成是默认态，静止时不显——默认态不制造噪音。
        done_with_todos 本分支写不出来（遗留事项扫描在后面的 PR），它的专用图标等那时再接。
      */}
      <IconButton
        label={done ? "Reopen this task" : "Mark this task done"}
        title={done ? "Done · click to reopen" : "Mark this task done"}
        size={20}
        onClick={() =>
          session.setCompletionSession(meta.id, nextCompletion(meta.completion ?? "open"))
        }
        style={{
          borderRadius: "var(--radius-xs)",
          color: done ? "var(--color-accent)" : "var(--color-text-tertiary)",
          opacity: done || hover || focused ? 1 : 0,
          transition: "opacity var(--duration-instant) var(--ease-standard)",
        }}
      >
        <Icon name="circle-check" size={13} strokeWidth={1.8} fill={done} />
      </IconButton>
      {/**
        闲置建议：open 且未归档、最后一次活动超过 7 天的会话，hover 时出现的
        一个轻提示按钮——不弹通知、不打断、不加红点。点了就是普通 Mark done
        （可从菜单或头部 Reopen）。纯派生：不落盘、不设状态，渲染时按 updatedAt 现算。
      */}
      {idleSuggested && (
        <IconButton
          label="Mark done?"
          title={`No activity for ${IDLE_SUGGEST_DAYS}+ days — mark this task done?`}
          size={20}
          onClick={() => session.setCompletionSession(meta.id, "done")}
          style={{
            borderRadius: "var(--radius-xs)",
            color: "var(--color-text-tertiary)",
            opacity: hover || focused ? 1 : 0,
            transition: "opacity var(--duration-instant) var(--ease-standard)",
          }}
        >
          <Icon name="circle-check" size={12} strokeWidth={1.8} />
        </IconButton>
      )}
      <Menu
        items={items}
        align="end"
        // 会话行的菜单开在**行的右侧**：开在下方会盖住紧挨着的下一条会话，
        // 想看别的会话就得先关菜单（2026-09-22 wafo）。窄窗右侧装不下时
        // placeMenu 自己回落到下方。宽度按 Proma 的行动作菜单收到 160/200
        placement="right"
        panelMinWidth={160}
        panelMaxWidth={200}
        trigger={({ open, toggle }) => (
          <IconButton
            label="Task actions"
            size={20}
            onClick={() => {
              setStep("main");
              toggle();
            }}
            style={{
              borderRadius: "var(--radius-xs)",
              color: open ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              opacity: hover || open || focused ? 1 : 0,
              transition: "opacity var(--duration-instant) var(--ease-standard)",
            }}
          >
            <Icon name="ellipsis-vertical" size={13} />
          </IconButton>
        )}
      />
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
 * 归档后的撤销提示。**归档不弹确认框**：它不是删除，数据一条不少，
 * 为它摆一个必答题是把代价摄在每一次正确操作上；撤销把代价只留给真点错的那几秒。
 * 6 秒后自己走，不在侧栏底部留一个要人动手关的东西。
 *
 * 就地做成本地组件而不是通用 toast：仓里今天只有这一处需要它，
 * 第二个消费者出现之前不建抽象。
 */
function UndoStrip(props: { title: string; onUndo: () => void }) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: "2px 0",
        padding: "var(--space-1) var(--space-2)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-muted)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-caption)",
        lineHeight: "var(--line-height-caption)",
        color: "var(--color-text-secondary)",
      }}
    >
      <Icon name="archive" size={12} strokeWidth={1.8} />
      {/* 收走的是哪一条写在 tooltip 里：288px 的一行装不下标题，而它又不能没人说 */}
      <span
        title={props.title === "" ? "Archived a task" : `Archived · ${props.title}`}
        style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        Archived
      </span>
      <button
        type="button"
        onClick={props.onUndo}
        style={{
          flex: "0 0 auto",
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
        Undo
      </button>
    </div>
  );
}

/**
 * 列表加载失败的就地错误行。**失败要长成失败的样子**——吞成空列表会让用户
 * 以为记录丢了；这一行给出原因和一个重试入口，恢复不需要重新找路。
 */
function ListError(props: { message: string; onRetry: () => void }) {
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
        Retry
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
  const [hover, setHover] = useState(false);
  const active = props.active === true;
  const accent = props.accent === true;
  return (
    <button
      type="button"
      title={props.title}
      aria-label={props.title}
      aria-pressed={active || accent ? true : undefined}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        placeItems: "center",
        width: 32,
        height: 32,
        flex: "0 0 auto",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: active
          ? "var(--color-mode-active-bg)"
          : accent
            ? "var(--color-accent)"
            : hover
              ? "var(--option-hover-bg)"
              : "transparent",
        color: active
          ? "var(--color-mode-active-fg)"
          : accent
            ? "var(--color-accent-fg)"
            : hover
              ? "var(--color-text-primary)"
              : "var(--color-text-secondary)",
        cursor: "pointer",
        transition: "var(--transition-hover)",
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
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      title={props.title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
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
        background: active
          ? "var(--color-mode-active-bg)"
          : hover && !disabled
            ? "var(--option-hover-bg)"
            : "transparent",
        // 玻璃上的禁用态用实色 tertiary，不用 opacity
        color: active
          ? "var(--color-mode-active-fg)"
          : disabled
            ? "var(--color-text-tertiary)"
            : "var(--color-text-primary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontWeight: "var(--weight-medium)",
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      <Icon name={props.icon} size={14} />
      {props.children}
    </button>
  );
}
