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
 *   - 「你的」tab：用户登录用，不属于任何会话，不可关。
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
  WebContentsView,
  session,
  type BrowserWindowConstructorOptions,
  type Session,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import {
  browserChannels,
  type BrowserNavigateResult,
  type BrowserPageState,
  type BrowserTabSummary,
  type BrowserWindowState,
} from "../../shared/browser.ts";
import { normalizeAddress } from "./address.ts";
import { browserUserAgent } from "./identity.ts";
import { browserShortcut, type BrowserShortcut } from "./shortcuts.ts";

/** 全局一个持久化 partition（2026-09-27 裁决：学校登录是跨工作区的身份，不按工作区分） */
export const BROWSER_PARTITION = "persist:orbita-browser";

/** 工具条高度（tab 条 + 导航行）。工具条页面的 CSS 用同一个值（`--browser-toolbar-height`） */
export const BROWSER_TOOLBAR_HEIGHT = 78;

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
}

export interface BrowserSandboxDeps {
  /** 工具条页面（沙盒窗口自己的 webContents）的窗口选项：preload、主题参数等由 index.ts 装配 */
  toolbarWindowOptions: () => Promise<BrowserWindowConstructorOptions>;
  /** 把工具条页面载入窗口（dev server 与打包产物两条路，同主窗口的装载逻辑） */
  loadToolbar: (window: BrowserWindow) => void;
  /** 会话标题（agent tab 在工具条上的标签）；取不到回空串 */
  sessionTitle: (sessionId: string) => Promise<string>;
  appName: string;
}

export class BrowserSandbox {
  private readonly deps: BrowserSandboxDeps;
  private window: BrowserWindow | null = null;
  /** 并发 ensureWindow 共用同一次创建（agent 并行工具调用会同时要窗口） */
  private creating: Promise<BrowserWindow> | null = null;
  private readonly tabs = new Map<string, BrowserTab>();
  private userTabId = "";
  private shownTabId = "";
  /** 页面开出的弹窗子窗口：dispose 时一并收掉 */
  private readonly popups = new Set<BrowserWindow>();
  private quitting = false;
  private guardedSession: Session | null = null;

  constructor(deps: BrowserSandboxDeps) {
    this.deps = deps;
  }

  // ── 用户侧（主窗口 / 工具条）────────────────────────────────────────

  /** 打开或聚焦沙盒窗口；带 url 就在「你的」tab 里打开并切过去 */
  async open(url?: string): Promise<BrowserNavigateResult> {
    const window = await this.ensureWindow();
    let result: BrowserNavigateResult = { ok: true };
    if (url !== undefined) {
      this.show(this.userTabId);
      result = this.navigate(url);
    }
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    // 空白页打开时光标直接进地址栏：此刻用户要做的只有输入网址这一件事
    if (this.state().page.url === "") window.webContents.send(browserChannels.browserFocusAddress);
    return result;
  }

  /** 地址栏提交：作用于正在显示的 tab */
  navigate(input: string): BrowserNavigateResult {
    const url = normalizeAddress(input);
    if (url === null) return { ok: false, reason: "not-an-address" };
    const contents = this.shownContents();
    // loadURL 在被后续导航打断（ERR_ABORTED）或网络失败时 reject：页面自己会显示结果，
    // 这里不当异常抛——用户换个地址重来就好
    if (contents !== null) contents.loadURL(url).catch(() => undefined);
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

  /** 关掉一个 agent tab。「你的」tab 不可关；agent 下次用浏览器会重开一个（登录态不丢） */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab === undefined || tab.owner.kind === "user") return;
    this.destroyTab(tab);
  }

  /** 会话删除：它的 agent tab 一并关掉 */
  closeSessionTab(sessionId: string): void {
    const tab = this.findAgentTab(sessionId);
    if (tab !== undefined) this.destroyTab(tab);
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

  /** 在 tab 上排队执行一个操作：同一页上的操作不交错，前一个失败不连累后一个 */
  runOnTab<T>(tab: BrowserTab, operation: () => Promise<T>): Promise<T> {
    const run = tab.queue.then(operation, operation);
    tab.queue = run.catch(() => undefined);
    return run;
  }

  isLive(tab: BrowserTab): boolean {
    return this.tabs.get(tab.id) === tab && !tab.view.webContents.isDestroyed();
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
      // WebContentsView 的 webContents 不随窗口销毁而释放，要自己关
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
    this.userTabId = "";
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

    const userTab = this.createTab({ kind: "user" });
    this.userTabId = userTab.id;
    this.show(userTab.id);
    this.deps.loadToolbar(window);
    return window;
  }

  private createTab(owner: BrowserTab["owner"]): BrowserTab {
    const window = this.window;
    if (window === null) throw new Error("浏览器窗口不在");
    const view = new WebContentsView({ webPreferences: PAGE_PREFERENCES });
    const tab: BrowserTab = { id: randomUUID(), owner, view, queue: Promise.resolve(), lastStatus: null, sessionTitle: "" };
    this.tabs.set(tab.id, tab);
    // 先垫到最底层：新 agent tab 不盖住用户正在看的那一页
    window.contentView.addChildView(view, 0);
    this.layout();

    const contents = view.webContents;
    contents.on("did-navigate", (_event, _url, httpResponseCode) => {
      tab.lastStatus = httpResponseCode > 0 ? httpResponseCode : null;
      this.push();
    });
    contents.on("did-start-loading", () => this.push());
    contents.on("did-stop-loading", () => this.push());
    contents.on("did-navigate-in-page", () => this.push());
    contents.on("page-title-updated", () => this.push());
    this.guardContents(contents);
    this.wireShortcuts(contents);
    // 网页视图不预载 about:blank：它会成为历史的第一条，首次导航后「后退」就是亮的、
    // 点了退到一张空白页（第一刀 CDP 冒烟抓到的）。没加载过任何页面的视图本来就是白的
    this.push();
    return tab;
  }

  private destroyTab(tab: BrowserTab): void {
    this.tabs.delete(tab.id);
    const window = this.window;
    if (window !== null && !window.isDestroyed()) window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.shownTabId === tab.id) this.show(this.userTabId);
    else this.push();
  }

  /** 显示某个 tab：把它的视图置顶（重新 addChildView 就是置顶）。其余 tab 留在下面照常渲染 */
  private show(tabId: string): void {
    const tab = this.tabs.get(tabId);
    const window = this.window;
    if (tab === undefined || window === null || window.isDestroyed()) return;
    this.shownTabId = tabId;
    window.contentView.addChildView(tab.view);
    this.push();
  }

  private layout(): void {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    const { width, height } = window.getContentBounds();
    const bounds = { x: 0, y: BROWSER_TOOLBAR_HEIGHT, width, height: Math.max(0, height - BROWSER_TOOLBAR_HEIGHT) };
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
    this.guardedSession = partition;
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
  };
}
