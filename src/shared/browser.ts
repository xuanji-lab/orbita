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
 * 两个调用方：
 *   主窗口  → `browserOpen`（RightRail 入口）、`browserClearData`（设置 › 浏览器）
 *   工具条  → 导航四件套 + `browserGetState` / 订阅 `browserState`
 * 网页本身不加载任何 preload，碰不到这里的任何通道。
 */

export const browserChannels = {
  /** 打开或聚焦沙盒窗口（懒创建）。窗口关过只是隐藏，再开页面与登录态都还在 */
  browserOpen: "browser:open",
  /** 清除沙盒 partition 的全部数据（cookie、站点存储、缓存）。登录态随之清空 */
  browserClearData: "browser:clear-data",
  /** 地址栏提交。输入由主进程规范化；不是网址回 `{ ok: false }`，不抛 */
  browserNavigate: "browser:navigate",
  browserBack: "browser:back",
  browserForward: "browser:forward",
  /** 加载中 = 停止，否则 = 刷新：同一个按钮的两面，由主进程按当下状态决定 */
  browserReloadOrStop: "browser:reload-or-stop",
  /** 工具条首帧拉一次当前状态；之后靠 `browserState` 推送 */
  browserGetState: "browser:get-state",
  /** 主进程 → 工具条：页面状态变化（导航、标题、加载态）。单向推送 */
  browserState: "browser:state",
  /**
   * 主进程 → 工具条：聚焦并全选地址栏。Cmd+L 在网页里按下时键盘事件落在网页的
   * webContents，工具条收不到——由主进程截下后转过来。打开空窗口时也发一次
   */
  browserFocusAddress: "browser:focus-address",
} as const;

export type BrowserChannel = (typeof browserChannels)[keyof typeof browserChannels];

/** 工具条要画的全部页面状态。url 是页面当前真实地址，不是用户在地址栏里正打的字 */
export interface BrowserPageState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

/** 地址栏提交的结果。第一刀不做搜索回退：不是网址就如实说，由工具条提示 */
export type BrowserNavigateResult = { ok: true } | { ok: false; reason: "not-an-address" };
