/**
 * 界面文案表——英文，**真源**。`messages-zh.ts` 的类型由这里推出（`Messages`），
 * 少一个键、参数签名不一致，typecheck 就不过。
 *
 * 值是字符串，或 `(…) => string`（数量、插值、单复数）。函数参数只用原始类型
 * （number / string），守卫测试（messages.test.ts）要能拿样例参数把每一条都调一遍。
 *
 * 语言不是设置项，由主题派生（locale.ts 的 `localeOfTheme`）：Manuscript 全中文，其余英文。
 * 组件里用 `useT()` 取表；纯函数不读全局，由调用方把表传进去。
 *
 * 分组按界面区域，不按文件——同一句话在两处出现时放 `common`。
 */

const plural = (count: number, one: string, many: string = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

export const en = {
  common: {
    cancel: "Cancel",
    close: "Close",
    retry: "Retry",
    back: "Back",
    rename: "Rename",
    newTask: "New task",
    running: "Running",
    failed: "Failed",
    settings: "Settings",
    dragResize: "Drag to resize · double-click to reset",
    loading: "Loading…",
  },

  time: {
    justNow: "just now",
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    daysAgo: (n: number) => `${n}d ago`,
    /** 绝对时间（文件修改时间等）：跟界面语言走，不跟系统 */
    dateTime: (ms: number) => new Date(ms).toLocaleString("en-US"),
  },

  app: {
    carryoversEntry: (open: number) => `Carryovers (${open} open)`,
    archivedEntry: (count: number) => `Archived (${count})`,
    skillDraft: "Describe the workflow you want to turn into a skill.",
  },

  titlebar: {
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
  },

  composer: {
    send: "Send",
    stop: "Stop",
    stopTurn: "Stop this turn",
  },

  rowStatus: {
    pinned: "Pinned",
  },

  menu: {
    searchModels: "Search models…",
    noModels: "No models match.",
  },

  rail: {
    files: "Files",
    skills: "Skills",
    mcp: "MCP servers",
    sideChat: "Side chat Ctrl+Alt+D",
    subSessions: (count: number) => `Sub-sessions (${count})`,
    channels: "Sub-session channels",
  },

  drawer: {
    closeTab: "Close tab",
    newTab: "New tab",
    pickTitle: "Which task should open side by side?",
    pickSub:
      "A side chat is an ordinary task: shown side by side, listed in the sidebar, switch back any time. The one open in the middle isn't listed here.",
    noOther: "No other task yet — start a new one.",
  },

  sidebar: {
    emptyHasTodos: "No task has open carryover items. Wrap one up to collect them here.",
    emptyActiveStarred: "No active starred tasks. Clear the Starred filter to see the rest.",
    emptyActive: "No active tasks right now — everything is done.",
    emptyDoneStarred: "No starred tasks done yet.",
    emptyDone: "No done tasks yet. Mark a task done from its menu to find it here.",
    emptyStarred: "No starred tasks yet. Hover a task and click its star to find it here.",
    expand: "Expand sidebar",
    collapse: "Collapse sidebar",
    collapseTip: "Collapse to the icon rail",
    agentMode: "Agent mode",
    orchestrate: "Orchestrate",
    orchestratePlanned: "Orchestration mode (planned)",
    filterAll: "All",
    filterAllTip: "All tasks",
    filterActive: "Active",
    filterActiveTip: "Tasks still in progress",
    filterDone: "Done",
    filterDoneTip: "Completed tasks",
    filterStarred: "Starred",
    filterStarredTip: "Show starred tasks only",
    filterTodos: "Has todos",
    filterTodosTip: "Show tasks with open carryover items only",
    backToTasks: "Back to tasks",
    backToTasksTip: "Back to the task list",
    archived: "Archived",
    workspaces: "Workspaces",
    addWorkspace: "Add a workspace",
    newWorkspace: "New workspace…",
    addFolder: "Add a folder…",
    workspaceName: "Workspace name",
    loadingWorkspaces: "Loading workspaces…",
    noWorkspace: "No workspace yet. Add the folder the agent may read.",
    tasks: "Tasks",
    loadingTasks: "Loading tasks…",
    noTask: "No task yet. The one you start lands here.",
    expandGroup: "Expand group",
    collapseGroup: "Collapse group",
    workspacePathTip: (path: string) => `${path} · double-click to rename`,
    removeArmed: "Remove from the list? Click again.",
    remove: "Remove from the list",
    removeArmedTip: "Click again to remove. The folder and its tasks stay — the tasks move to Tasks.",
    removeTip: "Remove from the list. The folder on disk is not touched.",
    newTaskInWorkspace: "New task in this workspace",
    showLess: "Show less",
    showMore: (hidden: number) => `Show ${hidden} more`,
    deletePermanently: "Delete permanently",
    deleteHintSub: (count: number) => `+${count} sub`,
    deleteHintFiles: (count: number) => `+${plural(count, "file")}`,
    archiveTask: "Archive task",
    archiveDoneTasks: (count: number) => `Archive ${plural(count, "done task")}`,
    noWorkspaceTarget: "No workspace",
    unpin: "Unpin",
    pin: "Pin to top",
    moveTo: "Move to…",
    exportMarkdown: "Export as Markdown…",
    unarchive: "Unarchive",
    archive: "Archive…",
    archiveAllDone: (count: number) => `Archive all done (${count})…`,
    deleteTask: "Delete task…",
    unstar: "Unstar this task",
    star: "Star this task",
    starredTip: "Starred · click to unstar",
    reopen: "Reopen this task",
    markDone: "Mark this task done",
    doneWithTodos: (open: number) => `Done with ${plural(open, "open carryover item")} · click to reopen`,
    doneTip: "Done · click to reopen",
    idleSuggest: (days: number) => `Idle for ${days}+ days · mark done?`,
    openTodosLeft: (open: number) => `${plural(open, "open carryover item")} left`,
    taskActions: "Task actions",
    carryovers: "Carryovers",
    noCarryovers: "No carryover items yet. Wrap up a task to collect its loose ends.",
    sourceDeleted: "The source task was deleted",
    openSource: "Open the source task",
    deletedTask: "Deleted task",
    reopenItem: "Reopen this item",
    markItemDone: "Mark this item done",
    continueWithContext: "Continue with context",
    continueTipResumable:
      "Start a new task with this item's context · right-click to continue in the original task",
    continueTip: "Start a new task with this item's context",
    jumpToSource: "Jump to the source task",
    jumpToSourceTip: "Open the task this came from",
  },

  settings: {
    tabs: {
      general: "General",
      providers: "Providers",
      migration: "Migration",
    },
  },
};

export type Messages = typeof en;
