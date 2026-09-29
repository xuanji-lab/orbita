/**
 * 受管浏览器的 IPC —— 四层契约的第 2 层。
 * 浏览器实例全在主进程（sandbox.ts）；这里只把通道接到它上面。
 */
import { BrowserWindow, dialog, ipcMain, session, shell } from "electron";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  browserChannels,
  type BrowserImportCommitResult,
  type BrowserImportedSite,
  type BrowserImportReadResult,
  type BrowserImportSource,
  type BrowserNavigateResult,
  type BrowserWindowState,
} from "../../shared/browser.ts";
import type { SettingsStore } from "../settings/store.ts";
import { LoginImporter } from "./chrome-import.ts";
import { browserDownloadDir } from "./download-dir.ts";
import { BROWSER_PARTITION, type BrowserSandbox } from "./sandbox.ts";

export function registerBrowserIpc(sandbox: BrowserSandbox, settings: SettingsStore, configDir: string): void {
  // 登录状态导入（chrome-import.ts；cookie 值不过 IPC，renderer 只拿网站与计数）。
  // 建在最前：清除浏览器数据也要用它清空导入账本
  const loginImporter = new LoginImporter({
    cookieTarget: () => session.fromPartition(BROWSER_PARTITION),
    ledgerPath: join(configDir, "browser-imports.json"),
  });

  ipcMain.handle(
    browserChannels.browserOpen,
    (_event, url?: string): Promise<BrowserNavigateResult> =>
      sandbox.open(typeof url === "string" ? url : undefined),
  );
  ipcMain.handle(browserChannels.browserClearData, async (): Promise<void> => {
    await sandbox.clearData();
    // cookie 已经全没了：「已导入的网站」清单跟着清空，不留一排失效的行
    await loginImporter.forgetImported();
  });
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

  // ── 登录状态导入 ──
  ipcMain.handle(browserChannels.browserImportSources, (): Promise<BrowserImportSource[]> => loginImporter.sources());
  ipcMain.handle(
    browserChannels.browserImportRead,
    (_event, browserId: unknown, profileId: unknown): Promise<BrowserImportReadResult> =>
      typeof browserId === "string" && typeof profileId === "string"
        ? loginImporter.read(browserId, profileId)
        : Promise.resolve({ ok: false, error: "profile-not-found" }),
  );
  ipcMain.handle(
    browserChannels.browserImportCommit,
    (_event, pendingId: unknown, sites: unknown): Promise<BrowserImportCommitResult> => {
      // 入参是 renderer 给的：pendingId 必须是串，sites 必须是串数组，否则当已过期处理
      const selected = Array.isArray(sites) && sites.every((site) => typeof site === "string") ? (sites as string[]) : null;
      if (typeof pendingId !== "string" || selected === null) {
        return Promise.resolve({ ok: false, error: "no-pending" });
      }
      return loginImporter.commit(pendingId, selected);
    },
  );
  ipcMain.handle(browserChannels.browserImportCancel, (_event, pendingId: unknown): void => {
    if (typeof pendingId === "string") loginImporter.cancel(pendingId);
  });
  ipcMain.handle(browserChannels.browserImportedList, (): Promise<BrowserImportedSite[]> => loginImporter.imported());
  ipcMain.handle(browserChannels.browserImportedRemove, (_event, site: unknown): Promise<BrowserImportedSite[]> => {
    if (typeof site !== "string" || site === "") return loginImporter.imported();
    return loginImporter.removeImported(site);
  });
}
