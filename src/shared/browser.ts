/**
 * 受管浏览器契约 —— IPC 四层的第 1 层。
 *
 * 定位（2026-09-27 wafo 裁决）：浏览器是 **agent 的工具**，不是用户的浏览器。用户想浏览
 * 就用自己的浏览器；与 agent 共用的时刻只有交接（登录 / 验证码 / 授权）。
 *
 * 形态：网页是主进程持有的 `WebContentsView`，放在**独立的沙盒窗口**里——不嵌进主窗口，
 * 原生视图压住 DOM 浮层的问题（参考 proma-ai/Proma#1817 #2007 #1909）从布局上不存在。
 * 沙盒窗口上方是工具条（我们自己的页面，走同一个 preload），下方是网页；两块上下分区、不重叠。
 *
 * tab：一个「你的」tab（用户登录用，不属于任何会话）+ 每个用过浏览器的会话一个 agent tab。
 * 全部由主进程持有、共用同一个 partition（登录态共享）；窗口一次只显示一个，其余在后台照跑——
 * agent 操作自己的 tab 不抢用户的屏幕。
 *
 * 交接（第三刀）：agent 碰到登录墙 / 验证码 / 授权时调 `request_user_action`，把自己的 tab
 * 交给用户。交接期间这个 tab 的操作队列被占住——agent 的后续浏览器调用排在用户交还之后，
 * 这就是最小的「控制权令牌」。聊天里的交接卡直接从那次工具调用渲染，按 toolCallId 定位。
 *
 * 下载（第三刀）：agent tab 的下载落进会话工作台 `downloads/`（PDF 强制下载而不是在 tab 里
 * 显示——agent 读不了查看器里的字）；「你的」tab 的下载落进用户指定的目录（设置 › 浏览器，
 * 缺席 = 系统下载文件夹），这个目录每轮告诉 agent，agent 可以帮用户整理。
 *
 * 调用方：
 *   主窗口    → `browserOpen`（RightRail 入口）、`browserClearData` / 下载目录三件（设置 › 浏览器）、
 *               交接卡的 `browserShowHandoff` / `browserResolveHandoff`
 *   工具条    → 导航四件套、切 / 关 tab、交接提示栏的 `browserResolveHandoff`、`browserGetState` / 订阅 `browserState`
 *   agent 进程 → `browserRequest` / `browserResult`（在 agent-ipc.ts，requestId 问答，read_task 同款）
 * 网页本身不加载任何 preload，碰不到这里的任何通道。
 */

export const browserChannels = {
  /** 打开或聚焦沙盒窗口（懒创建），显示「你的」tab。窗口关过只是隐藏，再开页面与登录态都还在 */
  browserOpen: "browser:open",
  /** 清除沙盒 partition 的全部数据（cookie、站点存储、缓存）。登录态随之清空 */
  browserClearData: "browser:clear-data",
  /** 地址栏提交（作用于正在显示的 tab）。输入由主进程规范化；不是网址回 `{ ok: false }`，不抛 */
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  /** 加载中 = 停止，否则 = 刷新：同一个按钮的两面，由主进程按当下状态决定 */
  browserReloadOrStop: "browser:reload-or-stop",
  /** 工具条切到某个 tab */
  browserSelectTab: "browser:select-tab",
  /** 关掉一个 agent tab。「你的」tab 不可关（它是登录入口）；agent 下次用浏览器会重开一个 */
  browserCloseTab: "browser:close-tab",
  /** 交接卡「去浏览器完成」：打开窗口、切到那次交接的 tab、提到最前（按 toolCallId 定位） */
  browserShowHandoff: "browser:show-handoff",
  /** 交接结束：用户点「完成，交还」或「取消」（交接卡与窗口提示栏共用）。按 toolCallId 定位 */
  browserResolveHandoff: "browser:resolve-handoff",
  /** 「你的」tab 的下载目录（生效值：设置里指定的，缺席 = 系统下载文件夹） */
  browserDownloadDir: "browser:download-dir",
  /** 选一个目录作为下载目录（系统目录选择框），落进设置；取消回 null */
  browserPickDownloadDir: "browser:pick-download-dir",
  /** 在系统文件管理器里打开下载目录 */
  browserRevealDownloadDir: "browser:reveal-download-dir",
  /** 工具条首帧拉一次当前状态；之后靠 `browserState` 推送 */
  browserGetState: "browser:get-state",
  /** 主进程 → 工具条：tab 列表或正在显示的页面有变化。单向推送 */
  browserState: "browser:state",
  /**
   * 主进程 → 工具条：聚焦并全选地址栏。Cmd+L 在网页里按下时键盘事件落在网页的
   * webContents，工具条收不到——由主进程截下后转过来。打开空窗口时也发一次
   */
  browserFocusAddress: "browser:focus-address",
} as const;

export type BrowserChannel = (typeof browserChannels)[keyof typeof browserChannels];

/** 正在显示的页面状态。url 是页面当前真实地址，不是用户在地址栏里正打的字 */
export interface BrowserPageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** tab 条上的一格 */
export interface BrowserTabSummary {
  id: string;
  /** 「你的」tab 恒为 user；agent tab 带所属会话，工具条用会话标题区分 */
  owner: { kind: "user" } | { kind: "agent"; sessionId: string; sessionTitle: string };
  title: string;
  url: string;
  loading: boolean;
  /** 这个 tab 正交给用户：agent 在等（reason 是它说的原因）。缺席 = 没有交接 */
  handoff?: BrowserHandoff;
}

/** 一次交接：toolCallId 是那次 request_user_action 调用，交接卡与提示栏都按它定位 */
export interface BrowserHandoff {
  toolCallId: string;
  reason: string;
}

export type BrowserHandoffOutcome = "done" | "cancelled";

/** 工具条的全部状态：tab 条 + 正在显示的那一页 */
export interface BrowserWindowState {
  tabs: BrowserTabSummary[];
  shownTabId: string;
  page: BrowserPageState;
}

/** 地址栏提交的结果。不是网址就搜索；只有空输入回 not-an-address */
export type BrowserNavigateResult = { ok: true } | { ok: false; reason: "not-an-address" };

/**
 * 读取类工具读哪个 tab：缺席 = agent 自己的 tab；"user" = 「你的」tab（**只读**）。
 * 用户常常自己先打开并登录好了（例如经图书馆代理进 Scopus）——agent 读得到它，
 * 要操作就在自己的 tab 里打开同一个地址（登录态共享）。
 */
export type BrowserReadTarget = "user";

/**
 * 交互动作的落点：`browser_observe` 给的元素引用（`e12`），或最近一次整页截图里的像素坐标。
 *
 * 两条都要：引用精确、不怕布局变化，是首选；但 canvas、图表、没有无障碍信息的自绘控件
 * 在大纲里没有引用，只能看图点坐标（Anthropic browser toolset 同形：click 的目标二选一）。
 * 引用在页面换成新文档（跨文档导航）时作废；坐标在页面滚动或变化后就不准了。
 */
export type BrowserTarget = { ref: string } | { x: number; y: number };

/** 截图局部放大的区域：整页截图里的像素（左上角 + 宽高） */
export interface BrowserRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserScrollDirection = "up" | "down" | "left" | "right";

/**
 * agent 的浏览器工具请求（agent 进程 → 主进程，作用于该会话自己的 agent tab）。
 * 读取类、滚动与交接各档免审批（shared/permission.ts 的 BROWSER_READ_TOOLS / USER_ACTION_TOOL）；
 * 点击、输入、按键会改变页面状态（提交表单、下单、发消息），照写操作过闸。
 * 交互动作只作用于 agent 自己的 tab——「你的」tab 只读（2026-09-27 裁决）。
 */
export type BrowserToolRequest =
  /** url 也可以是搜索词：不是网址就交给搜索引擎（地址栏同一条规则） */
  | { action: "navigate"; url: string }
  /** 在 agent tab 的历史里后退 / 前进一步（browser_navigate 的 url 传 back / forward） */
  | { action: "history"; direction: "back" | "forward" }
  | { action: "observe"; maxNodes?: number; tab?: BrowserReadTarget }
  | { action: "extract"; offset?: number; maxChars?: number; links?: boolean; tab?: BrowserReadTarget }
  /**
   * save：另存一份原图进会话工作台 screenshots/，结果给路径（默认不存，截图只给模型看）。
   * region：只拍整页截图里的这一块、放大给模型看（小字、图表细节）；放大图的像素不是点击坐标
   */
  | { action: "screenshot"; save?: boolean; tab?: BrowserReadTarget; region?: BrowserRegion }
  | { action: "click"; target: BrowserTarget }
  /**
   * 输入文字。带 ref：先聚焦那个字段，默认清空后再输（clear: false 追加）；`<select>` 按选项文字选中。
   * 不带 ref：输进当前有焦点的元素（先点坐标再输的路径）。submit：输完按 Enter
   */
  | { action: "type"; text: string; ref?: string; clear?: boolean; submit?: boolean }
  /** 按键或组合键，如 Enter、Tab、Escape、ArrowDown、Shift+Tab、ControlOrMeta+A；repeat 连按几次 */
  | { action: "press"; key: string; repeat?: number }
  /** 滚动 amount 屏（默认 1）。target：在那个元素 / 坐标所在的可滚动区域里滚（缺席 = 视口中央） */
  | { action: "scroll"; direction: BrowserScrollDirection; amount?: number; target?: BrowserTarget }
  /** 列出 agent 看得到的 tab：「你的」tab 与本会话的 agent tab（别的会话的 tab 不列） */
  | { action: "tabs" }
  /** request_user_action：把 tab 交给用户，等用户交还（或取消、或这一轮被停掉） */
  | { action: "handoff"; toolCallId: string; reason: string };

/**
 * 工具卡：只给 UI、不入模型上下文（pi ToolResult 的 `details` 通路，ReadTaskCard 同款）。
 * 第二刀 renderer 还不画卡——先把载荷定下来，工具行摘要用 toolCallSummary 从入参取。
 */
export interface BrowserToolCard {
  tabId: string;
  url: string;
  title: string;
  /** 交接的结局（request_user_action 才有）：交接卡据此显示「已交还 / 已取消」，不解析给模型的文字 */
  handoff?: BrowserHandoffOutcome;
}

/** browserRequest 的回执载荷：主进程组装，agent 进程翻成工具结果 */
export type BrowserToolOutcome =
  | {
      ok: true;
      /** 给模型的正文（页面内容已标注为不可信输入） */
      text: string;
      /** screenshot 才有：已缩放压成 JPEG 的截图 */
      image?: { data: string; mimeType: "image/jpeg" };
      card: BrowserToolCard;
    }
  | { ok: false; error: string };
