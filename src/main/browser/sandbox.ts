/**
 * 受管浏览器的沙盒窗口与它的 tab。
 *
 * 结构：
 *   BrowserWindow（沙盒窗口）── 自己的 webContents 加载工具条页面（我们的 renderer，同一个 preload）
 *     └─ contentView 子视图：每个 tab 一个 WebContentsView（网页，无 preload，同一个持久化 partition）
 * 工具条占窗口顶部固定高度，网页视图贴在它下面。两块上下分区、永不重叠——这正是把浏览器
 * 放进独立窗口的理由：原生视图不会再压住任何 DOM 浮层，也就不需要任何让位逻辑。
 *
 * tab：
 *   - 用户的 tab：不属于任何会话，可以有多个（2026-09-29：界面里的链接与本地网页默认在这里开，
 *     一个 tab 装不下）。可新开可关，但至少留一个——它是登录入口。
 *   - agent tab：每个用过浏览器的会话一个（agentTab），agent 的工具只作用于自己会话的 tab。
 *   所有 tab 都挂在窗口里、铺满同一块区域；**显示哪个只是 z 序**（重新 addChildView 置顶）。
 *   其余 tab 在下面照常加载、照常渲染——agent 在后台操作自己的 tab 不抢用户的屏幕，
 *   截图也拍得到（没挂进窗口或 setVisible(false) 的视图不绘制，截出来是空的）。
 *
 * 生命周期：
 *   - 懒创建：第一次 open 或第一次 agent 请求才建窗口；agent 建窗不显示窗口。
 *   - 用户关窗 = 隐藏：tab、历史、登录态都保留；agent 在隐藏的窗口里照常工作。
 *   - 应用退出（`prepareQuit` 之后）或最后一个主窗口关闭（`dispose`）才真正销毁。
 *
 * 安全：网页 `sandbox` + `contextIsolation`、不加载 preload；partition 级拒绝一切网页权限请求
 * （定位 / 通知 / 摄像头…）。页面弹窗（window.open 带 features，常见于 SSO）允许开成子窗口，
 * 沿用同一 partition 与同样的约束——拦掉会让弹窗式登录断在半路。
 */
import {
  BrowserWindow,
  Notification,
  WebContentsView,
  session,
  shell,
  type BrowserWindowConstructorOptions,
  type DownloadItem,
  type Session,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  browserChannels,
  type BrowserHandoffOutcome,
  type BrowserNavigateResult,
  type BrowserPageState,
  type BrowserTabSummary,
  type BrowserWindowState,
} from "../../shared/browser.ts";
import { normalizeAddress, resolveAddressOrSearch } from "./address.ts";
import { browserUserAgent } from "./identity.ts";
import { browserShortcut, type BrowserShortcut } from "./shortcuts.ts";
import { availableDownloadPath, forceDownloadHeaders } from "./downloads.ts";
import { placeInUserTab } from "./user-tabs.ts";
import { emptyElementRefs, type ElementRefs } from "./page-outline.ts";
import type { ShotGeometry } from "./screenshot-geometry.ts";

/** 全局一个持久化 partition（2026-09-27 裁决：学校登录是跨工作区的身份，不按工作区分） */
export const BROWSER_PARTITION = "persist:orbita-browser";

/** 工具条高度（tab 条 + 导航行）。工具条页面的 CSS 用同一个值（`--browser-toolbar-height`） */
export const BROWSER_TOOLBAR_HEIGHT = 78;
/** 显示中的 tab 正在交接时，工具条下面多一条提示栏（CSS `--browser-handoff-height`） */
export const BROWSER_HANDOFF_BAR_HEIGHT = 44;
/** 交接等太久自动取消：agent 的一轮不能被一张没人理的卡永远挂着 */
const HANDOFF_TIMEOUT_MS = 30 * 60_000;

/** 网页视图与弹窗子窗口共用的 webPreferences：无 preload，三条安全不变量全开 */
const PAGE_PREFERENCES = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  // agent 在后台 tab 里工作：计时器与渲染不能因为「不在前台」被节流
  backgroundThrottling: false,
} as const;

export interface BrowserTab {
  id: string;
  owner: { kind: "user" } | { kind: "agent"; sessionId: string };
  view: WebContentsView;
  /** 同一个 tab 上的操作排队执行：agent 的并行工具调用不在同一页上交错 */
  queue: Promise<unknown>;
  /** 最近一次主框架导航的 HTTP 状态码（browser_navigate 报给模型） */
  lastStatus: number | null;
  /** agent tab 所属会话的标题，工具条用来区分；异步取到后回填 */
  sessionTitle: string;
  /** 正交给用户：agent 的工具调用在等它结束（占着 queue，agent 碰不到这一页） */
  handoff: PendingHandoff | null;
  /** 这个 tab 触发的下载，按开始时间排；agent 工具按「导航开始之后」认领自己触发的那次 */
  downloads: DownloadRecord[];
  /** 当前文档里发给模型的元素引用（browser_observe 发，click / type 用）。跨文档导航时整张换掉 */
  refs: ElementRefs;
  /** 最近一次整页截图的几何：截图坐标换算成页面坐标靠它。跨文档导航时作废 */
  shot: ShotGeometry | null;
}

interface PendingHandoff {
  toolCallId: string;
  reason: string;
  settle: (outcome: BrowserHandoffOutcome) => void;
}

export interface DownloadRecord {
  url: string;
  path: string;
  startedAt: number;
  /** 下载结束（完成 / 取消 / 中断）时兑现 */
  finished: Promise<{ state: "completed" | "cancelled" | "interrupted"; bytes: number }>;
  /** 已经在某次工具结果里告诉过 agent */
  reported: boolean;
}

export interface BrowserSandboxDeps {
  /** 工具条页面（沙盒窗口自己的 webContents）的窗口选项：preload、主题参数等由 index.ts 装配 */
  toolbarWindowOptions: () => Promise<BrowserWindowConstructorOptions>;
  /** 把工具条页面载入窗口（dev server 与打包产物两条路，同主窗口的装载逻辑） */
  loadToolbar: (window: BrowserWindow) => void;
  /** 会话标题（agent tab 在工具条上的标签）；取不到回空串 */
  sessionTitle: (sessionId: string) => Promise<string>;
  /** 会话工作台路径：agent tab 的下载落进 `<工作台>/downloads/` */
  workbenchPath: (sessionId: string) => string;
  /** 「你的」tab 的下载目录生效值（设置 › 浏览器，缺席 = 系统下载文件夹） */
  userDownloadDir: () => Promise<string>;
  /** 本会话能用的目录（工作台 / cwd / 附加目录 / 浏览器下载）：browser_navigate 打开本地网页只认这些 */
  sessionRoots: (sessionId: string) => Promise<string[]>;
  appName: string;
}

export class BrowserSandbox {
  private readonly deps: BrowserSandboxDeps;
  private window: BrowserWindow | null = null;
  /** 并发 ensureWindow 共用同一次创建（agent 并行工具调用会同时要窗口） */
  private creating: Promise<BrowserWindow> | null = null;
  private readonly tabs = new Map<string, BrowserTab>();
  /** 最近显示过的用户 tab：地球入口回到它，新链接判断「空白页复用」也看它 */
  private lastUserTabId = "";
  private shownTabId = "";
  /** 页面开出的弹窗子窗口：dispose 时一并收掉 */
  private readonly popups = new Set<BrowserWindow>();
  private quitting = false;
  private guardedSession: Session | null = null;
  /**
   * 「你的」tab 下载目录的缓存：will-download 里必须**同步**给出保存路径（晚了 Electron 就弹
   * 保存框），读设置是异步的——建窗时读一次，用户改了（setUserDownloadDir）就更新。
   */
  private userDownloads = "";

  constructor(deps: BrowserSandboxDeps) {
    this.deps = deps;
  }

  // ── 用户侧（主窗口 / 工具条）────────────────────────────────────────

  /**
   * 打开或聚焦沙盒窗口，切到用户的 tab（带 url 就按 placeInUserTab 开：已开着同一地址就切过去，
   * 否则新开）。RightRail 的地球是「我的浏览器」入口：总回到最近用过的那个用户 tab，不停在上次
   * 交接切过去的 agent tab 上——否则你在地址栏里打开的东西会落进 agent 的 tab、下载也跟着进了
   * 那个会话的工作台（冒烟实测到的）。看 agent 的 tab 走交接卡或 tab 条。
   */
  async open(url?: string): Promise<BrowserNavigateResult> {
    const window = await this.ensureWindow();
    let result: BrowserNavigateResult = { ok: true };
    const target = url === undefined ? null : resolveAddressOrSearch(url);
    if (target !== null) this.openInUserTab(target.url);
    else {
      this.show(this.currentUserTab().id);
      if (url !== undefined) result = { ok: false, reason: "not-an-address" };
    }
    bringToFront(window);
    // 空白页打开时光标直接进地址栏：此刻用户要做的只有输入网址这一件事
    if (this.state().page.url === "") window.webContents.send(browserChannels.browserFocusAddress);
    return result;
  }

  /**
   * 文件面板「在内置浏览器打开」：在用户的 tab 里打开一个本地网页（同 open 的落点规则）。
   * 路径已过文件面板的 root/dir 白名单与 isWebPageFile（files/ipc.ts），这里不再判。
   *
   * 落在用户的 tab 而不是会话的 agent tab，理由同 open：你手动打开的东西不该落进 agent 正在用的
   * tab——会打断它手上的操作，下载也会跟着进那个会话的工作台。agent 要看，按 id 只读。
   */
  async openLocalFile(path: string): Promise<void> {
    const window = await this.ensureWindow();
    this.openInUserTab(pathToFileURL(path).href);
    bringToFront(window);
  }

  /** 工具条「+」：新开一个空白的用户 tab，切过去，光标进地址栏 */
  async newTab(): Promise<void> {
    const window = await this.ensureWindow();
    this.show(this.createTab({ kind: "user" }).id);
    window.webContents.send(browserChannels.browserFocusAddress);
  }

  /**
   * 工具条「用系统浏览器打开」：正在显示的页面交给系统。网页走默认浏览器；本地网页（file://）
   * 走它的默认打开方式——openExternal 对 file:// 在各平台行为不一，本地文件统一用 openPath。
   * 空页（没加载过）什么都不做：工具条上这时按钮本来就是灰的。
   */
  async openShownExternally(): Promise<void> {
    const contents = this.shownContents();
    if (contents === null) return;
    const url = pageUrl(contents);
    if (url.startsWith("file:")) {
      const failure = await shell.openPath(fileURLToPath(url));
      if (failure !== "") throw new Error(failure);
      return;
    }
    if (normalizeAddress(url) !== null) await shell.openExternal(url);
  }

  /** 地址栏提交：作用于正在显示的 tab。不是网址就搜索（找不到图书馆入口时先得搜得到） */
  navigate(input: string): BrowserNavigateResult {
    const target = resolveAddressOrSearch(input);
    if (target === null) return { ok: false, reason: "not-an-address" };
    const contents = this.shownContents();
    // loadURL 在被后续导航打断（ERR_ABORTED）或网络失败时 reject：页面自己会显示结果，
    // 这里不当异常抛——用户换个地址重来就好
    if (contents !== null) contents.loadURL(target.url).catch(() => undefined);
    return { ok: true };
  }

  back(): void {
    const history = this.shownContents()?.navigationHistory;
    if (history?.canGoBack() === true) history.goBack();
  }

  forward(): void {
    const history = this.shownContents()?.navigationHistory;
    if (history?.canGoForward() === true) history.goForward();
  }

  reloadOrStop(): void {
    const contents = this.shownContents();
    if (contents === null) return;
    if (contents.isLoading()) contents.stop();
    else contents.reload();
  }

  selectTab(tabId: string): void {
    if (this.tabs.has(tabId)) this.show(tabId);
  }

  /**
   * 关掉一个 tab。用户的 tab 关掉最后一个时 destroyTab 补一个空白的；agent tab 关掉后
   * agent 下次用浏览器会重开一个（登录态在 partition 里，不丢）
   */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined) return;
    this.destroyTab(tab);
  }

  /** 会话删除：它的 agent tab 一并关掉（交接中的先按取消结掉，别让那次工具调用挂着） */
  closeSessionTab(sessionId: string): void {
    const tab = this.findAgentTab(sessionId);
    if (tab === undefined) return;
    this.settleHandoff(tab, "cancelled");
    this.destroyTab(tab);
  }

  /** 交接卡「去浏览器完成」：打开窗口、切到那个 tab、提到最前 */
  async showHandoff(toolCallId: string): Promise<boolean> {
    const tab = this.findHandoffTab(toolCallId);
    if (tab === undefined) return false;
    const window = await this.ensureWindow();
    this.show(tab.id);
    bringToFront(window);
    return true;
  }

  /** 交接结束（交接卡或窗口提示栏上点的）。找不到 = 已经结束过了，幂等 */
  resolveHandoff(toolCallId: string, outcome: BrowserHandoffOutcome): void {
    const tab = this.findHandoffTab(toolCallId);
    if (tab !== undefined) this.settleHandoff(tab, outcome);
  }

  /** 会话这一轮停了（用户点停止、或出错）：它的交接按取消结掉——等的那一方已经不在了 */
  cancelSessionHandoff(sessionId: string): void {
    const tab = this.findAgentTab(sessionId);
    if (tab !== undefined) this.settleHandoff(tab, "cancelled");
  }

  /** 用户在设置里换了下载目录：之后的下载落到新目录 */
  setUserDownloadDir(dir: string): void {
    this.userDownloads = dir;
  }

  state(): BrowserWindowState {
    return {
      tabs: [...this.tabs.values()].map((tab) => summarize(tab)),
      shownTabId: this.shownTabId,
      page: pageState(this.shownContents()),
    };
  }

  /**
   * 清除 partition 的全部数据：cookie、localStorage / IndexedDB、Service Worker、HTTP 缓存、
   * HTTP 认证缓存。显示中的页面刷新一次，让「已退出登录」当场看得见。
   * 窗口从没开过也能清：partition 是持久化的，数据在盘上不在窗口里。
   */
  async clearData(): Promise<void> {
    const partition = session.fromPartition(BROWSER_PARTITION);
    await partition.clearStorageData();
    await partition.clearCache();
    await partition.clearAuthCache();
    const contents = this.shownContents();
    if (contents !== null && pageUrl(contents) !== "") contents.reload();
  }

  // ── agent 侧（main/browser/agent-requests.ts）────────────────────────

  /** 会话自己的 agent tab，没有就建（不显示窗口、不切过去——不抢用户的屏幕） */
  async agentTab(sessionId: string): Promise<BrowserTab> {
    await this.ensureWindow();
    const existing = this.findAgentTab(sessionId);
    if (existing !== undefined) return existing;
    const tab = this.createTab({ kind: "agent", sessionId });
    void this.deps
      .sessionTitle(sessionId)
      .then((title) => {
        tab.sessionTitle = title;
        this.push();
      })
      .catch(() => undefined);
    return tab;
  }

  /**
   * 按 id 找一个用户的 tab（agent 的读取类工具带 tab 时读它，只读）。别的会话的 agent tab
   * 不给——id 碰巧对上也不行，会话之间不互看
   */
  userTabById(tabId: string): BrowserTab | undefined {
    const tab = this.tabs.get(tabId);
    return tab?.owner.kind === "user" ? tab : undefined;
  }

  /**
   * 此刻在屏幕上的那个 tab：窗口可见且没最小化时才有。browser_tabs 如实标给模型——
   * 读哪个用户 tab 由模型按上下文挑，挑的依据给足（2026-09-29 用户裁决）
   */
  onScreenTabId(): string | null {
    const window = this.window;
    if (window === null || window.isDestroyed() || !window.isVisible() || window.isMinimized()) return null;
    return this.shownTabId === "" ? null : this.shownTabId;
  }

  /** agent 看得到的 tab：用户的全部 tab + 这个会话自己的 agent tab。别的会话的 tab 不给——会话之间不互看 */
  visibleTabs(sessionId: string): BrowserTabSummary[] {
    return [...this.tabs.values()]
      .filter((tab) => tab.owner.kind === "user" || tab.owner.sessionId === sessionId)
      .map((tab) => summarize(tab));
  }

  /** 本会话能用的目录（打开本地网页的白名单） */
  sessionRoots(sessionId: string): Promise<string[]> {
    return this.deps.sessionRoots(sessionId);
  }

  /** 截图另存的目录：`<会话工作台>/screenshots/` */
  screenshotDir(sessionId: string): string {
    return join(this.deps.workbenchPath(sessionId), "screenshots");
  }

  /** 在 tab 上排队执行一个操作：同一页上的操作不交错，前一个失败不连累后一个 */
  runOnTab<T>(tab: BrowserTab, operation: () => Promise<T>): Promise<T> {
    const run = tab.queue.then(operation, operation);
    tab.queue = run.catch(() => undefined);
    return run;
  }

  isLive(tab: BrowserTab): boolean {
    return this.tabs.get(tab.id) === tab && !tab.view.webContents.isDestroyed();
  }

  /**
   * 把 tab 交给用户，等用户交还。调用方在 runOnTab 里等它——交接期间这个 tab 的队列被占住，
   * agent 的其它浏览器调用排在后面：这就是控制权令牌。窗口不自动抢焦点（用户可能正在打字）：
   * 聊天里的交接卡是入口；应用不在前台时再发一条系统通知。
   */
  beginHandoff(tab: BrowserTab, toolCallId: string, reason: string): Promise<BrowserHandoffOutcome> {
    this.settleHandoff(tab, "cancelled");
    return new Promise<BrowserHandoffOutcome>((resolve) => {
      const timer = setTimeout(() => this.settleHandoff(tab, "cancelled"), HANDOFF_TIMEOUT_MS);
      tab.handoff = {
        toolCallId,
        reason,
        settle: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      this.layout();
      this.push();
      if (BrowserWindow.getFocusedWindow() === null && Notification.isSupported()) {
        const notice = new Notification({ title: this.deps.appName, body: reason, silent: false });
        notice.on("click", () => void this.showHandoff(toolCallId));
        notice.show();
      }
    });
  }

  /** 这个 tab 在 since 之后开始的下载（导航触发了下载时，navigate 用它认领结果） */
  downloadSince(tab: BrowserTab, since: number): DownloadRecord | undefined {
    return tab.downloads.find((record) => record.startedAt >= since);
  }

  /** 已完成、还没告诉过 agent 的下载：每次工具结果末尾报一次，报过就标记 */
  async takeFinishedDownloads(tab: BrowserTab): Promise<string[]> {
    const lines: string[] = [];
    for (const record of tab.downloads) {
      if (record.reported) continue;
      const done = await Promise.race([record.finished, Promise.resolve(null)]);
      if (done === null) continue;
      record.reported = true;
      lines.push(describeDownload(record, done));
    }
    return lines;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /** 应用即将退出：此后关窗不再改写成隐藏 */
  prepareQuit(): void {
    this.quitting = true;
  }

  /** 真正销毁：最后一个主窗口关闭、或应用退出时调用 */
  dispose(): void {
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.destroy();
    this.popups.clear();
    for (const tab of this.tabs.values()) {
      if (tab.handoff !== null) {
        const handoff = tab.handoff;
        tab.handoff = null;
        handoff.settle("cancelled");
      }
      // WebContentsView 的 webContents 不随窗口销毁而释放，要自己关
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.lastUserTabId = "";
    this.shownTabId = "";
    const window = this.window;
    this.window = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
  }

  // ── 内部 ────────────────────────────────────────────────────────────

  private shownContents(): WebContents | null {
    const contents = this.tabs.get(this.shownTabId)?.view.webContents;
    return contents === undefined || contents.isDestroyed() ? null : contents;
  }

  private findHandoffTab(toolCallId: string): BrowserTab | undefined {
    for (const tab of this.tabs.values()) if (tab.handoff?.toolCallId === toolCallId) return tab;
    return undefined;
  }

  private settleHandoff(tab: BrowserTab, outcome: BrowserHandoffOutcome): void {
    const handoff = tab.handoff;
    if (handoff === null) return;
    tab.handoff = null;
    handoff.settle(outcome);
    this.layout();
    this.push();
  }

  private findAgentTab(sessionId: string): BrowserTab | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.owner.kind === "agent" && tab.owner.sessionId === sessionId) return tab;
    }
    return undefined;
  }

  private ensureWindow(): Promise<BrowserWindow> {
    if (this.window !== null && !this.window.isDestroyed()) return Promise.resolve(this.window);
    this.creating ??= this.createWindow().finally(() => {
      this.creating = null;
    });
    return this.creating;
  }

  private async createWindow(): Promise<BrowserWindow> {
    this.guardSession();
    if (this.userDownloads === "") this.userDownloads = await this.deps.userDownloadDir();
    const window = new BrowserWindow({
      width: 1100,
      height: 800,
      minWidth: 480,
      minHeight: 320,
      show: false,
      autoHideMenuBar: true,
      ...(await this.deps.toolbarWindowOptions()),
    });
    this.window = window;

    window.on("resize", () => this.layout());
    // 窗口标题跟网页走，不让工具条页面的 <title> 盖掉它
    window.on("page-title-updated", (event) => event.preventDefault());
    window.on("close", (event) => {
      if (this.quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.on("closed", () => {
      if (this.window === window) this.dispose();
    });
    this.wireShortcuts(window.webContents);

    this.show(this.createTab({ kind: "user" }).id);
    this.deps.loadToolbar(window);
    return window;
  }

  private createTab(owner: BrowserTab["owner"]): BrowserTab {
    const window = this.window;
    if (window === null) throw new Error("浏览器窗口不在");
    const view = new WebContentsView({ webPreferences: PAGE_PREFERENCES });
    const tab: BrowserTab = {
      id: randomUUID(),
      owner,
      view,
      queue: Promise.resolve(),
      lastStatus: null,
      sessionTitle: "",
      handoff: null,
      downloads: [],
      refs: emptyElementRefs(),
      shot: null,
    };
    this.tabs.set(tab.id, tab);
    // 先垫到最底层：新 agent tab 不盖住用户正在看的那一页
    window.contentView.addChildView(view, 0);
    this.layout();

    const contents = view.webContents;
    contents.on("did-navigate", (_event, _url, httpResponseCode) => {
      tab.lastStatus = httpResponseCode > 0 ? httpResponseCode : null;
      // 新文档：旧引用指向的节点不在了，旧截图的坐标也不对了
      tab.refs = emptyElementRefs();
      tab.shot = null;
      this.push();
    });
    contents.on("did-start-loading", () => this.push());
    contents.on("did-stop-loading", () => this.push());
    contents.on("did-navigate-in-page", () => this.push());
    contents.on("page-title-updated", () => this.push());
    // agent tab 离开页面不被 beforeunload 拦住：没人看得见那个「确定要离开吗」，拦住就是导航静默失败
    if (owner.kind === "agent") contents.on("will-prevent-unload", (event) => event.preventDefault());
    this.guardContents(contents);
    this.wireShortcuts(contents);
    // 网页视图不预载 about:blank：它会成为历史的第一条，首次导航后「后退」就是亮的、
    // 点了退到一张空白页（第一刀 CDP 冒烟抓到的）。没加载过任何页面的视图本来就是白的
    this.push();
    return tab;
  }

  private destroyTab(tab: BrowserTab): void {
    // 交接中的 tab 被关：那次工具调用按取消结掉，不挂着
    this.settleHandoff(tab, "cancelled");
    this.tabs.delete(tab.id);
    const window = this.window;
    if (window !== null && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.lastUserTabId === tab.id) this.lastUserTabId = "";
    // 用户的 tab 至少留一个：它是登录入口，地球按钮也要有地方回（窗口没了就不补，重建时会建）
    const windowAlive = window !== null && !window.isDestroyed();
    if (windowAlive && this.userTabs().length === 0) this.createTab({ kind: "user" });
    if (this.shownTabId === tab.id && windowAlive) this.show(this.currentUserTab().id);
    else this.push();
  }

  private userTabs(): BrowserTab[] {
    return [...this.tabs.values()].filter((tab) => tab.owner.kind === "user");
  }

  /** 最近显示过的用户 tab；它被关了就退到 tab 条上最后一个用户 tab；一个都没有就新建（调用方保证窗口在） */
  private currentUserTab(): BrowserTab {
    const last = this.tabs.get(this.lastUserTabId);
    if (last !== undefined) return last;
    return this.userTabs().at(-1) ?? this.createTab({ kind: "user" });
  }

  /** 在用户的 tab 里打开 url（已规范化）：落点规则见 user-tabs.ts */
  private openInUserTab(url: string): void {
    const views = this.userTabs()
      .filter((tab) => !tab.view.webContents.isDestroyed())
      .map((tab) => ({ id: tab.id, url: pageUrl(tab.view.webContents), loading: tab.view.webContents.isLoading() }));
    const placement = placeInUserTab(url, views, this.currentUserTab().id);
    if (placement.kind === "switch") {
      this.show(placement.id);
      return;
    }
    const tab = placement.kind === "reuse" ? this.tabs.get(placement.id) : this.createTab({ kind: "user" });
    if (tab === undefined) return;
    this.show(tab.id);
    // 加载失败（断网、文件刚被删）页面自己会显示错误页，不当异常抛——同 navigate
    tab.view.webContents.loadURL(url).catch(() => undefined);
  }

  /** 显示某个 tab：把它的视图置顶（重新 addChildView 就是置顶）。其余 tab 留在下面照常渲染 */
  private show(tabId: string): void {
    const tab = this.tabs.get(tabId);
    const window = this.window;
    if (tab === undefined || window === null || window.isDestroyed()) return;
    this.shownTabId = tabId;
    if (tab.owner.kind === "user") this.lastUserTabId = tabId;
    window.contentView.addChildView(tab.view);
    this.layout();
    this.push();
  }

  private layout(): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    // 提示栏只在显示中的 tab 交接时出现：工具条变高，网页往下让——仍是上下分区，不重叠
    const top = BROWSER_TOOLBAR_HEIGHT + (this.tabs.get(this.shownTabId)?.handoff != null ? BROWSER_HANDOFF_BAR_HEIGHT : 0);
    const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
    for (const tab of this.tabs.values()) tab.view.setBounds(bounds);
  }

  /** 把全部状态推给工具条，并让窗口标题跟着显示中的页面 */
  private push(): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    const state = this.state();
    window.setTitle(state.page.title !== "" ? state.page.title : this.deps.appName);
    window.webContents.send(browserChannels.browserState, state);
  }

  /** partition 级约束：只装一次（session 对象全局唯一，重复装会叠加监听） */
  private guardSession(): void {
    if (this.guardedSession !== null) return;
    const partition = session.fromPartition(BROWSER_PARTITION);
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.setUserAgent(browserUserAgent(partition.getUserAgent(), this.deps.appName));
    partition.on("will-download", (_event, item, contents) => this.onDownload(item, contents));
    // agent tab 打开 PDF 这类文件：改成下载，不在 tab 里显示——agent 读不了查看器里的字，
    // 下载进工作台它能用文件工具读。「你的」tab 不动，照常在查看器里看
    partition.webRequest.onHeadersReceived((details, callback) => {
      const agentTab =
        details.resourceType === "mainFrame" &&
        [...this.tabs.values()].some(
          (tab) => tab.owner.kind === "agent" && !tab.view.webContents.isDestroyed() && tab.view.webContents.id === details.webContentsId,
        );
      const headers = agentTab ? forceDownloadHeaders(details.responseHeaders) : undefined;
      callback(headers === undefined ? {} : { responseHeaders: headers });
    });
    this.guardedSession = partition;
  }

  /**
   * 下载落点：agent tab → `<会话工作台>/downloads/`；其余（「你的」tab、弹窗）→ 用户指定的目录。
   * **保存路径必须在这个回调里同步给出**，否则 Electron 弹保存框——所以用缓存的目录与同步建目录。
   * 同名不覆盖：加 (1)、(2)…
   */
  private onDownload(item: DownloadItem, contents: WebContents): void {
    const tab = [...this.tabs.values()].find((candidate) => candidate.view.webContents === contents);
    const dir =
      tab?.owner.kind === "agent"
        ? join(this.deps.workbenchPath(tab.owner.sessionId), "downloads")
        : this.userDownloads !== ""
          ? this.userDownloads
          : undefined;
    if (dir === undefined) return;
    try {
      mkdirSync(dir, { recursive: true });
    } catch (cause) {
      console.error(`[browser] 下载目录建不出来，退回系统保存框：${dir}`, cause);
      return;
    }
    const path = availableDownloadPath(dir, item.getFilename());
    item.setSavePath(path);
    if (tab === undefined) return;
    const record: DownloadRecord = {
      url: item.getURL(),
      path,
      startedAt: Date.now(),
      reported: false,
      finished: new Promise((resolve) => {
        item.once("done", (_event, state) => resolve({ state, bytes: item.getReceivedBytes() }));
      }),
    };
    tab.downloads.push(record);
    // 只留最近 20 条：一个会话下几百个文件时不让这张表无限长
    if (tab.downloads.length > 20) tab.downloads.splice(0, tab.downloads.length - 20);
  }

  /**
   * 新窗口请求：带 features 的 window.open（弹窗式 SSO）开成子窗口，保留 opener 关系；
   * 普通 target=_blank 链接在当前视图里打开。非 http(s) 一律拒绝。
   */
  private guardContents(contents: WebContents): void {
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (normalizeAddress(url) === null) return { action: "deny" };
      if (disposition === "new-window") {
        return {
          action: "allow",
          overrideBrowserWindowOptions: {
            ...(this.window !== null ? { parent: this.window } : {}),
            autoHideMenuBar: true,
            webPreferences: PAGE_PREFERENCES,
          },
        };
      }
      contents.loadURL(url).catch(() => undefined);
      return { action: "deny" };
    });
    contents.on("did-create-window", (popup) => {
      this.popups.add(popup);
      popup.once("closed", () => this.popups.delete(popup));
      this.guardContents(popup.webContents);
    });
  }

  private wireShortcuts(contents: WebContents): void {
    contents.on("before-input-event", (event, input) => {
      const shortcut = browserShortcut(input, process.platform);
      if (shortcut === null) return;
      event.preventDefault();
      this.runShortcut(shortcut);
    });
  }

  private runShortcut(shortcut: BrowserShortcut): void {
    if (shortcut === "reload") this.shownContents()?.reload();
    else if (shortcut === "back") this.back();
    else if (shortcut === "forward") this.forward();
    else if (this.window !== null && !this.window.isDestroyed()) {
      this.window.webContents.focus();
      this.window.webContents.send(browserChannels.browserFocusAddress);
    }
  }
}

/** 把沙盒窗口提到最前（最小化了先还原） */
function bringToFront(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** 页面地址；没加载过（空串）与 about:blank 都当「空页」 */
export function pageUrl(contents: WebContents): string {
  const url = contents.getURL();
  return url === "about:blank" ? "" : url;
}

function pageState(contents: WebContents | null): BrowserPageState {
  if (contents === null) return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
  const url = pageUrl(contents);
  return {
    url,
    // 没加载过的视图 getTitle() 回的是空页的默认标题（常是一串 URL），不当标题用
    title: url === "" ? "" : contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
  };
}

function summarize(tab: BrowserTab): BrowserTabSummary {
  const contents = tab.view.webContents;
  const live = !contents.isDestroyed();
  const url = live ? pageUrl(contents) : "";
  return {
    id: tab.id,
    owner: tab.owner.kind === "user" ? { kind: "user" } : { kind: "agent", sessionId: tab.owner.sessionId, sessionTitle: tab.sessionTitle },
    title: live && url !== "" ? contents.getTitle() : "",
    url,
    loading: live && contents.isLoading(),
    ...(tab.handoff === null ? {} : { handoff: { toolCallId: tab.handoff.toolCallId, reason: tab.handoff.reason } }),
  };
}

export function describeDownload(
  record: DownloadRecord,
  done: { state: "completed" | "cancelled" | "interrupted"; bytes: number },
): string {
  if (done.state === "completed") {
    const hint = /\.pdf$/i.test(record.path)
      ? " Read it with read_pdf."
      : /\.docx$/i.test(record.path)
        ? " Read it with read_docx."
        : "";
    return `Downloaded ${record.url} → ${record.path} (${formatBytes(done.bytes)}).${hint}`;
  }
  return `Download ${done.state}: ${record.url}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
