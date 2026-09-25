import type { Messages } from "./messages-en.ts";

/**
 * 界面文案表——中文，Manuscript（稿纸）主题下使用。类型由英文真源推出。
 *
 * 写法（全表统一）：
 * - 用语优先照皮肤原型「稿纸」一档的中文版；原型没有的，用平实的现代中文产品说法。
 * - 纯中文：只保留品牌名（orbita）、协议 / 格式名（MCP、API、JSON…）、模型与服务商名、
 *   路径、按键名的英文；守卫测试（messages.test.ts）按白名单把关。
 * - 全角标点；数字、西文与汉字之间留一个半角空格（同原型「2 个子会话」「编辑 mcp.json」）。
 * - 省略号跟原型用单个「…」（菜单项「移到…」、进行中「正在载入…」）。
 */
export const zh: Messages = {
  common: {
    cancel: "取消",
    close: "关闭",
    retry: "重试",
    back: "返回",
    rename: "重命名",
    newTask: "新任务",
    running: "运行中",
    failed: "失败",
    settings: "设置",
    dragResize: "拖动调整宽度 · 双击复原",
    loading: "正在载入…",
  },

  time: {
    justNow: "刚刚",
    minutesAgo: (n) => `${n} 分钟前`,
    hoursAgo: (n) => `${n} 小时前`,
    daysAgo: (n) => `${n} 天前`,
    dateTime: (ms) => new Date(ms).toLocaleString("zh-CN"),
  },

  app: {
    carryoversEntry: (open) => `遗留事项（${open} 项未完成）`,
    archivedEntry: (count) => `已归档（${count}）`,
    skillDraft: "说说想做成技能的是哪一套工作流程。",
  },

  titlebar: {
    minimize: "最小化",
    maximize: "最大化",
    restore: "还原",
  },

  composer: {
    send: "发送",
    stop: "停止",
    stopTurn: "停止这一轮",
  },

  rowStatus: {
    pinned: "已置顶",
  },

  menu: {
    searchModels: "搜索模型…",
    noModels: "没有匹配的模型。",
  },

  rail: {
    files: "文件",
    skills: "技能",
    mcp: "MCP 服务",
    sideChat: "辅助对话 Ctrl+Alt+D",
    subSessions: (count) => `子会话（${count}）`,
    channels: "子会话通道",
  },

  drawer: {
    closeTab: "关闭标签页",
    newTab: "新开标签页",
    pickTitle: "并排打开哪个任务？",
    pickSub: "辅助对话就是一个普通任务：并排显示、侧栏可见、随时切回。中间正开着的那条不列在这里。",
    noOther: "还没有别的任务——新建一条吧。",
  },

  sidebar: {
    emptyHasTodos: "没有带未完成遗留事项的任务。收尾一个任务，它的遗留事项会收到这里。",
    emptyActiveStarred: "没有进行中的星标任务。取消「星标」筛选即可看到其余任务。",
    emptyActive: "眼下没有进行中的任务——都做完了。",
    emptyDoneStarred: "还没有已完成的星标任务。",
    emptyDone: "还没有已完成的任务。在任务上标记完成，它就会出现在这里。",
    emptyStarred: "还没有星标任务。指针移到任务上、点一下星标，它就会出现在这里。",
    expand: "展开侧栏",
    collapse: "收起侧栏",
    collapseTip: "收成图标栏",
    agentMode: "单智能体",
    orchestrate: "编排",
    orchestratePlanned: "编排模式（规划中）",
    filterAll: "全部",
    filterAllTip: "全部任务",
    filterActive: "进行中",
    filterActiveTip: "仍在进行的任务",
    filterDone: "已完成",
    filterDoneTip: "已完成的任务",
    filterStarred: "星标",
    filterStarredTip: "只看星标任务",
    filterTodos: "有待办",
    filterTodosTip: "只看有未完成遗留事项的任务",
    backToTasks: "返回任务",
    backToTasksTip: "返回任务列表",
    archived: "已归档",
    workspaces: "工作区",
    addWorkspace: "添加工作区",
    newWorkspace: "新建工作区…",
    addFolder: "添加文件夹…",
    workspaceName: "工作区名称",
    loadingWorkspaces: "正在载入工作区…",
    noWorkspace: "还没有工作区。添加一个允许智能体读取的文件夹。",
    tasks: "任务",
    loadingTasks: "正在载入任务…",
    noTask: "还没有任务。新开的任务会出现在这里。",
    expandGroup: "展开分组",
    collapseGroup: "收起分组",
    workspacePathTip: (path) => `${path} · 双击重命名`,
    removeArmed: "从列表移除？再点一次。",
    remove: "从列表移除",
    removeArmedTip: "再点一次即移除。文件夹和其中的任务都保留，任务移到「任务」下。",
    removeTip: "从列表移除。磁盘上的文件夹不受影响。",
    newTaskInWorkspace: "在此工作区新建任务",
    showLess: "收起",
    showMore: (hidden) => `再显示 ${hidden} 条`,
    deletePermanently: "永久删除",
    deleteHintSub: (count) => `+${count} 子会话`,
    deleteHintFiles: (count) => `+${count} 文件`,
    archiveTask: "归档任务",
    archiveDoneTasks: (count) => `归档 ${count} 个已完成任务`,
    noWorkspaceTarget: "无工作区",
    unpin: "取消置顶",
    pin: "置顶",
    moveTo: "移到…",
    exportMarkdown: "导出为 Markdown…",
    unarchive: "取消归档",
    archive: "归档…",
    archiveAllDone: (count) => `归档全部已完成（${count}）…`,
    deleteTask: "删除任务…",
    unstar: "取消星标",
    star: "加星标",
    starredTip: "已加星标 · 点击取消",
    reopen: "重新打开任务",
    markDone: "标记为已完成",
    doneWithTodos: (open) => `已完成，还有 ${open} 项遗留未处理 · 点击重新打开`,
    doneTip: "已完成 · 点击重新打开",
    idleSuggest: (days) => `${days} 天以上没有动静 · 标记为已完成？`,
    openTodosLeft: (open) => `还有 ${open} 项遗留未处理`,
    taskActions: "任务操作",
    carryovers: "遗留事项",
    noCarryovers: "还没有遗留事项。收尾一个任务，把没做完的零碎收到这里。",
    sourceDeleted: "来源任务已删除",
    openSource: "打开来源任务",
    deletedTask: "已删除的任务",
    reopenItem: "重新打开这一项",
    markItemDone: "标记这一项已完成",
    continueWithContext: "带上下文继续",
    continueTipResumable: "带着这一项的上下文开新任务 · 右键在原任务里继续",
    continueTip: "带着这一项的上下文开新任务",
    jumpToSource: "跳到来源任务",
    jumpToSourceTip: "打开这一项所在的任务",
  },

  settings: {
    tabs: {
      general: "通用",
      providers: "模型服务",
      migration: "迁移",
    },
  },
};
