/**
 * 受管浏览器契约 —— IPC 四层的第 1 层。
 *
 * 定位（2026-09-27 wafo 裁决）：浏览器是 **agent 的工具**，不是用户的浏览器。用户想浏览
 * 就用自己的浏览器；与 agent 共用的时刻只有交接（登录 / 验证码 / 授权）。
 * 2026-09-29 用户裁决放宽：界面里点到的链接与文件面板的本地网页默认在这里打开（系统浏览器
 * 退为工具条上的一个按钮），用户的 tab 因此可以有多个。agent 与用户的 tab 仍然分开。
 *
 * 形态：网页是主进程持有的 `WebContentsView`，放在**独立的沙盒窗口**里——不嵌进主窗口，
 * 原生视图压住 DOM 浮层的问题（参考 proma-ai/Proma#1817 #2007 #1909）从布局上不存在。
 * 沙盒窗口上方是工具条（我们自己的页面，走同一个 preload），下方是网页；两块上下分区、不重叠。
 *
 * tab：用户的 tab（不属于任何会话；至少一个，可新开、可关）+ 每个用过浏览器的会话一个 agent tab。
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
 *               交接卡的 `browserShowHandoff` / `browserResolveHandoff`、登录状态导入四件（设置 › 浏览器，仅 macOS）
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
  /**
   * 关掉一个 tab。用户的 tab 关掉最后一个时补一个空白的（窗口里总有一个用户的 tab，它是登录入口）；
   * agent tab 关掉后 agent 下次用浏览器会重开一个
   */
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
  // ── 登录状态导入（设置 › 浏览器 › 登录状态；新键一律追加在末尾）──
  /** 列出本机检测到的可导入来源（浏览器 × profile）。macOS 之外回空数组 */
  browserImportSources: "browser:import-sources",
  /** 读取一个来源：主进程取钥匙串密钥 → 读 cookie 库 → 解密 → 按网站分组。
   * cookie 值只留在主进程内存里，renderer 只拿「网站 + 条数」与一个 pendingId */
  browserImportRead: "browser:import-read",
  /** 把 pending 下勾选网站的 cookie 写进受管浏览器 partition，回计数 */
  browserImportCommit: "browser:import-commit",
  /** 丢弃一个 pending（取消导入）。幂等 */
  browserImportCancel: "browser:import-cancel",
  /** 已导入的网站：导入账本 + 受管浏览器 cookie 现状（这个网站此刻还有没有 cookie） */
  browserImportedList: "browser:imported-list",
  /** 移除一个已导入的网站：删掉受管浏览器里该网站的全部 cookie，并从账本销掉，回新清单 */
  browserImportedRemove: "browser:imported-remove",
  /**
   * 工具条「用系统浏览器打开」：把正在显示的页面交给系统默认应用（http(s) 走默认浏览器，
   * 本地网页走默认打开方式）。链接默认进内置浏览器，这是想用系统浏览器时的出口
   */
  browserOpenExternal: "browser:open-external",
  /** 工具条「+」：新开一个空白的用户 tab、切过去、光标进地址栏 */
  browserNewTab: "browser:new-tab",
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
  /** 用户的 tab 为 user（可以有多个）；agent tab 带所属会话，工具条用会话标题区分 */
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
 * 读取类工具读哪个 tab：缺席 = agent 自己的 tab；否则是 browser_tabs 列出的某个**用户 tab 的 id**
 * （**只读**）。用户常常自己先打开并登录好了（例如经图书馆代理进 Scopus）——agent 读得到它，
 * 要操作就在自己的 tab 里打开同一个地址（登录态共享）。
 *
 * 用户的 tab 可以有多个，读哪个由模型按上下文自己挑（2026-09-29 用户裁决：不硬编码「读正在看的
 * 那个」）；browser_tabs 如实标出哪个此刻正显示，挑的依据给足，规则不替它定。
 */
export type BrowserReadTarget = string;

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

// ── 登录状态导入（设置 › 浏览器 › 登录状态，仅 macOS）──────────────────

/**
 * 可导入登录状态的来源：浏览器 × profile。只列本机检测到的（用户数据目录在、且 profile
 * 里有 cookie 库）；profile 名读 `Local State` 的 info_cache，缺席回落目录名。
 * 只做与 Chrome 存储格式相同的五种 Chromium 系浏览器；Windows 的 App-Bound 加密需要
 * 提权 helper，Linux 走系统密钥环，都不在这一刀。renderer 拿不到任何密钥或 cookie 值。
 */
export interface BrowserImportSource {
  browserId: "chrome" | "edge" | "brave" | "arc" | "chromium";
  /** 给人看的浏览器名（"Google Chrome"…）。数据，不是文案表的键 */
  browserName: string;
  /** profile 目录名（"Default" / "Profile 1"…） */
  profileId: string;
  /** Local State 里记的显示名，缺席 = profileId */
  profileName: string;
  /** 默认选中（last_used；没有就 Default）。恰有一个 true；无 profile 时整个浏览器不出现 */
  recommended: boolean;
}

/** 读取结果里的一行：网站（近似 eTLD+1 分组）+ 该网站待导入的 cookie 条数 */
export interface BrowserImportSite {
  site: string;
  count: number;
}

/** 读取失败的稳定错误码；renderer 用文案表翻成人话 */
export type BrowserImportReadError =
  /** 非 macOS（设置页不显示这一组，但 IPC 不当安全边界） */
  | "not-supported"
  /** 来源目录 / profile 不在了（浏览器被卸载、数据被清） */
  | "profile-not-found"
  /** profile 里找不到 cookie 库 */
  | "no-cookie-db"
  /**
   * 钥匙串授权被拒绝 / 取消 / 超时。**整个读取终止**：用户对弹框说了「不」，就不能再写
   * 任何一条 cookie——拒绝是授权语义，不是某一条的失败
   */
  | "keychain-denied"
  /** 快照复制或 SQLite 读取失败（含钥匙串里没有该浏览器密钥这类非拒绝错误） */
  | "read-failed";

export type BrowserImportReadResult =
  | { ok: true; pendingId: string; sites: BrowserImportSite[] }
  | { ok: false; error: BrowserImportReadError };

/** 导入结果的一行「已导入 X 条（Y 个网站），跳过 Z 条」的三个数 */
export interface BrowserImportSummary {
  imported: number;
  sites: number;
  /** 解不开 / 已过期 / 写入失败的条数 */
  skipped: number;
}

/**
 * 已导入清单的一行。前四个字段是导入当时记下的事实（账本），present 是每次现查的现状——
 * 受管浏览器的 cookie 库分不出「导入的」和「浏览时网站自己种的」，所以「导入过哪些」只能靠账本。
 */
export interface BrowserImportedSite {
  site: string;
  /** 来源浏览器与 profile 的显示名（导入当时的） */
  browserName: string;
  profileName: string;
  /** 最近一次导入这个网站的时刻（毫秒） */
  importedAt: number;
  /** 受管浏览器里此刻还有这个网站的 cookie。false = 全过期了或被网站清掉，得重新导入 */
  present: boolean;
}

export type BrowserImportCommitResult =
  | { ok: true; summary: BrowserImportSummary }
  /** pendingId 不认识：过期（10 分钟）、被取消或被新一次读取替换 */
  | { ok: false; error: "no-pending" };
