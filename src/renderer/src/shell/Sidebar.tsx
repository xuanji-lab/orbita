import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import { PanelEmpty } from "./PanelEmpty";
import { FEATURE_ICON } from "./feature-icons.ts";
import { Chip } from "./Chip";
import { InlineName } from "./InlineName";
import { Menu, type MenuItem } from "./Menu";
import { UsageMeter } from "./UsageMeter";
import { WorkspaceFilterBar, useScrolledEdge, useWorkspaceFilter } from "./WorkspaceFilterBar.tsx";
import { bucketCounts, buildOptions, defaultFilter, groupByWorkspace, type WsAllow, type WsFilter } from "./workspace-filter.ts";
import { WorkspaceFiles } from "./focus/WorkspaceFiles.tsx";
import {
  EMPTY_SELECTION,
  nextSelection,
  rowClickKind,
  selectedInOrder,
  toggleOne,
  type SidebarSelection,
} from "./sidebar-selection.ts";
import { api } from "../api";
import type { ChatSession } from "../features/chat/useChatSession";
import { childSessions, rootSessions, type SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import {
  SIDEBAR_AGE_CHOICES,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  type SidebarAgeDays,
  type UsagePetPref,
} from "@shared/settings";
import { SETTINGS_TABS, type SettingsTab } from "../features/settings/settings-tabs.ts";
import { describeList } from "../features/chat/load-state.ts";
import { rowStatusIcon } from "./row-status.ts";
import { aggregateRunStates, runStateLabel, runStateOf, type SessionRunState } from "../features/notify/completion-notice.ts";
import { StatusPie } from "./StatusPie";
import { chipCompactAt, nextCompactLevel } from "./filter-row-compact.ts";
import { ageCounts, filterByAge } from "./sidebar-age.ts";
import { sessionAgeLabel } from "./relative-time.ts";
import { useMinuteTick } from "./use-minute-tick.ts";
import { matchesSessionQuery, openRowsLimit, workspaceRows } from "./workspace-rows.ts";
import { OPEN_EARLIER_EVENT } from "../features/context/main-progress.ts";
import { ATTENTION_WARMUP_MS, attentionItems, freshAttention } from "./attention.ts";
import { useChannelStatuses } from "../features/chat/useChannelSummaries.ts";
import { effectiveSidebarFilters } from "./sidebar-filters.ts";
import {
  TASKS_FOLD_KEY,
  foldKeyForWorkspace,
  groupVisibleLimit,
  isGroupFolded,
  nextPageSize,
  showLessInGroup,
  showMoreInGroup,
  toggleGroupFold,
  unfoldGroup,
  type SidebarGroupState,
} from "./sidebar-fold.ts";
import { useT } from "../locale.ts";
import { startPointerDrag } from "./pointer-drag.ts";
import type { Messages } from "../messages-en.ts";

/**
 * 中卡盖着的非聊天页。`null` = 聊天。settings / memory 是「整页盖层」（侧栏换成它们自己的导航），
 * 两者互斥，所以是联合类型而不是几个 boolean。插件页不在这里：右栏单列版走右栏面板位，
 * 全屏版是设置页的一个页签。
 */
export type Overlay = "settings" | "board" | null;

/** 子会话行的菜单里不给的项（见 SessionRow 的 menuItems） */
const CHILD_ROW_HIDDEN: ReadonlySet<string> = new Set(["pin", "move", "archive"]);

/**
 * 状态饼的 tooltip：见 completion-notice.ts 的 runStateLabel（侧栏行与侧栏顶「等你」
 * 同一套句子）。包一层是让调用点读起来像个本地词。
 */
function barLabel(state: "running" | "waiting" | "done" | "failed", t: Messages, childInterrupted: boolean): string {
  return runStateLabel(state, t, childInterrupted);
}

/** 已归档的选择条：有「任务」档，没有「全局」档 */
const SESSION_FILTER_ALLOW: WsAllow = { tasks: true, global: false };

/**
 * 筛选扑空的空态文案：按激活的组合说清「为什么什么都没有、怎么才有」，
 * 不给一条对不上当前筛选的提示。
 */
function filterEmptyText(
  /** 非 null = 时间范围开着，且去掉它之后本来是有会话的（范围才是「扑空」的原因） */
  emptiedByAge: SidebarAgeDays | null,
  t: Messages,
): string {
  if (emptiedByAge !== null) return t.sidebar.emptyInRange(emptiedByAge);
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
   * Archived 子视图的开关由 App 持有（2026-09-22：入口迁到右栏
   * 底部，状态跟着入口走，侧栏只剩受控渲染）。**子视图本体仍在侧栏**：换掉
   * 主列表区，不弹窗。
   */
  showArchived: boolean;
  onShowArchived: (next: boolean) => void;
  /** 当前宽度（px）。拖动中由调用方只改本地 state，松手才落 settings */
  width: number;
  /** 未读（后台完成没看过的）会话 id 集：工作区组与 TASKS 行画未读点 */
  unread: ReadonlySet<string>;
  onWidthChange: (width: number) => void;
  onWidthCommit: (width: number) => void;
  /** 时间范围筛选（settings.sidebarAgeDays；null = 不限）与改它的回调（落盘由 App 做） */
  ageDays: SidebarAgeDays | null;
  onAgeDaysChange: (next: SidebarAgeDays | null) => void;
  /** 左下角星云的摆放偏好（settings.usagePet）与改它的回调 */
  usagePet: UsagePetPref | undefined;
  onUsagePetChange: (next: UsagePetPref) => void;
  /**
   * 折叠态由 App 持有（2026-10-18 起收起后没有图标条，「窗口工具」组嵌在对话卡
   * 页头里，那份状态两边共用）。断点自动收起也在 App。
   */
  collapsed: boolean;
  onCollapsedChange: (next: boolean) => void;
  /**
   * 收起态页头「新任务」与右栏「转成任务」的信号（nonce 递增）：Sidebar 展开列表后把
   * TASKS 组跟着展开——新任务不能落进一个收着的组里无声无息。0 = 从未发过。
   */
  newTaskSignal: number;
  /**
   * 左栏此刻换成哪个工作区的文件视图：browse = 不计时地看一眼（工作区行悬停的
   * 「查看工作区文件」进的），focus = 专注中。null = 正常的会话列表。
   * 工作区已被移除时这里可能指向不存在的 id——按 null 处理（App 会清）。
   * 专注键 / 胶囊不在侧栏——住工具栏左胶囊（Toolbar 的 focus 槽，App 注入）。
   */
  filesView: { mode: "browse" | "focus"; workspaceId: string } | null;
  /** 工作区行悬停的「查看工作区文件」 */
  onBrowseWorkspace: (id: string) => void;
  /** 浏览态的「返回会话列表」 */
  onExitBrowse: () => void;
  /** 浏览态的「以此开始专注」：开专注浮层并预选这个工作区 */
  onStartFocusHere: (workspaceId: string) => void;
  /** 双击 / Enter 打开左栏文件预览（绝对路径 → App → 右栏文件面板） */
  onOpenFile: (absPath: string) => void;
  /** 「等你」里新冒出了几件（每件只报一次）：App 响提示音 */
  onAttentionAppeared: (ids: readonly string[]) => void;
  /** 星云的常驻小气泡（专注：正在整理 / 要不要总结）；null = 无 */
  usageSay: React.ReactNode | null;
  /** 星云头顶的卡片（专注时间到）；null = 无 */
  usageCard: React.ReactNode | null;
}) {
  const t = useT();
  const { session } = props;
  // 每分钟重渲染一次：行尾「刚刚 / N 分钟」与时间范围都在渲染时按 Date.now() 现算（理由见 use-minute-tick.ts）
  useMinuteTick();
  const asideRef = useRef<HTMLElement | null>(null);
  /** 拖宽中禁掉 width 过渡——实时跟手（同右侧面板的 .dragging 纪律） */
  const [resizing, setResizing] = useState(false);
  const settingsOpen = props.overlay === "settings";
  /** 任一整页盖层（设置）开着：主列表、筛选行、子视图都让位 */
  const overlayOpen = props.overlay === "settings";
  /**
   * 筛选行的「收几个 chip 成图标」档位：容器放不下五个带字 chip 时，从最右边的字 chip 起往左
   * 逐个只画图标（设计稿 c 图；判定在 `filter-row-compact.ts`，纯函数、不抖），这里只负责量宽度。
   * 每个 chip 完整态的宽度量到就记住（图标态的宽度不可信）；语言或时间范围的有无变了、chip 宽度随之变，
   * 就先回到 0 档重新量一遍（useLayoutEffect，首帧前完成，不闪）。
   */
  const filterRowRef = useRef<HTMLDivElement | null>(null);
  const [filterLevel, setFilterLevel] = useState(0);
  const chipFullWidths = useRef<(number | null)[]>([null, null]);
  const chipWidthKey = useRef<{ t: Messages; aged: boolean } | null>(null);
  useLayoutEffect(() => {
    const row = filterRowRef.current;
    if (row === null) return;
    const aged = props.ageDays !== null;
    if (chipWidthKey.current === null || chipWidthKey.current.t !== t || chipWidthKey.current.aged !== aged) {
      chipWidthKey.current = { t, aged };
      chipFullWidths.current = [null, null];
      if (filterLevel !== 0) {
        // 完整态才量得到完整宽度：先回 0 档，下一轮（依赖 filterLevel 变）再量
        setFilterLevel(0);
        return;
      }
    }
    const measure = (): void => {
      const chips = Array.from(row.querySelectorAll<HTMLElement>("button.chip"));
      let compactWidth = 24;
      chips.forEach((chip, index) => {
        const width = chip.getBoundingClientRect().width;
        if (chipCompactAt(filterLevel, index)) compactWidth = width;
        else chipFullWidths.current[index] = width;
      });
      const next = nextCompactLevel({
        fullWidths: chipFullWidths.current,
        compactWidth,
        gap: 4,
        containerWidth: row.clientWidth,
      });
      if (next !== filterLevel) setFilterLevel(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
    // 筛选行可能整个不渲染（无会话 / Archived / Settings 视图），ref 空时不装观察者；
    // 它回来时靠下面这几个依赖重跑一次。live 在后面才算，这里用 session.sessions.length 代替
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterLevel, props.ageDays, t, session.sessions.length, overlayOpen, props.showArchived]);
  /**
   * 「Starred」叠加开关的开合，与状态筛选正交——星标是价值标记，与任务
   * 做没做完是两个问题，组合起来（如 Active + Starred）是合法且有意义的视图。
   * **只作用于主浏览列表**（Workspaces + Tasks）：Archived 是存储位置视图、
   * Settings 是另一块列表，都不受（也不该隐形地受）筛选。
   */
  const [starredOnly, setStarredOnly] = useState(false);
  /**
   * 「以前的会话」子视图开在哪个工作区上（工作区下面最后那一行点进来的）；null = 没开。
   * 与「已归档」同一种子视图：换掉主列表区、标题旁带返回键，不弹窗。不持久化。
   */
  const [earlierFor, setEarlierFor] = useState<string | null>(null);
  /** 「以前的会话」里的搜索字（标题与最近几次提问） */
  const [earlierQuery, setEarlierQuery] = useState("");
  /**
   * 命名新建工作区：Workspaces 列表顶部那行就地编辑（InlineName）开没开着。
   * 「+」菜单里选「New workspace…」置 true；Enter / Esc / 点别处（失焦提交，
   * 空名不提交）都会收掉。**不持久化**——一个没提交的名字不值得活过重启。
   */
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  /**
   * 任务行多选（Shift 选一段 / ⌘·Ctrl 逐个加）：只为批量迁移服务，不持久化。
   * 规则在 sidebar-selection.ts；多选非空时列表上方出现多选条。
   */
  const [selection, setSelection] = useState<SidebarSelection>(EMPTY_SELECTION);
  /** 迁移没全成功时的说明（在跑的跳过等）：贴在多选条下面，下一次点击任务行时清掉 */
  const [moveNote, setMoveNote] = useState<string | null>(null);
  /**
   * 勾选态开在哪个工作区组上（组头悬停的「迁移任务…」进入）；null = 没开。
   * **不弹窗**（2026-10-31 用户：「我们从来不弹卡片的……弹卡片太打断人了」）：
   * 只有这一组的任务行前面出现勾选框，点行 = 勾 / 取消，顶部用同一个多选条迁移。
   */
  const [checkFor, setCheckFor] = useState<string | null>(null);
  /**
   * 分组状态：哪些组折叠着、哪些组点了 Show more 全量铺开。状态本体在
   * `sidebar-fold.ts`；同样**不持久化**，理由同上——列表每次启动从盘上重读。
   */
  const [groups, setGroups] = useState<SidebarGroupState>({
    overrides: new Set<string>(),
    pages: new Map<string, number>(),
  });
  // 收起态页头点「新任务」（App 发的 nonce 信号）：展开后 TASKS 组跟着展开，
  // 新会话不落进收着的组里（与工具栏左胶囊「新任务」同一条纪律，信号从 App 来）
  useEffect(() => {
    if (props.newTaskSignal === 0) return;
    setGroups((current) => unfoldGroup(current, TASKS_FOLD_KEY));
  }, [props.newTaskSignal]);
  /**
   * 任意会话在跑（含后台与子会话）：用量格的星云碎片 3 倍速——「今在干活」
   * 是全应用的状态，不是当前会话的。phaseOf 读引擎的同步镜像；每次 phase
   * 事件都会把 App 重渲染、侧栏跟着拿到新鲜值。**不套 useMemo**：列表引用
   * 在轮内不变，memo 会把「开跑」那一拍漏掉（idle 后的重拉才换引用）。
   */
  const anyRunning = session.sessions.some((meta) => session.phaseOf(meta.id) !== "idle");

  const width = props.width;
  /** 高亮哪一条：盖着别的面时谁也不高亮；否则在看历史就是那条，不然是活着的那条 */
  const openId = props.overlay !== null ? null : (session.sessionId ?? session.opened?.id ?? null);
  const openWorkspaceId = session.sessions.find((m) => m.id === openId)?.workspaceId ?? null;
  /**
   * 当前所在的工作区（满载结构，2026-11-17 设计 11-sidebar-full C）：**只有它展开**，换工作区自动换着展开，
   * 不靠手动折叠——12 个工作区全展开约 80 行，一屏只看得到前两个。当前 = 正看着的会话（含主智能体与它派的活）
   * 所在的工作区，或停在哪个工作区主智能体的空态；在「任务」组或首页时一个都不展开。
   * 盖着设置页时也照这个算（不跟 overlay 清掉），关掉设置回来侧栏不跳。
   */
  const viewedId = session.sessionId ?? session.opened?.id ?? null;
  const currentWorkspaceId =
    session.mainPending?.workspaceId ?? session.sessions.find((m) => m.id === viewedId)?.workspaceId ?? null;

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
  // 已归档记一份「上次选的工作区」（没选过时默认当前会话所在的工作区）
  const subviewFallback = defaultFilter(openWorkspaceId, session.workspaces);
  const [archivedFilter, setArchivedFilter] = useWorkspaceFilter("archived", subviewFallback, session.workspaces, SESSION_FILTER_ALLOW);
  // 组内按归档时间新→旧：meta 没存归档时刻，以最后活动时间代之（归档的多是做完不再动的会话，两者基本一致）
  const archivedGroups = groupByWorkspace(
    [...archived].sort((a, b) => b.updatedAt - a.updatedAt),
    (meta) => meta.workspaceId,
    session.workspaces,
    archivedFilter,
  );
  const archivedCounts = bucketCounts(archived, (meta) => meta.workspaceId, session.workspaces);
  const archivedOptions = buildOptions({
    workspaces: session.workspaces,
    total: archived.length,
    perWorkspace: archivedCounts.perWorkspace,
    tasks: archivedCounts.tasks,
    global: null,
    selected: archivedFilter,
    hideEmpty: true,
  });
  // 子视图的标题 + 选择条钉在列表外：列表滚起来时在它们下面画发丝线（内容被滚动区上缘裁掉时不至于像被盖住）
  const subviewEdge = useScrolledEdge(props.showArchived ? "archived" : "list");
  /** 选了某档却没有东西时空态里写的名字 */
  const filterName = (filter: WsFilter): string =>
    filter.kind === "workspace"
      ? (session.workspaces.find((w) => w.id === filter.id)?.name ?? filter.id)
      : t.sidebar.wsFilterTasks;
  // 两个节点各自的读取进度：加载中 / 读失败 / 真的空（D-3）
  const workspaceList = describeList(session.loads.workspaces, session.workspaces.length);
  // 用 roots.length 不用 session.sessions.length：这里描述的是左栏那份列表
  // （只列根会话，子会话 PR4c 2.3），两个数字不一致会出现「读到 0 条」误报或反之
  const sessionList = describeList(session.loads.sessions, roots.length);
  /**
   * 主列表的筛选管线（筛选区 chips）。状态（All/Done，单选组）与星标（叠加开关）
   * 正交，串在同一个 filter 里。**只作用于主浏览
   * 列表**——Archived 是存储视图，不受（也不该隐形地受）筛选。
   * 有效值过 effectiveSidebarFilters（全是默认值时 null = 不过滤），见 sidebar-filters.ts。
   */
  const ageDays = props.ageDays;
  /**
   * 工作区下面列什么（常驻主智能体，2026-11-17）：工作区那一行就是主智能体，下面只露没了结的活，
   * 其余收进「以前的会话 N」（workspace-rows.ts）。状态与状态饼同一份真源（runStateOf）。
   */
  const mainIds = session.sessions.filter((meta) => meta.role === "main").map((meta) => meta.id);
  const channelStatus = useChannelStatuses(mainIds);
  /** 行的状态：主智能体派出的活在问问题时转录是空闲的，按通道状态画成「等你」，其余同状态饼 */
  const rowState = (meta: SessionMeta): SessionRunState => {
    if (meta.parentId === undefined) return runStateOf(session, meta);
    const status = channelStatus.get(meta.id);
    if (status === "waiting") return "waiting";
    // 暂停着的不画饼（四色都不是它）：停着、不算等你；它仍列在没了结里（held）
    if (status === "paused" && session.phaseOf(meta.id) === "idle") return null;
    return runStateOf(session, meta);
  };
  const held = (meta: SessionMeta): boolean => meta.parentId !== undefined && channelStatus.get(meta.id) === "paused";
  const rowsOf = new Map(
    session.workspaces.map((workspace) => [workspace.id, workspaceRows(session.sessions, workspace.id, rowState, held)]),
  );
  /**
   * 「以前的会话」那一页列什么（2026-11-21）：侧栏不再列工作区子行，这一页接住这个工作区里用户自己开的根会话
   * （了结没了结都在，在跑 / 等你的行尾照样有饼）与做完看过的活。主智能体在做、等你的活在它的进度面板里，不在这里重列。
   */
  const earlierOf = (workspaceId: string): SessionMeta[] => {
    const rows = rowsOf.get(workspaceId);
    if (rows === undefined) return [];
    return [...rows.open.filter((meta) => meta.parentId === undefined), ...rows.earlier].sort((a, b) => b.updatedAt - a.updatedAt);
  };
  /** 工作区行尾的状态汇总：主智能体自己 + 名下没了结的活与会话（与状态饼同一份推导） */
  const workspaceStates = (workspaceId: string): SessionRunState[] => {
    const rows = rowsOf.get(workspaceId);
    if (rows === undefined) return [];
    return [...(rows.main === null ? [] : [rowState(rows.main)]), ...rows.open.map(rowState)];
  };

  /**
   * 主智能体派出去、没做成的那件算不算已经处理了（2026-11-17 主会话定）：通道离开 failed 就是处理了——
   * 主智能体回了话（重开成 running）、暂停了、放弃了（stopped）；或者它重派了一件同名的新活。处理了就不在「等你」里，
   * 失败这个事实留在那件活自己的行上（饼红到你看过）。通道状态还没拉到时先当处理了（宁可晚出现一拍，不错叫）。
   */
  const attentionHandled = (meta: SessionMeta): boolean => {
    if (meta.parentId === undefined) return false;
    if (channelStatus.get(meta.id) !== "failed") return true;
    return session.sessions.some(
      (other) => other.parentId === meta.parentId && other.id !== meta.id && other.title === meta.title && other.createdAt > meta.createdAt,
    );
  };
  /**
   * 跨工作区每件在等你的事（attention.ts）：只为下面的提示音记账，侧栏顶上不再列（2026-11-21，用户：看工作区行尾的
   * 状态图标就知道哪个工作区要他，具体哪件在那个工作区主智能体的进度面板最前）。数据就是上面这份行状态，不另存；
   * 「任务」组里在等你的根会话也算。
   */
  const attention = attentionItems(
    [
      ...session.workspaces.map((workspace) => ({ workspaceId: workspace.id, rows: rowsOf.get(workspace.id)?.open ?? [] })),
      { workspaceId: null, rows: live.filter((m) => m.workspaceId === null || !known.has(m.workspaceId)) },
    ],
    rowState,
    attentionHandled,
  );
  /**
   * 提示音只为新冒出的等你响一次（做完不响，2026-11-17）：同一件事不重复响——按 id 记着响过的，处理完再出现也不响。
   * 启动后头几秒是「读盘把已有的等你一件件读出来」，不是新冒出来的：这段时间只记账不报（ATTENTION_WARMUP_MS）。
   */
  const attentionKey = attention.map((item) => item.meta.id).join(",");
  const rungRef = useRef<Set<string>>(new Set());
  const mountedAtRef = useRef(Date.now());
  const onAttentionAppeared = props.onAttentionAppeared;
  useEffect(() => {
    const ids = attentionKey === "" ? [] : attentionKey.split(",");
    const fresh = freshAttention(ids, rungRef.current);
    for (const id of fresh) rungRef.current.add(id);
    if (fresh.length > 0 && Date.now() - mountedAtRef.current > ATTENTION_WARMUP_MS) onAttentionAppeared(fresh);
  }, [attentionKey, onAttentionAppeared]);
  /** 右栏进度面板「全部以前的会话」：开这一页（侧栏收着就先展开），设置 / 已归档盖着的先让开 */
  const onCollapsedChange = props.onCollapsedChange;
  const onOverlay = props.onOverlay;
  const onShowArchived = props.onShowArchived;
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const workspaceId = (event as CustomEvent<string>).detail;
      onOverlay(null);
      onShowArchived(false);
      onCollapsedChange(false);
      setEarlierQuery("");
      setEarlierFor(workspaceId);
    };
    window.addEventListener(OPEN_EARLIER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EARLIER_EVENT, onOpen);
  }, [onCollapsedChange, onOverlay, onShowArchived]);
  /** 「以前的会话」子视图开在哪个工作区上；工作区被移除了按没开处理 */
  const earlierWs =
    earlierFor === null || overlayOpen || props.showArchived
      ? null
      : (session.workspaces.find((workspace) => workspace.id === earlierFor) ?? null);
  const earlierBase = earlierWs === null ? [] : earlierOf(earlierWs.id);
  /**
   * 筛选（已完成 / 星标 / 时间范围）与搜索只作用于「以前的会话」那一页：主列表现在只有没了结的活，
   * 几行而已，筛选无从谈起（筛选行跟着挪进子视图，设计稿 1-entry-after 的侧栏里没有筛选行）。
   * 有效值过 effectiveSidebarFilters（全是默认值时 null = 不过滤），见 sidebar-filters.ts。
   */
  const filters = effectiveSidebarFilters({
    starredOnly,
    ageDays,
  });
  const now = Date.now();
  // 先过前三项与搜索；时间范围下拉每一档的命中条数以它为底（「选这一档我会看到几条」，与其它筛选叠加后的数）
  const beforeAge = earlierBase.filter((m) => {
    if (!matchesSessionQuery(m, earlierQuery)) return false;
    if (filters === null) return true;
    if (filters.starredOnly && m.starred !== true) return false;
    return true;
  });
  const ageCountsNow = ageCounts(beforeAge, now);
  // 再过时间范围；正在看的那条出了窗口也留着（同 visibleWithOpen 的思路）
  const scoped = filterByAge(beforeAge, now, ageDays, openId);
  const limitFor = (key: string): number => groupVisibleLimit(groups, key);
  const loose = live.filter((m) => m.workspaceId === null || !known.has(m.workspaceId));
  const workspaceMatches = session.workspaces;
  const tasksFolded = isGroupFolded(groups, TASKS_FOLD_KEY);
  // TASKS 的超长截断：默认列前 N 条，其余收进「Show N more」
  const looseVisible = visibleWithOpen(loose, limitFor(TASKS_FOLD_KEY), openId);
  const open = (id: string) => {
    props.onOverlay(null);
    session.openSession(id);
  };
  /** 点工作区那一行 = 跟它的主智能体说话（会话已在就打开，没说过话就是它的空态） */
  const openMain = (workspace: Workspace): void => {
    props.onOverlay(null);
    setEarlierFor(null);
    session.openMainAgent(workspace);
  };
  /**
   * 这个工作区的主智能体此刻正打开着（盖着别的面时谁也不高亮）。点进它派的一件活时也亮着这一行：
   * 侧栏不再列活的子行（2026-11-21），不亮就看不出自己在哪个工作区里；回父走顶栏面包屑或点这一行。
   */
  const mainActive = (workspaceId: string): boolean => {
    if (props.overlay !== null) return false;
    const main = rowsOf.get(workspaceId)?.main ?? null;
    if (main !== null && openId !== null && (main.id === openId || session.sessions.some((meta) => meta.id === openId && meta.parentId === main.id))) return true;
    return session.mainPending?.workspaceId === workspaceId;
  };

  /**
   * 主列表从上到下**可见**的任务行（Shift 区间按它算）：「以前的会话」开着时就是那一页的行；
   * 否则是展开着的工作区组各自的可见行，再接 TASKS 的可见行——与下面的渲染顺序一致。
   */
  const visibleOrder =
    earlierWs !== null
      ? scoped.map((m) => m.id)
      : [
          ...(tasksFolded || sessionList.body !== "list" ? [] : looseVisible.map((m) => m.id)),
        ];
  const batch = selectedInOrder(selection, visibleOrder);
  const listView = !overlayOpen && !props.showArchived;
  /** 行的高亮：多选进行中只亮选中的那几行（Finder 同款），否则亮正打开的那条 */
  const rowActive = (id: string): boolean => (batch.length > 0 ? selection.ids.has(id) : id === openId);
  /** 某一行菜单里「移到…」要搬哪些：它在多选里就搬整批，否则只搬它自己 */
  const moveIdsFor = (id: string): readonly string[] =>
    batch.length > 1 && selection.ids.has(id) ? batch : [id];
  const clickRow = (id: string, event: React.MouseEvent): void => {
    const kind = rowClickKind(event);
    // Shift 点按钮会顺手扩一段页面文字选区，清掉——这里的 Shift 是选任务不是选字
    if (kind === "range") window.getSelection()?.removeAllRanges();
    setMoveNote(null);
    // 勾选态里点那一组的行：普通点击 = 勾 / 取消这一条，不打开（Shift 照常选一段）
    const inChecking =
      checkFor !== null && session.sessions.find((m) => m.id === id)?.workspaceId === checkFor;
    if (inChecking && kind !== "range") {
      setSelection(toggleOne(selection, id));
      return;
    }
    const next = nextSelection(selection, kind, id, visibleOrder, openId);
    setSelection(next.selection);
    // 普通点开别的会话 = 离开勾选态（用户的注意力已经回到对话上）
    if (next.open) {
      setCheckFor(null);
      open(id);
    }
  };
  const clearSelection = (): void => {
    setSelection(EMPTY_SELECTION);
    setMoveNote(null);
    setCheckFor(null);
  };
  /** 进入某一组的勾选态：组展开，之前的多选清掉（勾选只在这一组里挑） */
  const startChecking = (workspaceId: string): void => {
    setSelection(EMPTY_SELECTION);
    setMoveNote(null);
    setCheckFor(workspaceId);
    // 工作区下面不再列行：勾选在「以前的会话」那一页里做（那一页列着这个工作区的会话）
    setEarlierQuery("");
    setEarlierFor(workspaceId);
  };
  /**
   * 迁移（行菜单 / 多选条共用）：没迁动的留在多选里并把原因写在多选条下——
   * 在跑的会话被跳过不能是悄悄的。迁过去的那一组展开，让用户看到它们落在哪。
   */
  const moveBatch = (ids: readonly string[], target: string | null): void => {
    void session
      .moveSessions(ids, target)
      .then((result) => {
        const running = result.skipped.filter((item) => item.reason === "running").length;
        setSelection({ ids: new Set(result.skipped.map((item) => item.id)), anchor: null });
        setMoveNote(result.skipped.length === 0 ? null : t.sidebar.moveSkipped(running, result.skipped.length - running));
        if (result.moved.length > 0) {
          setGroups((current) =>
            unfoldGroup(current, target === null ? TASKS_FOLD_KEY : foldKeyForWorkspace(target)),
          );
        }
      })
      .catch((cause: unknown) => setMoveNote(cause instanceof Error ? cause.message : String(cause)));
  };
  /** 一条任务（或其子会话）在跑：迁移会跳过它，弹窗里先灰掉 */
  const familyRunning = (id: string): boolean =>
    session.phaseOf(id) !== "idle" ||
    childSessions(session.sessions, id).some((child) => session.phaseOf(child.id) !== "idle");
  // Esc 清多选、退出勾选态
  const selecting = batch.length > 0 || checkFor !== null;
  useEffect(() => {
    if (!selecting) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selecting]);
  // 勾选态那一组被搬空了（或工作区被移除）：勾选态自然结束，别留一个没有行的勾选态
  const checkGroupSize = checkFor === null ? 0 : earlierOf(checkFor).length;
  useEffect(() => {
    if (checkFor !== null && checkGroupSize === 0) setCheckFor(null);
  }, [checkFor, checkGroupSize]);
  // 勾选在「以前的会话」那一页里做：离开那一页（返回、换到别的工作区）勾选态跟着结束
  useEffect(() => {
    if (checkFor !== null && earlierFor !== checkFor) setCheckFor(null);
  }, [checkFor, earlierFor]);

  /**
   * 左栏的文件视图（浏览 / 专注）：设置页与 Archived 子视图盖着时
   * 优先让位给它们（那些入口在右栏，不受专注影响）；工作区被移除则回会话列表。
   */
  const filesViewWs =
    props.filesView !== null && !overlayOpen && !props.showArchived
      ? (session.workspaces.find((item) => item.id === props.filesView?.workspaceId) ?? null)
      : null;
  const filesBody =
    filesViewWs !== null && props.filesView !== null
      ? (
          <WorkspaceFiles
            key={filesViewWs.id}
            mode={props.filesView.mode}
            workspace={filesViewWs}
            workspaces={session.workspaces}
            session={session}
            openId={openId}
            onBack={props.onExitBrowse}
            onStartFocusHere={() => props.onStartFocusHere(filesViewWs.id)}
            onOpenFile={props.onOpenFile}
          />
        )
      : null;

  /**
   * 拖宽：右移变宽（与右侧面板同一套机制，只是方向相反）。**区间是固定像素 240–400**
   * ——右栏那条「pane 的 1/3–2/3」不管左栏（2026-09-22 wafo 澄清：那一对说的是
   * chat 主区与右栏）；
   * 拖动中不做动画、全文选择与光标固定成拖拽语义，松手还原；双击热区回 288。
   * 对话面（`main.pane`）是 `flex: 1`，侧栏变宽它自己就让出来——用户要的正是
   * 「靠右侧 chat view 的宽度来调节」（2026-09-22 wafo）。
   */
  const startResize = (event: React.PointerEvent<HTMLElement>): void => {
    const aside = asideRef.current;
    if (aside === null) return;
    const startWidth = aside.getBoundingClientRect().width;
    const clamp = (value: number): number =>
      Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)));
    const started = startPointerDrag(event, {
      cursor: "col-resize",
      onMove: (delta) => props.onWidthChange(clamp(startWidth + delta.x)),
      onEnd: (delta) => {
        setResizing(false);
        props.onWidthCommit(clamp(startWidth + delta.x));
      },
    });
    if (started) setResizing(true);
  };

  // —— 收起态：什么都不渲染，主区域向左铺满。侧栏开关与新任务住工具栏左胶囊
  // （shell/Toolbar.tsx），开合不换容器；折叠期间列表不可达，要切会话先展开。
  // Archived / Settings 的入口本来就只在右栏底部（2026-09-22 裁决），
  // 右栏不折叠。
  if (props.collapsed) {
    return null;
  }

  return (
    <>
    <aside
      ref={asideRef}
      className="sidebar"
      style={{
        width,
        flex: `0 0 ${width}px`,
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        // 顶部不留白：顶行要坐到卡顶（与 .pane 的页头同一条中心线，对齐红绿灯）；
        // 底部留白与拖宽热区同步（top: var(--space-3)）
        padding: "0 var(--space-3) var(--space-2)",
        background: "transparent",
        overflow: "hidden",
        // 拖动中禁过渡：160ms 的宽度动画会让跟手变成拖一根皮筋
        transition: resizing ? "none" : "width var(--duration-fast) var(--ease-standard)",
      }}
    >
      {/*
        #248 的 Safari 式工具栏之后侧栏没有顶行了（字标与星云同在左下角停机坪）；
        专注 / 浏览工作区文件时换掉的是模式页签 + 新任务大按钮 + 列表这一整段，
        左下角的用量格与星云照常在（专注中星云要说话）。
      */}
      {filesBody !== null ? (
        filesBody
      ) : (
      <>

      {/*
        「以前的会话」子视图的页头：返回键 + 标题（与「已归档」同一种子视图），下面一个搜索框。
        钉在列表外：列表滚下去了，搜索与筛选还在手边。
      */}
      {earlierWs !== null && (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: "var(--space-1)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", minWidth: 0 }}>
            <IconButton
              label={t.sidebar.backToTasks}
              title={t.sidebar.backToTasksTip}
              size={20}
              onClick={() => setEarlierFor(null)}
              style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-secondary)" }}
            >
              <Icon name="chevron-left" size={13} strokeWidth={1.8} />
            </IconButton>
            <NodeLabel>{t.sidebar.earlierTitle}</NodeLabel>
            <span
              style={{
                minWidth: 0,
                fontSize: "var(--font-size-sm)",
                color: "var(--color-text-tertiary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {earlierWs.name}
            </span>
          </div>
          {/* 搜索框沿用记忆库的那一格（.mem-search），不另造 */}
          <label className="mem-search">
            <Icon name="search" size={12} strokeWidth={1.8} />
            <input
              value={earlierQuery}
              placeholder={t.sidebar.earlierSearch}
              aria-label={t.sidebar.earlierSearch}
              spellCheck={false}
              onChange={(event) => setEarlierQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (earlierQuery !== "") setEarlierQuery("");
                  else setEarlierFor(null);
                }
              }}
            />
            {earlierQuery !== "" && (
              <button type="button" className="mem-icon-btn" aria-label={t.sidebar.earlierClearSearch} onClick={() => setEarlierQuery("")}>
                <Icon name="x" size={12} strokeWidth={1.8} />
              </button>
            )}
          </label>
        </div>
      )}

      {/**
        筛选区：会话浏览的过滤 chips。状态是单选组（All / Done 互斥，
        点一个顶掉另一个），Starred 是叠加开关——两者正交，可组合出
        「已完成且星标」这样的视图。2026-11-17 手动「完成」整个去掉（用户：伪需求），「全部 / 已完成」一组随之删掉。2026-11-17 起**只在「以前的会话」那一页**：主列表只剩没了结的几行活，
        筛选无从谈起。「进行中」2026-10-24 去掉（用户：「似乎完全没用」）。
      */}
      {earlierWs !== null && earlierBase.length > 0 && (
        <div
          ref={filterRowRef}
          style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden" }}
        >
          <Chip
            icon="star"
            compact={chipCompactAt(filterLevel, 0)}
            active={starredOnly}
            title={t.sidebar.filterStarredTip}
            onClick={() => setStarredOnly((value) => !value)}
          >
            {t.sidebar.filterStarred}
          </Chip>
          {/*
            时间范围（2026-11-07）：只列最近 N 天动过的。不限时只画「时钟 + ˅」不带字——多一个带字的
            chip 会把 288px 的筛选行挤进紧凑态；选了某档才露出「3 天」，一眼看出范围开着。
            菜单每档后面写命中条数（在其它筛选之上算的）。选择落盘（settings.sidebarAgeDays）。
          */}
          <Menu
            items={[
              { id: "age-header", label: t.sidebar.filterAgeHeader, header: true },
              ...SIDEBAR_AGE_CHOICES.map(
                (days): MenuItem => ({
                  id: `age-${days}`,
                  label: t.sidebar.filterAgeChoice(days),
                  hint: String(ageCountsNow[days]),
                  checked: ageDays === days,
                  onSelect: () => props.onAgeDaysChange(days),
                }),
              ),
              {
                id: "age-any",
                label: t.sidebar.filterAgeAny,
                hint: String(ageCountsNow.any),
                checked: ageDays === null,
                onSelect: () => props.onAgeDaysChange(null),
              },
            ]}
            align="end"
            panelMinWidth={200}
            trigger={({ toggle }) => (
              <Chip
                icon="clock"
                compact={chipCompactAt(filterLevel, 1)}
                chevron={!chipCompactAt(filterLevel, 1)}
                active={ageDays !== null}
                title={ageDays === null ? t.sidebar.filterAgeTip : t.sidebar.filterAgeChoice(ageDays)}
                onClick={toggle}
              >
                {ageDays === null ? null : t.sidebar.filterAgeChip(ageDays)}
              </Chip>
            )}
          />
        </div>
      )}

      {listView && (selecting || moveNote !== null) && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          {selecting && (
            <div className="sidebar-selection-bar" title={t.sidebar.selectHint}>
              <span>{batch.length === 0 ? t.sidebar.checkHint : t.sidebar.selectedCount(batch.length)}</span>
              <Menu
                items={moveTargetItems(t, session.workspaces, batch, undefined, moveBatch)}
                align="end"
                panelMinWidth={160}
                panelMaxWidth={240}
                trigger={({ open: menuOpen, toggle }) => (
                  // 带字的按钮：多选条上唯一的动作，光一个图标读不出「这是迁移」
                  <button
                    type="button"
                    className="sidebar-selection-move"
                    aria-expanded={menuOpen}
                    title={batch.length === 0 ? t.sidebar.checkHint : t.sidebar.moveCount(batch.length)}
                    disabled={batch.length === 0}
                    onClick={toggle}
                  >
                    <Icon name="folder-sync" size={13} strokeWidth={1.8} />
                    {t.sidebar.moveTo}
                  </button>
                )}
              />
              <IconButton
                label={t.sidebar.clearSelection}
                title={t.sidebar.clearSelection}
                size={24}
                onClick={clearSelection}
                style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-secondary)" }}
              >
                <Icon name="x" size={14} strokeWidth={1.8} />
              </IconButton>
            </div>
          )}
          {moveNote !== null && (
            <p className="sidebar-move-note" role="status">
              <Icon name="triangle-alert" size={13} strokeWidth={1.8} />
              {moveNote}
            </p>
          )}
        </div>
      )}

      {/*
        标题行左端的返回键是子视图的**显式出口**。以前出去只能再点一次底部那条 toggle，
        而它既不像一个「返回」，又会在归档空了时禁用。这是一个子视图，子视图就该在它自己的
        标题旁边带着回去的路。标题与工作区选择条**钉在列表外面**：列表滚下去了，一排工作区还在手边。
      */}
      {props.showArchived && !overlayOpen && (
        // minmax(0,1fr)：不加的话 grid 的 auto 列按选择条的内容宽撑开，横向滚动永远触发不了
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr)", gap: "var(--space-1)", paddingBottom: "var(--space-1)", ...subviewEdge.edgeStyle }}>
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
          <WorkspaceFilterBar
            options={archivedOptions}
            workspaces={session.workspaces}
            selected={archivedFilter}
            onSelect={setArchivedFilter}
          />
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
        onScroll={subviewEdge.onScroll}
      >
        {props.showArchived && !overlayOpen ? (
          <>
            {/*
              空了也停在这里、显示空态（2026-09-27 wafo：空的时候自动弹回主列表，点入口像按钮坏了）。
              以前会自动退回，是因为出口只有底部那条会在 0 条时禁用的入口——现在标题旁有返回键、
              入口常驻右栏，死胡同已不存在。
            */}
            {archived.length === 0 && <Empty icon={FEATURE_ICON.archived}>{t.sidebar.noArchived}</Empty>}
            {archived.length > 0 && archivedGroups.length === 0 && (
              <Empty icon={FEATURE_ICON.archived}>{t.sidebar.wsFilterNoneIn(filterName(archivedFilter))}</Empty>
            )}
            {archivedGroups.map((group) => (
              <div key={group.workspace?.id ?? "tasks"} style={{ marginBottom: "var(--space-2)" }}>
                <WsGroupHead workspace={group.workspace} count={group.items.length} />
                {group.items.map((meta) => (
                  <SessionRow
                    key={meta.id}
                    meta={meta}
                    session={session}
                    active={meta.id === openId}
                    onClick={() => open(meta.id)}
                    moveIds={[meta.id]}
                    onMove={moveBatch}
                  />
                ))}
              </div>
            ))}
          </>
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
        ) : earlierWs !== null ? (
          earlierBase.length === 0 ? (
            <Empty icon="history">{t.sidebar.earlierNone}</Empty>
          ) : scoped.length === 0 ? (
            /* 筛选 / 搜索扑空：一条空态说清为什么什么都没有 */
            <Empty icon="list-filter">
              {filters === null
                ? t.sidebar.earlierNoMatch
                : filterEmptyText(ageDays !== null && beforeAge.length > 0 ? ageDays : null, t)}
            </Empty>
          ) : (
            scoped.map((meta) => (
              <SessionRow
                key={meta.id}
                meta={meta}
                session={session}
                checkbox={checkFor === earlierWs.id ? selection.ids.has(meta.id) : undefined}
                active={rowActive(meta.id)}
                onClick={(event) => clickRow(meta.id, event)}
                moveIds={moveIdsFor(meta.id)}
                onMove={moveBatch}
              />
            ))
          )
        ) : (
          <>
            {(
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
                      gridTemplateColumns: "24px 24px minmax(0,1fr)",
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
                  <Empty busy>{t.sidebar.loadingWorkspaces}</Empty>
                ) : workspaceList.body === "empty" ? (
                  <Empty icon="folder" exit={{ label: t.sidebar.noWorkspaceExit, onClick: session.addWorkspace }}>
                    {t.sidebar.noWorkspace}
                  </Empty>
                ) : workspaceList.body === "list" ? (
                  workspaceMatches.map((workspace) => (
                    <WorkspaceGroup
                      key={workspace.id}
                      workspace={workspace}
                      states={workspaceStates(workspace.id)}
                      earlierCount={earlierOf(workspace.id).length}
                      mainActive={mainActive(workspace.id)}
                      onOpenMain={() => openMain(workspace)}
                      onOpenEarlier={() => {
                        setEarlierQuery("");
                        setEarlierFor(workspace.id);
                      }}
                      onRename={(name) => session.renameWorkspace(workspace.id, name)}
                      onRemove={() => session.removeWorkspace(workspace.id)}
                      onBrowse={() => props.onBrowseWorkspace(workspace.id)}
                      checking={checkFor === workspace.id}
                      onStartChecking={() => startChecking(workspace.id)}
                      onDoneChecking={clearSelection}
                    />
                  ))
                ) : null}
              </>
            )}

            {(
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
                    props.onOverlay(null);
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
                  <Empty busy>{t.sidebar.loadingTasks}</Empty>
                ) : sessionList.body === "none" ? null : sessionList.body === "empty" ? (
                  <Empty icon="message-square">{t.sidebar.noTask}</Empty>
                ) : tasksFolded ? null : (
                  <>
                    {looseVisible.map((meta) => (
                      <SessionRow
                        key={meta.id}
                        meta={meta}
                        session={session}
                        active={rowActive(meta.id)}
                        onClick={(event) => clickRow(meta.id, event)}
                        moveIds={moveIdsFor(meta.id)}
                        onMove={moveBatch}
                      />
                    ))}
                    <ShowMoreRow
                      hidden={loose.length - looseVisible.length}
                      next={nextPageSize(TASKS_FOLD_KEY, loose.length - looseVisible.length)}
                      expanded={groups.pages.has(TASKS_FOLD_KEY)}
                      onMore={() => setGroups((current) => showMoreInGroup(current, TASKS_FOLD_KEY))}
                      onLess={() => setGroups((current) => showLessInGroup(current, TASKS_FOLD_KEY))}
                    />
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>
      </>
      )}

      {/**
       * 左下角的 7 天 token 用量格 + 星云能量体：常驻（不是实验功能），
       * 宽度钉在 216px（SIDEBAR_WIDTH_MIN 的内容宽），侧栏拖宽时保持左对齐。
       * 折叠态（48px 图标条）不渲染——那里放不下 7 格。
       */}
      <UsageMeter running={anyRunning} pet={props.usagePet} onPetChange={props.onUsagePetChange} petSay={props.usageSay} petCard={props.usageCard} />
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
        top: "var(--titlebar-row)",
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
 * 一个工作区 = 它的主智能体（2026-11-21 起侧栏只露这一行）。下面不再列各件活与旧会话：等你、各件活、以前的会话
 * 都在主智能体右栏的进度面板里；行尾的状态汇总告诉你哪个工作区要你（用户 2026-11-17：看行尾图标即可知道）。
 *
 * 改名走**双击名字**：设计系统的纪律是克制，288px 的一行里再挂一个铅笔键
 * 就开始堆图标了；tooltip 负责把这句话讲出来（*Tooltips carry the second half
 * of the sentence*）。移除走两段式，和删会话一致。
 */
function WorkspaceGroup(props: {
  workspace: Workspace;
  /** 主智能体自己与名下没了结的活 / 会话各自的运行态（Sidebar 的 workspaceStates），行尾汇总 */
  states: readonly SessionRunState[];
  /** 「以前的会话」那一页有几条；0 = 不出悬停的入口 */
  earlierCount: number;
  /** 这个工作区的主智能体此刻正打开着：组头那一行高亮 */
  mainActive: boolean;
  /** 点组头那一行（名字或图标）= 跟它的主智能体说话 */
  onOpenMain: () => void;
  /** 悬停的「以前的会话」：开侧栏那一页 */
  onOpenEarlier: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
  /** 悬停的「查看工作区文件」 */
  onBrowse: () => void;
  /** 这一组正处在勾选态（悬停的「迁移任务…」进入：开「以前的会话」那一页，行首出勾选框） */
  checking: boolean;
  onStartChecking: () => void;
  /** 组头的「完成」：退出勾选态、清掉多选 */
  onDoneChecking: () => void;
}) {
  const t = useT();
  const [armed, setArmed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  // 行尾的运行态汇总：工作区下面不列行，这是「里面还有东西在干活 / 在等你」的唯一信号（2026-10-30 用户点名，
  // 2026-11-21 起每个工作区都只占这一行、都带汇总）。名下有等你的事时那个数用橙色字（饼的颜色规矩不动）
  const agg = aggregateRunStates(props.states);

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
      {/*
        组头这一行就是主智能体（2026-11-17）：点名字或行首图标 = 跟它说话，正打开着时整行高亮
        （与会话行同一套 .option-row 的悬停 / 选中底）。原来行尾的「+ 在此工作区新建任务」去掉——
        工作区里不再新开会话，事情都交给它。
      */}
      <div
        className="option-row"
        data-active={props.mainActive || undefined}
        onClick={(event) => {
          // 只认点在行身空白处；行里的按钮各管各的
          if (event.target === event.currentTarget) props.onOpenMain();
        }}
        style={{
          display: "grid",
          gridTemplateColumns: "24px 24px minmax(0,1fr) auto",
          alignItems: "center",
          gap: "var(--space-1)",
          minHeight: "var(--control-height-md)",
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        {/* 原来的折叠箭头位：展开谁跟着「当前在哪」走，不再手动折（满载 12 个工作区时手动折叠没人管得过来）。
            位子留着，名字与子行的缩进不动 */}
        <span />

        <span
          onClick={props.onOpenMain}
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
          // 名字是一个按钮：键盘 Tab 到这里、回车即进主智能体；双击照旧改名
          <button
            type="button"
            title={`${t.sidebar.openMainAgentTip(props.workspace.name)} · ${t.sidebar.workspacePathTip(props.workspace.path)}`}
            aria-current={props.mainActive ? "page" : undefined}
            onClick={props.onOpenMain}
            onDoubleClick={() => setEditing(props.workspace.name)}
            style={{
              minWidth: 0,
              padding: 0,
              border: 0,
              background: "transparent",
              color: "inherit",
              textAlign: "left",
              fontFamily: "var(--font-family-base)",
              fontSize: "var(--font-size-base)",
              fontWeight: "var(--weight-semibold)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              cursor: "pointer",
            }}
          >
            {/* 名字原样显示——「名字 == 路径」的老数据在 store 读时已治；悬停 tooltip 看全路径 */}
            {props.workspace.name}
          </button>
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
              fontSize: "var(--font-size-base)",
              fontWeight: "var(--weight-semibold)",
              outline: "none",
              boxShadow: "var(--focus-ring)",
            }}
          />
        )}

        <span style={{ position: "relative", display: "inline-flex", alignItems: "center", justifyContent: "flex-end" }}>
          {agg.length > 0 && (
            <span className="run-agg ws-agg" aria-label={agg.map((a) => `${runStateLabel(a.state, t)} ${a.count}`).join(" · ")}>
              {agg.map((a) => (
                <span key={a.state} data-state={a.state} title={runStateLabel(a.state, t)}>
                  <StatusPie state={a.state} />
                  {a.count}
                </span>
              ))}
            </span>
          )}
          {/**
            悬停动作簇（静止不占位）：「查看工作区文件」（list-tree，zcode 同款）
            在删除键前面——浏览是常事，删除是两段式。
          */}
          {props.checking ? (
            // 勾选态里常显的出口（不等悬停）：用户得一眼看到怎么退出
            <button type="button" className="sidebar-selection-move" onClick={props.onDoneChecking}>
              {t.sidebar.checkDone}
            </button>
          ) : (
            props.earlierCount > 0 && (
              <IconButton
                label={t.sidebar.moveTasks}
                title={t.sidebar.moveTasks}
                size={20}
                onClick={props.onStartChecking}
                className="reveal workspace-group-act"
                style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-tertiary)" }}
              >
                <Icon name="folder-sync" size={14} strokeWidth={1.8} />
              </IconButton>
            )
          )}
          {props.earlierCount > 0 && (
            <IconButton
              label={t.sidebar.earlierSessions(props.earlierCount)}
              title={t.sidebar.earlierSessionsTip}
              size={20}
              onClick={props.onOpenEarlier}
              className="reveal workspace-group-act"
              style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-tertiary)" }}
            >
              <Icon name="history" size={14} strokeWidth={1.8} />
            </IconButton>
          )}
          <IconButton
            label={t.focus.browseFiles}
            title={t.focus.browseFiles}
            size={20}
            onClick={props.onBrowse}
            className="reveal workspace-group-act"
            style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-tertiary)" }}
          >
            <Icon name="list-tree" size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton
            label={armed ? t.sidebar.removeArmed : t.sidebar.remove}
            title={
              armed
                ? t.sidebar.removeArmedTip
                : t.sidebar.removeTip
            }
            size={20}
            onClick={() => (armed ? props.onRemove() : setArmed(true))}
            className="reveal workspace-group-act"
            style={{
              borderRadius: "var(--radius-xs)",
              color: armed ? "var(--color-danger)" : "var(--color-text-tertiary)",
              // armed（二次确认已按下）常显，不等 hover——armed 只有 mouseleave 才清
              opacity: armed ? 1 : undefined,
            }}
          >
            <Icon name="trash-2" size={11} />
          </IconButton>
        </span>

      </div>

    </div>
  );
}

/** 分组标题：UI 字、sm、semibold、secondary，句首大写照原文（设计系统 *Group labels*） */
function NodeLabel(props: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-sm)",
        fontWeight: "var(--weight-semibold)",
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
 * 列哪几条：前 limit 条；打开着的会话排在线以下时**单独补在末尾**——不然组展开了、
 * 高亮的那行却藏在「Show more」里，用户照样看不出自己在哪。只补它一条，不把线
 * 整段拉到它那里（否则排第 13 的会话一打开，Show less 就形同虚设）。
 */
function visibleWithOpen<T extends { id: string }>(sessions: readonly T[], limit: number, openId: string | null): T[] {
  const head = sessions.slice(0, limit);
  const open = openId === null ? undefined : sessions.find((m) => m.id === openId);
  return open !== undefined && !head.includes(open) ? [...head, open] : head;
}

/**
 * 「移到…」的目标清单（行菜单与多选条共用）：无工作区（回到 TASKS）+ 全部工作区。
 * current = 打勾的那一项；undefined = 不打勾（批量时一批可能来自不同工作区）。
 * 迁移会连工作目录一起换（session:move），在跑的跳过——由调用方的 onMove 报告。
 */
function moveTargetItems(
  t: Messages,
  workspaces: readonly Workspace[],
  ids: readonly string[],
  current: string | null | undefined,
  onMove: (ids: readonly string[], target: string | null) => void,
): MenuItem[] {
  return [
    { id: "move-header", label: t.sidebar.moveHeader, header: true },
    {
      id: "none",
      label: t.sidebar.noWorkspaceTarget,
      icon: "folder",
      checked: current === null,
      onSelect: () => onMove(ids, null),
    },
    ...workspaces.map((workspace): MenuItem => ({
      id: workspace.id,
      label: workspace.name,
      icon: "folder" as const,
      checked: current === workspace.id,
      onSelect: () => onMove(ids, workspace.id),
    })),
  ];
}

/**
 * 「Show N more / Show less」行：垫在列表尾。**条数写进文案**——被藏起来多少
 * 这件事不能是悄悄的（下一次放几条、一共还藏几条）。还有藏着的就是 Show more；
 * 全放完了且点过 Show more，原地变成 Show less，收回默认预览（排序保证前 N 条
 * 就是最近 N 条，置顶恒在最前）。没藏、也没点过，就不出现。
 */
function ShowMoreRow(props: {
  hidden: number;
  next: number;
  expanded: boolean;
  onMore: () => void;
  onLess: () => void;
}) {
  const t = useT();
  const hidden = props.hidden;
  if (hidden === 0 && !props.expanded) return null;
  const more = hidden > 0;
  return (
    <NavRow
      icon={more ? "chevron-down" : "chevron-up"}
      label={more ? t.sidebar.showMore(props.next, hidden) : t.sidebar.showLess}
      active={false}
      tone="var(--color-text-tertiary)"
      onClick={more ? props.onMore : props.onLess}
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
  /** 图标槽换成别的东西（勾选态的勾选框）；给了就不画 icon */
  leading?: React.ReactNode;
  label: string;
  active: boolean;
  onClick?: ((event: React.MouseEvent<HTMLButtonElement>) => void) | undefined;
  disabled?: boolean;
  tone?: string;
  spin?: boolean;
  /** 图标槽的悬停说明（会话行用它讲状态） */
  iconTitle?: string;
  /** 整行的悬停说明（planned 的东西用它讲为什么点不动） */
  hint?: string;
  /**
   * 行首的状态饼（2026-10-30，取代 10-10 的状态饼）：running = 1/3 蓝，
   * waiting = 2/3 橙，done = 满绿，failed = 满红；读完就不亮（undefined）。状态由
   * sessionRunState 推导（与侧栏顶「等你」同一份真源）；占行首状态槽，亮着时盖过
   * fork / pin。规则在 styles.css 的 `.status-pie`。**静态，无动效**。
   */
  bar?: "running" | "waiting" | "done" | "failed" | undefined;
  /** 状态饼的悬停说明（状态的可读名字） */
  barTitle?: string;
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
        fontSize: "var(--font-size-base)",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : clickable ? "pointer" : "default",
        ...props.style,
      }}
    >
      {/* 行首 14px 状态槽：亮着的状态饼优先（在跑 / 等你 / 跑完没看 / 出错没看），
          否则画静态标记（fork / pin），都没有就留空槽占位——标题才对得齐 */}
      <span
        title={props.bar !== undefined ? props.barTitle : props.iconTitle}
        style={{
          display: "grid",
          placeItems: "center",
          flex: "0 0 auto",
          width: 14,
          height: 14,
          color: disabled ? "var(--color-text-tertiary)" : (props.tone ?? "var(--color-text-secondary)"),
        }}
      >
        {props.leading !== undefined ? (
          props.leading
        ) : props.bar !== undefined ? (
          <StatusPie state={props.bar} />
        ) : props.icon === null ? null : (
          <Icon name={props.icon} size={14} strokeWidth={1.8} spin={props.spin ?? false} />
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
 * 一条会话。状态在三处各说各的：行最左的状态饼说运行态（在跑 / 在等你 / 跑完没看 /
 * 跑挂没看），行首图标槽只剩静态标记（子会话 git-fork / 置顶图钉），行尾是星标、
 * 完成勾与遗留角标——**状态优先用图标与文字，颜色是第二信号**（tooltip 补齐文字）。
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
  /** 状态饼由调用方给（主智能体派出的活要看通道状态）；缺席 = 按 runStateOf 现算 */
  bar?: SessionRunState | undefined;
  active: boolean;
  onClick: (event: React.MouseEvent) => void;
  /** 勾选态：true / false = 画勾选框（是否勾上）；undefined = 不在勾选态 */
  checkbox?: boolean | undefined;
  /** 菜单「移到…」搬哪些：这一行在多选里就是整批，否则只有它自己 */
  moveIds: readonly string[];
  onMove: (ids: readonly string[], target: string | null) => void;
}) {
  const t = useT();
  const { meta, session } = props;
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<"main" | "move" | "delete" | "archive">(
    "main",
  );
  /**
   * 删除确认步要说的「工作台里有几个文件」。删会话连带删工作台，确认项先把
   * 后果说出来（提示后删，Proma 是不提示直接删，我们多这一句）。null = 没拉到
   * 或里面没文件，文案退回光秃秃的 Delete permanently。
   */
  const [workbenchFiles, setWorkbenchFiles] = useState<number | null>(null);
  // 行的运行态查它自己的槽：后台在跑的会话切走了也照样亮状态饼，与「当前看哪条」无关。
  // 子会话只取一层（childSessions 同口径）——子会话在跑 / 在等你都记到母会话
  // 这一行的状态饼上（入口在母），fork 图标再补「跑的是孩子」那一句
  const children = childSessions(session.sessions, meta.id);
  // 状态饼（sessionRunState，与侧栏顶「等你」同一份真源）
  const bar = props.bar !== undefined ? props.bar : runStateOf(session, meta);
  /**
   * 行首状态槽：subRunning > pinned > 空。运行 / 未读 / 失败已归状态饼，槽里只剩
   * 静态标记。优先级与理由在 `row-status.ts`（纯函数 + 测试）。`null` = 这一
   * 行没什么可说，槽留空。
   */
  const status = rowStatusIcon(
    {
      subRunning:
        session.phaseOf(meta.id) === "idle" &&
        children.some((child) => session.phaseOf(child.id) !== "idle"),
      pinned: meta.pinned === true,
    },
    t,
  );
  // 行尾常显的「多久没动了」（按最后活动 updatedAt，格式见 sessionAgeLabel）；每分钟随 Sidebar 重渲染刷新
  const ageLabel = sessionAgeLabel(meta.updatedAt, Date.now(), t);
  // 删父连带删子（session.ts 的级联契约）：删除确认要把这个后果说出来，不能只
  // 提工作台文件数——子会话数是更容易被忽略、也更重的一条后果（子会话 PR4c 2.4）
  const childCount = children.length;

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
      : step === "move"
        ? moveTargetItems(
            t,
            session.workspaces,
            props.moveIds,
            // 批量时不打勾：一批里可能来自不同工作区
            props.moveIds.length > 1 ? undefined : meta.workspaceId,
            props.onMove,
          )
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
              label: props.moveIds.length > 1 ? t.sidebar.moveCount(props.moveIds.length) : t.sidebar.moveTo,
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
            {
              id: "delete",
              label: t.sidebar.deleteTask,
              icon: "trash-2",
              danger: true,
              keepOpen: true,
              onSelect: enterDeleteStep,
            },
          ];
  // 主智能体派出的活（子会话）也挂在侧栏：子会话不置顶、不归档、不单独搬（契约：随母会话走），菜单里不给这几项
  const menuItems = meta.parentId === undefined ? items : items.filter((item) => !CHILD_ROW_HIDDEN.has(item.id));

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
            style={{ height: 22, fontSize: "var(--font-size-base)" }}
          >
            {null}
          </InlineName>
        </span>
      ) : (
        <NavRow
          icon={status?.icon ?? null}
          leading={
            props.checkbox === undefined ? undefined : (
              <span className="row-check" data-checked={props.checkbox || undefined}>
                {props.checkbox && <Icon name="check" size={10} strokeWidth={3} />}
              </span>
            )
          }
          label={meta.title === "" ? t.common.newTask : meta.title}
          hint={t.time.lastActiveAt(meta.updatedAt)}
          tone={status?.tone}
          iconTitle={status?.label}
          active={props.active}
          bar={bar ?? undefined}
          barTitle={bar === null ? undefined : barLabel(bar, t, children.some((child) => session.interruptedOf(child.id)))}
          onClick={props.onClick}
          style={{ flex: 1, minWidth: 0 }}
        />
      )}
      {/**
        行尾是**叠在同一格里的两层**（2026-11-07 用户：「不 hover 的时候看不出会话是几天前的」）：
        - 静止层 `.task-row-rest`：已星标 / 已完成 / 遗留角标（常显的标记，accent）+ 「多久没动了」。
          纯视觉（aria-hidden、不接指针）——要点任何东西必须先把指针移上这一行，那时已换成悬停层。
        - 悬停层 `.task-row-acts`：星标 / 完成 / 角标 / 更多四个真按钮，静止全透明（含已标记的，它们的
          常显改由静止层画），悬停 / 键盘聚焦 / 菜单开着时浮出，同时静止层淡出。
        两层同格重叠、格宽取两者较宽的，所以悬停时行高与标题截断位置都不跳；常见情形（至多一枚标记 +
        不超过 4 个字的时间）静止层不比悬停层宽，罕见的「星标 + 完成 + 角标」才会把这一行的格撑宽一点。
        分层规则与淡出信号在 styles.css 的 `.task-row-tail`。
      */}
      <span className="task-row-tail">
        <span className="task-row-rest" aria-hidden="true">
          {meta.starred === true && (
            <span className="task-row-mark" style={{ color: "var(--color-accent)" }}>
              <Icon name="star" size={13} strokeWidth={1.8} fill />
            </span>
          )}
          <span className="task-row-age">{ageLabel}</span>
        </span>
        <span className="task-row-acts">
          {/**
            星标：**既是标识也是开关**，独立小槽，不占状态位——状态位归运行态
            （running/failed/idle），置顶已占了 idle 档，再挤进去就要三选一。
            已星标时静止层常显实心 accent 星，未星标只在悬停 / 键盘聚焦时浮出描边形（tertiary）——
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
            }}
          >
            <Icon name="star" size={13} strokeWidth={1.8} fill={meta.starred === true} />
          </IconButton>
          <Menu
            items={menuItems}
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
                // 菜单开着时 CSS 的 :has([aria-expanded="true"]) 让悬停层继续显示、静止层继续让位
                ariaExpanded={open}
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
        </span>
      </span>
    </div>
  );
}

/**
 * 已归档里的工作区组头：folder 图标（与侧栏工作区组头同一枚）+ 名字 + 条数，条数钉在行右。
 * 「任务」组（没有工作区的）不画图标，与侧栏 TASKS 节点一样只有名字。
 */
function WsGroupHead(props: { workspace: Workspace | null; count: number }) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", minHeight: "var(--control-height-md)" }}>
      {props.workspace !== null && (
        <span style={{ display: "grid", placeItems: "center", width: 20, flex: "none", color: "var(--color-text-tertiary)" }}>
          <Icon name="folder" size={13} strokeWidth={1.8} />
        </span>
      )}
      <strong
        title={props.workspace?.name}
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          fontSize: "var(--font-size-sm)",
          fontWeight: "var(--weight-semibold)",
          color: "var(--color-text-secondary)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {props.workspace?.name ?? t.sidebar.tasks}
      </strong>
      <span
        style={{
          flex: "none",
          fontSize: "var(--font-size-sm)",
          fontVariantNumeric: "tabular-nums",
          color: "var(--color-text-tertiary)",
        }}
      >
        {props.count}
      </span>
    </div>
  );
}

/** 侧栏的空态：共享的 PanelEmpty（图标 + 一句 + 出口），对到侧栏行的版式上（.sidebar-empty） */
function Empty(props: {
  icon?: IconName;
  busy?: boolean;
  exit?: { label: string; onClick: () => void };
  children: React.ReactNode;
}) {
  return (
    <PanelEmpty icon={props.icon} busy={props.busy} exit={props.exit} className="sidebar-empty">
      {props.children}
    </PanelEmpty>
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
        fontSize: "var(--font-size-sm)",
        lineHeight: "var(--line-height-ui)",
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
          fontSize: "var(--font-size-sm)",
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
