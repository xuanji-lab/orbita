import { useEffect, useState, Fragment } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { selectionStyle } from "./selection";
import { InlineName } from "./InlineName";
import { Menu, type MenuItem } from "./Menu";
import type { ChatSession } from "../features/chat/useChatSession";
import type { SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { SETTINGS_TABS, type SettingsTab } from "../features/settings/SettingsView";
import { describeList } from "../features/chat/load-state.ts";
import {
  SESSIONS_PREVIEW_LIMIT,
  TASKS_FOLD_KEY,
  foldKeyForWorkspace,
  toggleGroupFold,
  toggleGroupFull,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";
import { splitByParent } from "./sidebar-tree.ts";

/** 中卡盖着的面。`null` = 聊天。三者互斥，所以是联合类型而不是几个 boolean。 */
export type Overlay = "settings" | null;

/** 窗口窄于这条线就自动折成图标条：288px 的侧栏在 960px 以下会把内容面挤得太瘦。 */
const COLLAPSE_BREAKPOINT = 960;

/**
 * 左栏，288px。**它自己没有面**——不填色、不描边、不分割线，直接坐在 layer 1 上，
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
}) {
  const { session } = props;
  const settingsOpen = props.overlay === "settings";
  const [showArchived, setShowArchived] = useState(false);
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
  // 两个节点各自的读取进度：加载中 / 读失败 / 真的空（D-3）
  const workspaceList = describeList(session.loads.workspaces, session.workspaces.length);
  const sessionList = describeList(session.loads.sessions, session.sessions.length);
  const loose = live.filter((m) => m.workspaceId === null || !known.has(m.workspaceId));
  // B-2：派出来的子会话挂父行下（组内两层树）；父不在场的子升为顶层（sidebar-tree.ts）
  const tasksTree = splitByParent(loose);
  const tasksFolded = groups.folds.has(TASKS_FOLD_KEY);
  // TASKS 的超长截断：默认列前 N 条，其余收进「Show N more」——截断只数顶层，
  // 子会话跟着自己的父行走（父被截掉，子就整支不可见；数两层会让 Show more 对不上）
  const tasksFull = groups.full.has(TASKS_FOLD_KEY);
  const tasksTopVisible = tasksFull ? tasksTree.top : tasksTree.top.slice(0, SESSIONS_PREVIEW_LIMIT);
  const open = (id: string) => {
    props.onOverlay(null);
    session.openSession(id);
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
    <aside
      style={{
        width: 288,
        flex: "0 0 288px",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-2) var(--space-3)",
        background: "transparent",
        overflow: "hidden",
        transition: "width var(--duration-fast) var(--ease-standard)",
      }}
    >
      {/*
        顶栏兼作标题栏：`titleBarStyle: "hidden"` 之后这是窗口唯一的可拖区域，
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
            <NodeLabel>Archived</NodeLabel>
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
        ) : (
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
              session.workspaces.map((workspace) => (
                <WorkspaceGroup
                  key={workspace.id}
                  workspace={workspace}
                  sessions={live.filter((m) => m.workspaceId === workspace.id)}
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
                    setGroups((current) => unfoldGroup(current, foldKeyForWorkspace(workspace.id)));
                    session.newTaskIn(workspace);
                  }}
                  onRename={(name) => session.renameWorkspace(workspace.id, name)}
                  onRemove={() => session.removeWorkspace(workspace.id)}
                  onOpen={open}
                />
              ))
            ) : null}

            {/*
              TASKS 节点列的是**落盘的会话**。今天全部会话都挂在这里而不是挂到
              **不属于任何工作区**的那些。这就是设计系统里 TASKS 与 WORKSPACES
              两个节点的区别，也是「+ New task」与工作区那个「+」的区别。
            */}
            <div style={{ marginTop: "var(--space-3)" }}>
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
                  {tasksTopVisible.map((meta) => (
                    <Fragment key={meta.id}>
                      <SessionRow
                        meta={meta}
                        session={session}
                        active={meta.id === openId}
                        onClick={() => open(meta.id)}
                      />
                      {tasksTree.childrenOf(meta.id).map((child) => (
                        <SessionRow
                          key={child.id}
                          meta={child}
                          session={session}
                          active={child.id === openId}
                          child
                          onClick={() => open(child.id)}
                        />
                      ))}
                    </Fragment>
                  ))}
                  {loose.length > SESSIONS_PREVIEW_LIMIT && (
                    <ShowAllRow
                      full={tasksFull}
                      hidden={loose.length - SESSIONS_PREVIEW_LIMIT}
                      onClick={() => setGroups((current) => toggleGroupFull(current, TASKS_FOLD_KEY))}
                    />
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>

      {/* 整条可点，不是只有图标可点——和 New task 一样是一整根横条 */}
      {/*
        归档不是删除：它把会话从主列表移走，收在这一行后面。
        一条都没有时禁用——一个点了什么都不发生的入口比禁用更让人困惑。
      */}
      <NavRow
        icon="archive"
        label={`Archived (${archived.length})`}
        hint={archived.length === 0 ? "Nothing archived yet" : "Archived tasks"}
        active={showArchived && !settingsOpen}
        disabled={archived.length === 0}
        onClick={() => setShowArchived((value) => !value)}
      />
      <NavRow
        icon="settings"
        label="Settings"
        active={settingsOpen}
        onClick={() => props.onOverlay(settingsOpen ? null : "settings")}
      />
    </aside>
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
  const [hover, setHover] = useState(false);
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 超过预览数只列前 N 条，其余收进「Show N more」；点了才全量铺开。
  // B-2：截断只数顶层，子会话跟着自己的父行走（同 TASKS 的口径）
  const tree = splitByParent(props.sessions);
  const truncated = !props.full && props.sessions.length > SESSIONS_PREVIEW_LIMIT;
  const visible = truncated ? tree.top.slice(0, SESSIONS_PREVIEW_LIMIT) : tree.top;

  const commit = () => {
    if (editing !== null) props.onRename(editing);
    setEditing(null);
  };

  return (
    <div
      style={{ padding: "var(--space-2) 0" }}
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
          minHeight: 28,
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
            <Fragment key={meta.id}>
              <SessionRow
                meta={meta}
                session={props.session}
                active={meta.id === props.openId}
                onClick={() => props.onOpen(meta.id)}
              />
              {tree.childrenOf(meta.id).map((child) => (
                <SessionRow
                  key={child.id}
                  meta={child}
                  session={props.session}
                  active={child.id === props.openId}
                  child
                  onClick={() => props.onOpen(child.id)}
                />
              ))}
            </Fragment>
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
 * 右边是三个点，不是一排图标：288px 的一行挂不下六个动作。
 * **两处破坏性/有去处的动作在菜单里仍然是两段式**——删除要确认，
 * 转移要选目标——都靠 `keepOpen` 把菜单原地换成第二组项，
 * 「先讲后果再动作」不因为换了容器就省掉。
 */
function SessionRow(props: {
  meta: SessionMeta;
  session: ChatSession;
  active: boolean;
  /** B-2：派出来的子会话——整行缩进，行首带谱系标记（挂父下的第二层） */
  child?: boolean;
  onClick: () => void;
}) {
  const { meta, session } = props;
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<"main" | "move" | "delete">("main");
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
              onSelect: () => session.archiveSession(meta.id, !meta.archived),
            },
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
      style={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        ...(props.child ? { paddingLeft: 16 } : {}),
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {props.child && (
        // 谱系标记（B-2）：与状态图标区分——它说的是「从哪来」，不是「跑没跑」
        <span
          title="Dispatched by the parent task"
          style={{
            display: "grid",
            placeItems: "center",
            width: 14,
            flex: "0 0 auto",
            color: "var(--color-text-tertiary)",
          }}
        >
          <Icon name="git-branch" size={11} strokeWidth={1.8} />
        </span>
      )}
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
      <Menu
        items={items}
        align="end"
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
              opacity: hover || open ? 1 : 0,
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
