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
 * 调用方：
 *   主窗口    → `browserOpen`（RightRail 入口）、`browserClearData`（设置 › 浏览器）
 *   工具条    → 导航四件套、切 / 关 tab、`browserGetState` / 订阅 `browserState`
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
}

/** 工具条的全部状态：tab 条 + 正在显示的那一页 */
export interface BrowserWindowState {
  tabs: BrowserTabSummary[];
  shownTabId: string;
  page: BrowserPageState;
}

/** 地址栏提交的结果。不做搜索回退：不是网址就如实说，由工具条提示 */
export type BrowserNavigateResult = { ok: true } | { ok: false; reason: "not-an-address" };

/**
 * agent 的浏览器工具请求（agent 进程 → 主进程，作用于该会话自己的 agent tab）。
 * 第二刀只有只读四件，各档免审批（shared/permission.ts 的 BROWSER_READ_TOOLS）。
 */
export type BrowserToolRequest =
  | { action: "navigate"; url: string }
  | { action: "observe"; maxNodes?: number }
  | { action: "extract"; offset?: number; maxChars?: number; links?: boolean }
  | { action: "screenshot" };

/**
 * 工具卡：只给 UI、不入模型上下文（pi ToolResult 的 `details` 通路，ReadTaskCard 同款）。
 * 第二刀 renderer 还不画卡——先把载荷定下来，工具行摘要用 toolCallSummary 从入参取。
 */
export interface BrowserToolCard {
  tabId: string;
  url: string;
  title: string;
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
