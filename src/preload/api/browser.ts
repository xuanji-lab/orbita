/**
 * 受管浏览器的 contextBridge 面 —— 四层契约的第 3 层。
 *
 * 两个调用方共用这一个面（同一个 preload）：主窗口用 open / clearData，沙盒窗口的工具条
 * 用其余的导航、tab 切换与状态订阅。agent 的浏览器工具不走这里（agent 进程 ↔ 主进程直连）。网页本身不加载 preload，这里的任何方法它都碰不到。
 */
import { ipcRenderer } from "electron";
import {
  browserChannels,
  type BrowserHandoffOutcome,
  type BrowserNavigateResult,
  type BrowserWindowState,
} from "../../shared/browser.ts";

export const browserApi = {
  /** 打开或聚焦沙盒窗口；带 url 就导航过去（不是网址时回 ok:false，窗口照样打开） */
  open: (url?: string): Promise<BrowserNavigateResult> => ipcRenderer.invoke(browserChannels.browserOpen, url),
  /** 清除受管浏览器的全部数据（cookie、站点存储、缓存）。登录态随之清空 */
  clearData: (): Promise<void> => ipcRenderer.invoke(browserChannels.browserClearData),
  navigate: (input: string): Promise<BrowserNavigateResult> =>
    ipcRenderer.invoke(browserChannels.browserNavigate, input),
  back: (): Promise<void> => ipcRenderer.invoke(browserChannels.browserBack),
  forward: (): Promise<void> => ipcRenderer.invoke(browserChannels.browserForward),
  reloadOrStop: (): Promise<void> => ipcRenderer.invoke(browserChannels.browserReloadOrStop),
  selectTab: (tabId: string): Promise<void> => ipcRenderer.invoke(browserChannels.browserSelectTab, tabId),
  closeTab: (tabId: string): Promise<void> => ipcRenderer.invoke(browserChannels.browserCloseTab, tabId),
  getState: (): Promise<BrowserWindowState> => ipcRenderer.invoke(browserChannels.browserGetState),
  /** 交接卡「去浏览器完成」：回 false = 这次交接已经结束了 */
  showHandoff: (toolCallId: string): Promise<boolean> => ipcRenderer.invoke(browserChannels.browserShowHandoff, toolCallId),
  resolveHandoff: (toolCallId: string, outcome: BrowserHandoffOutcome): Promise<void> =>
    ipcRenderer.invoke(browserChannels.browserResolveHandoff, toolCallId, outcome),
  downloadDir: (): Promise<string> => ipcRenderer.invoke(browserChannels.browserDownloadDir),
  /** 选下载目录；取消回 null */
  pickDownloadDir: (): Promise<string | null> => ipcRenderer.invoke(browserChannels.browserPickDownloadDir),
  revealDownloadDir: (): Promise<void> => ipcRenderer.invoke(browserChannels.browserRevealDownloadDir),
  onState: (listener: (state: BrowserWindowState) => void): (() => void) => {
    const handler = (_e: unknown, state: BrowserWindowState) => listener(state);
    ipcRenderer.on(browserChannels.browserState, handler);
    return () => ipcRenderer.removeListener(browserChannels.browserState, handler);
  },
  onFocusAddress: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on(browserChannels.browserFocusAddress, handler);
    return () => ipcRenderer.removeListener(browserChannels.browserFocusAddress, handler);
  },
} as const;
