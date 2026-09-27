/**
 * 受管浏览器的 IPC —— 四层契约的第 2 层。
 * 浏览器实例全在主进程（sandbox.ts）；这里只把通道接到它上面。
 */
import { ipcMain } from "electron";
import { browserChannels, type BrowserNavigateResult, type BrowserPageState } from "../../shared/browser.ts";
import type { BrowserSandbox } from "./sandbox.ts";

export function registerBrowserIpc(sandbox: BrowserSandbox): void {
  ipcMain.handle(
    browserChannels.browserOpen,
    (_event, url?: string): Promise<BrowserNavigateResult> =>
      sandbox.open(typeof url === "string" ? url : undefined),
  );
  ipcMain.handle(browserChannels.browserClearData, (): Promise<void> => sandbox.clearData());
  ipcMain.handle(
    browserChannels.browserNavigate,
    (_event, input: unknown): BrowserNavigateResult =>
      typeof input === "string" ? sandbox.navigate(input) : { ok: false, reason: "not-an-address" },
  );
  ipcMain.handle(browserChannels.browserBack, (): void => sandbox.back());
  ipcMain.handle(browserChannels.browserForward, (): void => sandbox.forward());
  ipcMain.handle(browserChannels.browserReloadOrStop, (): void => sandbox.reloadOrStop());
  ipcMain.handle(browserChannels.browserGetState, (): BrowserPageState => sandbox.state());
}
