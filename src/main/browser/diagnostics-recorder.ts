/**
 * 诊断缓冲的 CDP 接线：懒 enable Runtime / Log / Network 三个域，把事件喂进 TabDiagnostics。
 *
 * 懒的含义：**工具第一次被调用时才 attach + enable**（沿用 cdp.ts 的懒 attach 模式）。
 * 浏览器是 agent 的工具，绝大多数会话根本不会去查控制台——不给每个 agent tab 挂一份常驻
 * 监听。一旦打开就保持到 tab 关闭：之后每次导航都在采集，模型重载一次页面就能拿到完整记录。
 *
 * 复用同一条 CDP 会话（`webContents.debugger`），不新开调试通道；enable 也走 cdp()，
 * 因此同样吃每条命令 10 秒的超时。缓冲与过滤是纯逻辑，在 diagnostics.ts。
 */
import type { WebContents } from "electron";
import { cdp, ensureDebugger } from "./cdp.ts";
import { TabDiagnostics } from "./diagnostics.ts";

interface TabEntry {
  state: TabDiagnostics;
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
      entry = { state, enabled: false, listener: null };
      this.tabs.set(id, entry);
      // 跨文档导航：上一页的消息不再代表当前页。SPA 的 did-navigate-in-page 是同一份文档，不清。
      contents.on("did-navigate", () => state.clear());
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
      else if (method === "Network.requestWillBeSent") entry.state.onRequestWillBeSent(params);
      else if (method === "Network.responseReceived") entry.state.onResponseReceived(params);
      else if (method === "Network.loadingFailed") entry.state.onLoadingFailed(params);
    };
    entry.listener = listener;
    contents.debugger.on("message", listener);
    contents.debugger.once("detach", () => {
      entry.enabled = false;
    });
    // 先挂监听再 enable：enable 是异步的，中间到达的事件不该漏
    await cdp(contents, "Runtime.enable");
    await cdp(contents, "Log.enable");
    await cdp(contents, "Network.enable");
    entry.enabled = true;
  }
}
