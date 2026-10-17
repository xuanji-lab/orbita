/**
 * 诊断缓冲的 CDP 接线：懒 enable Runtime / Log / Network 三个域，把事件喂进 TabDiagnostics。
 *
 * 懒的含义：**工具第一次被调用时才 attach + enable**（沿用 cdp.ts 的懒 attach 模式）。
 * 浏览器是 agent 的工具，绝大多数会话根本不会去查控制台——不给每个 agent tab 挂一份常驻
 * 监听。一旦打开就保持到 tab 关闭：之后每次导航都在采集，模型重载一次页面就能拿到完整记录。
 *
 * 复用同一条 CDP 会话（`webContents.debugger`），不新开调试通道；enable 也走 cdp()，
 * 因此同样吃每条命令 10 秒的超时。缓冲与过滤是纯逻辑，在 diagnostics.ts。
 *
 * **换页清缓冲在 CDP 侧做**：`Network.requestWillBeSent` 见到新 loaderId 的主帧 Document 请求时
 * 先 clear 再记——主文档请求 / 响应在导航提交之前到达，等到 `did-navigate` 再清恰好把主文档
 * 自己那条清掉（评审 2026-10-14）。判定与兜底见 diagnostics.ts 的 MainDocumentWatcher。
 */
import type { WebContents } from "electron";
import { cdp, ensureDebugger } from "./cdp.ts";
import { MainDocumentWatcher, TabDiagnostics } from "./diagnostics.ts";

interface TabEntry {
  state: TabDiagnostics;
  /** 主文档换页追踪（CDP 侧）：新文档的请求一到就先清缓冲，见 diagnostics.ts 里的注释 */
  watcher: MainDocumentWatcher;
  /** 三个域是否已 enable。页面崩溃 / 被别的调试器抢走会 detach，这里翻回 false 等下次重开 */
  enabled: boolean;
  /** 当前挂在 debugger 上的 message 监听（重新 enable 前先摘掉旧的，避免事件重复进缓冲） */
  listener: ((event: unknown, method: string, params: unknown) => void) | null;
}

/** 进程级一份：诊断是「这个 tab 发生过什么」的进程级事实，没有第二个消费者（同 agent-requests 的 pacer） */
export class BrowserDiagnostics {
  private readonly tabs = new Map<number, TabEntry>();

  /**
   * 取这个 tab 的缓冲，必要时先把三个域打开。`justEnabled` 告诉调用方「这次是刚打开的」——
   * 刚打开时缓冲是空的，结果里要说清「只记从现在起发生的事」，否则模型会以为页面真的没问题。
   */
  async open(contents: WebContents): Promise<{ state: TabDiagnostics; justEnabled: boolean }> {
    const id = contents.id;
    let entry = this.tabs.get(id);
    if (entry === undefined) {
      const state = new TabDiagnostics();
      const watcher = new MainDocumentWatcher();
      entry = { state, watcher, enabled: false, listener: null };
      this.tabs.set(id, entry);
      // 兜底：CDP 侧拿不到主帧信息时（Page.getFrameTree 失败）仍按 did-navigate 清。正常路径在
      // Network.requestWillBeSent 里判「新主文档」——did-navigate 在提交之后才触发，会把主文档
      // 自己那条清掉（评审 2026-10-14）。SPA 的 did-navigate-in-page 是同一份文档，不清。
      contents.on("did-navigate", () => {
        if (!watcher.ready) state.clear();
      });
      // tab 关闭（sandbox.destroyTab 调 webContents.close()）：整份缓冲丢掉，不留悬挂条目
      contents.once("destroyed", () => this.tabs.delete(id));
    }
    const justEnabled = !entry.enabled;
    if (justEnabled) await this.enable(contents, entry);
    return { state: entry.state, justEnabled };
  }

  private async enable(contents: WebContents, entry: TabEntry): Promise<void> {
    ensureDebugger(contents);
    if (entry.listener !== null) contents.debugger.removeListener("message", entry.listener);
    const listener = (_event: unknown, method: string, params: unknown): void => {
      if (method === "Runtime.consoleAPICalled") entry.state.onConsoleApiCalled(params);
      else if (method === "Runtime.exceptionThrown") entry.state.onExceptionThrown(params);
      else if (method === "Log.entryAdded") entry.state.onLogEntryAdded(params);
      else if (method === "Network.requestWillBeSent") {
        // 新的一份主文档：先清缓冲再记这条，主文档自己的请求 / 响应（403 / 503 / 401）才留得住
        if (entry.watcher.observe(params)) entry.state.clear();
        entry.state.onRequestWillBeSent(params);
      }
      else if (method === "Network.responseReceived") entry.state.onResponseReceived(params);
      else if (method === "Network.loadingFailed") entry.state.onLoadingFailed(params);
    };
    entry.listener = listener;
    contents.debugger.on("message", listener);
    contents.debugger.once("detach", () => {
      entry.enabled = false;
    });
    // 主帧信息是 CDP 侧换页判定的依据：先取再 enable，免得导航卡在中间漏判。取不到就保持
    // ready=false，退回 did-navigate 兜底；下次 enable（重新 attach）会重试。
    try {
      entry.watcher.setFrameTree(await cdp(contents, "Page.getFrameTree"));
    } catch {
      // 页面崩了 / 调试器被抢走：本次不装 CDP 侧判定，did-navigate 兜底
    }
    // 先挂监听再 enable：enable 是异步的，中间到达的事件不该漏
    await cdp(contents, "Runtime.enable");
    await cdp(contents, "Log.enable");
    await cdp(contents, "Network.enable");
    entry.enabled = true;
  }
}
