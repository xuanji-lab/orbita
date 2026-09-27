/**
 * 受管浏览器的 IPC —— 四层契约的第 2 层。
 * 浏览器实例全在主进程（sandbox.ts）；这里只把通道接到它上面。
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { browserChannels, type BrowserNavigateResult, type BrowserWindowState } from "../../shared/browser.ts";
import type { SettingsStore } from "../settings/store.ts";
import { browserDownloadDir } from "./download-dir.ts";
import type { BrowserSandbox } from "./sandbox.ts";

export function registerBrowserIpc(sandbox: BrowserSandbox, settings: SettingsStore): void {
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
  ipcMain.handle(browserChannels.browserSelectTab, (_event, tabId: unknown): void => {
    if (typeof tabId === "string") sandbox.selectTab(tabId);
  });
  ipcMain.handle(browserChannels.browserCloseTab, (_event, tabId: unknown): void => {
    if (typeof tabId === "string") sandbox.closeTab(tabId);
  });
  ipcMain.handle(browserChannels.browserGetState, (): BrowserWindowState => sandbox.state());

  ipcMain.handle(browserChannels.browserShowHandoff, (_event, toolCallId: unknown): Promise<boolean> =>
    typeof toolCallId === "string" ? sandbox.showHandoff(toolCallId) : Promise.resolve(false),
  );
  ipcMain.handle(browserChannels.browserResolveHandoff, (_event, toolCallId: unknown, outcome: unknown): void => {
    if (typeof toolCallId === "string" && (outcome === "done" || outcome === "cancelled")) {
      sandbox.resolveHandoff(toolCallId, outcome);
    }
  });

  ipcMain.handle(browserChannels.browserDownloadDir, (): Promise<string> => browserDownloadDir(settings));
  ipcMain.handle(browserChannels.browserPickDownloadDir, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = {
      properties: ["openDirectory", "createDirectory"] as ("openDirectory" | "createDirectory")[],
      defaultPath: await browserDownloadDir(settings),
    };
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    const picked = result.canceled ? undefined : result.filePaths[0];
    if (picked === undefined) return null;
    await settings.write({ browserDownloadDir: picked });
    sandbox.setUserDownloadDir(picked);
    return picked;
  });
  // 在系统文件管理器里打开下载目录；目录还不存在就先建（默认目录总在，用户指定的可能被挪走）
  ipcMain.handle(browserChannels.browserRevealDownloadDir, async (): Promise<void> => {
    const dir = await browserDownloadDir(settings);
    await mkdir(dir, { recursive: true });
    const failure = await shell.openPath(dir);
    if (failure !== "") throw new Error(failure);
  });
}
