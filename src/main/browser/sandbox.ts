/**
 * 受管浏览器的沙盒窗口（第一刀：一个窗口、一个页面视图）。
 *
 * 结构：
 *   BrowserWindow（沙盒窗口）── 自己的 webContents 加载工具条页面（我们的 renderer，同一个 preload）
 *     └─ contentView 子视图：WebContentsView（网页，无 preload，独立持久化 partition）
 * 工具条占窗口顶部固定高度，网页视图贴在它下面。两块上下分区、永不重叠——这正是把浏览器
 * 放进独立窗口的理由：原生视图不会再压住任何 DOM 浮层，也就不需要任何让位逻辑。
 *
 * 生命周期：
 *   - 懒创建：第一次 open 才建窗口；
 *   - 用户关窗 = 隐藏：页面、历史、登录态都保留，下次 open 原样回来；
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
import { browserChannels, type BrowserNavigateResult, type BrowserPageState } from "../../shared/browser.ts";
import { normalizeAddress } from "./address.ts";
import { browserUserAgent } from "./identity.ts";
import { browserShortcut, type BrowserShortcut } from "./shortcuts.ts";

/** 全局一个持久化 partition（2026-09-27 裁决：学校登录是跨工作区的身份，不按工作区分） */
export const BROWSER_PARTITION = "persist:orbita-browser";

/** 工具条高度。工具条页面的 CSS 用同一个值（toolbar 的 `--browser-toolbar-height`） */
export const BROWSER_TOOLBAR_HEIGHT = 44;

/** 网页视图与弹窗子窗口共用的 webPreferences：无 preload，三条安全不变量全开 */
const PAGE_PREFERENCES = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
} as const;

export interface BrowserSandboxDeps {
  /** 工具条页面（沙盒窗口自己的 webContents）的窗口选项：preload、主题参数等由 index.ts 装配 */
  toolbarWindowOptions: () => Promise<BrowserWindowConstructorOptions>;
  /** 把工具条页面载入窗口（dev server 与打包产物两条路，同主窗口的装载逻辑） */
  loadToolbar: (window: BrowserWindow) => void;
  appName: string;
}

export class BrowserSandbox {
  private readonly deps: BrowserSandboxDeps;
  private window: BrowserWindow | null = null;
  private page: WebContentsView | null = null;
  /** 页面开出的弹窗子窗口：dispose 时一并收掉 */
  private readonly popups = new Set<BrowserWindow>();
  private quitting = false;
  private guardedSession: Session | null = null;

  constructor(deps: BrowserSandboxDeps) {
    this.deps = deps;
  }

  /** 打开或聚焦沙盒窗口；带 url 就导航过去 */
  async open(url?: string): Promise<BrowserNavigateResult> {
    const { window, page } = await this.ensureWindow();
    const result = url !== undefined ? this.navigate(url) : ({ ok: true } as const);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    // 空白页打开时光标直接进地址栏：此刻用户要做的只有输入网址这一件事
    if (page.webContents.getURL() === "" || page.webContents.getURL() === "about:blank") {
      window.webContents.send(browserChannels.browserFocusAddress);
    }
    return result;
  }

  navigate(input: string): BrowserNavigateResult {
    const url = normalizeAddress(input);
    if (url === null) return { ok: false, reason: "not-an-address" };
    const contents = this.page?.webContents;
    if (contents === undefined || contents.isDestroyed()) return { ok: true };
    // loadURL 在被后续导航打断（ERR_ABORTED）或网络失败时 reject：页面自己会显示结果，
    // 这里不当异常抛——用户换个地址重来就好
    contents.loadURL(url).catch(() => undefined);
    return { ok: true };
  }

  back(): void {
    const history = this.liveContents()?.navigationHistory;
    if (history?.canGoBack() === true) history.goBack();
  }

  forward(): void {
    const history = this.liveContents()?.navigationHistory;
    if (history?.canGoForward() === true) history.goForward();
  }

  reloadOrStop(): void {
    const contents = this.liveContents();
    if (contents === null) return;
    if (contents.isLoading()) contents.stop();
    else contents.reload();
  }

  state(): BrowserPageState {
    const contents = this.liveContents();
    if (contents === null) return { url: "", title: "", loading: false, canGoBack: false, canGoForward: false };
    const url = contents.getURL();
    return {
      url: url === "about:blank" ? "" : url,
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
  }

  /**
   * 清除 partition 的全部数据：cookie、localStorage / IndexedDB、Service Worker、HTTP 缓存、
   * HTTP 认证缓存。页面开着就刷新一次，让「已退出登录」当场看得见。
   * 窗口从没开过也能清：partition 是持久化的，数据在盘上不在窗口里。
   */
  async clearData(): Promise<void> {
    const partition = session.fromPartition(BROWSER_PARTITION);
    await partition.clearStorageData();
    await partition.clearCache();
    await partition.clearAuthCache();
    const contents = this.liveContents();
    if (contents !== null && contents.getURL() !== "" && contents.getURL() !== "about:blank") contents.reload();
  }

  /** 应用即将退出：此后关窗不再改写成隐藏 */
  prepareQuit(): void {
    this.quitting = true;
  }

  /** 真正销毁：最后一个主窗口关闭、或应用退出时调用 */
  dispose(): void {
    for (const popup of this.popups) if (!popup.isDestroyed()) popup.destroy();
    this.popups.clear();
    const page = this.page;
    this.page = null;
    // WebContentsView 的 webContents 不随窗口销毁而释放，要自己关
    if (page !== null && !page.webContents.isDestroyed()) page.webContents.close();
    const window = this.window;
    this.window = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
  }

  private liveContents(): WebContents | null {
    const contents = this.page?.webContents;
    return contents === undefined || contents.isDestroyed() ? null : contents;
  }

  private async ensureWindow(): Promise<{ window: BrowserWindow; page: WebContentsView }> {
    if (this.window !== null && !this.window.isDestroyed() && this.page !== null) {
      return { window: this.window, page: this.page };
    }
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
    const page = new WebContentsView({ webPreferences: PAGE_PREFERENCES });
    window.contentView.addChildView(page);
    this.window = window;
    this.page = page;

    const layout = (): void => {
      if (window.isDestroyed()) return;
      const { width, height } = window.getContentBounds();
      page.setBounds({
        x: 0,
        y: BROWSER_TOOLBAR_HEIGHT,
        width,
        height: Math.max(0, height - BROWSER_TOOLBAR_HEIGHT),
      });
    };
    layout();
    window.on("resize", layout);

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

    this.guardContents(page.webContents);
    this.wireShortcuts(window.webContents);
    this.wireShortcuts(page.webContents);
    const push = (): void => {
      if (window.isDestroyed()) return;
      const state = this.state();
      window.setTitle(state.title !== "" ? state.title : this.deps.appName);
      window.webContents.send(browserChannels.browserState, state);
    };
    page.webContents.on("did-start-loading", push);
    page.webContents.on("did-stop-loading", push);
    page.webContents.on("did-navigate", push);
    page.webContents.on("did-navigate-in-page", push);
    page.webContents.on("page-title-updated", push);

    // 网页视图不预载 about:blank：它会成为历史的第一条，首次导航后「后退」就是亮的、
    // 点了退到一张空白页（CDP 冒烟抓到的）。没加载过任何页面的视图本来就是白的
    this.deps.loadToolbar(window);
    return { window, page };
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
   * 普通 target=_blank 链接在当前视图里打开（第一刀只有一个页面视图）。非 http(s) 一律拒绝。
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
    if (shortcut === "reload") this.liveContents()?.reload();
    else if (shortcut === "back") this.back();
    else if (shortcut === "forward") this.forward();
    else if (this.window !== null && !this.window.isDestroyed()) {
      this.window.webContents.focus();
      this.window.webContents.send(browserChannels.browserFocusAddress);
    }
  }
}
