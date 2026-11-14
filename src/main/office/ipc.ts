/**
 * Office 的 IPC —— 四层契约的第 2 层（契约在 `shared/office.ts`）。
 *
 * 白名单与文件面板同一套：根每次现算（`resolveFileRoots`），路径 realpath 后必须落在
 * 这些根之内——预览通道不能变成「用 officecli 读任意文件」。
 *
 * `office:capture` 是位图链路：用 Electron 自己的 `webContents.capturePage` 截预览区
 * （**不用 `view screenshot`**：它要求机器上装着 Chrome / Edge，mac 上只认三个固定 .app，
 * 且没有配置项），截图进剪贴板，用户可以贴进聊天 / 文档。
 */
import { app, BrowserWindow, clipboard, ipcMain } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  OFFICE_HTML_MAX_BYTES,
  officeFormatOf,
  type OfficeChanges,
  type OfficeRenderRequest,
  type OfficeRenderResult,
  type OfficeRevertResult,
  type OfficeStatus,
} from "../../shared/office.ts";
import type { AppSettings } from "../../shared/settings.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { whitelistedPath } from "../files/list.ts";
import { mainWindows } from "../window/main-windows.ts";
import { officeCliCandidates } from "./cli.ts";
import { OfficeService } from "./service.ts";

/** 备份目录：会话工作台下的子目录（不进仓、不跟会话文件混在一起） */
export const OFFICE_BACKUP_DIR = "office-backups";

export interface OfficeIpcDeps {
  settings: { read(): Promise<AppSettings> };
  sessions: SessionStore;
  workspaces: WorkspaceStore;
}

/**
 * 建一个 OfficeService（主进程只有这一份：验活缓存与改动清单都是进程级状态）并注册 IPC。
 * 返回 service 供 agent 的 officeRequest 用。
 */
export function registerOfficeIpc(deps: OfficeIpcDeps): OfficeService {
  const office = new OfficeService({
    configuredPath: async () => (await deps.settings.read()).officeCliPath,
    candidatesFor: (configuredPath) =>
      officeCliCandidates({
        settingsPath: configuredPath,
        env: process.env["ORBITA_OFFICECLI"],
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        platform: process.platform,
        arch: process.arch,
        envVars: process.env,
      }),
    backupDir: async (sessionId) => {
      try {
        return join(deps.sessions.workbenchPath(sessionId), OFFICE_BACKUP_DIR);
      } catch {
        return null;
      }
    },
    notify: (file) => {
      for (const window of mainWindows.list()) {
        window.webContents.send(ipcChannels.officeChanged, { path: file });
      }
    },
  });

  const rootsOf = (req: OfficeRenderRequest) =>
    resolveFileRoots(deps.workspaces, deps.sessions, {
      sessionId: req.sessionId,
      workspaceId: req.workspaceId,
      ...(req.extraWorkspaceId === undefined ? {} : { extraWorkspaceId: req.extraWorkspaceId }),
    });

  // force = 设置页的「重新检测」：丢掉验活缓存（刚装好 OfficeCLI 的人不必重启应用）
  ipcMain.handle(ipcChannels.officeStatus, (_event, force: unknown): Promise<OfficeStatus> => {
    if (force === true) office.invalidate();
    return office.status();
  });

  ipcMain.handle(ipcChannels.officeRender, async (_event, req: OfficeRenderRequest): Promise<OfficeRenderResult> => {
    const roots = await rootsOf(req);
    const path = await whitelistedPath(roots, req);
    if (officeFormatOf(path) === null) {
      return { kind: "unavailable", detail: "只有 .xlsx / .pptx 走 Office 渲染" };
    }
    const rendered = await office.render(path);
    if (rendered.kind === "html" && rendered.html.length > OFFICE_HTML_MAX_BYTES) {
      return {
        kind: "unavailable",
        detail: `渲染结果 ${Math.round(rendered.html.length / 1024 / 1024)} MB，超过 ${Math.round(OFFICE_HTML_MAX_BYTES / 1024 / 1024)} MB 上限（已退回数据视图）`,
      };
    }
    return rendered;
  });

  ipcMain.handle(ipcChannels.officeChanges, async (_event, req: OfficeRenderRequest): Promise<OfficeChanges> => {
    const roots = await rootsOf(req);
    const path = await whitelistedPath(roots, req);
    if (req.sessionId === null) return { file: path, items: [], backup: null, startedAt: null };
    return await office.changesOf(req.sessionId, path);
  });

  ipcMain.handle(ipcChannels.officeRevert, async (_event, req: OfficeRenderRequest): Promise<OfficeRevertResult> => {
    const roots = await rootsOf(req);
    const path = await whitelistedPath(roots, req);
    if (req.sessionId === null) return { ok: false, error: "这条会话还没有 id，找不到这批改动的备份", restored: 0 };
    return office.revert(req.sessionId, path);
  });

  /**
   * 截预览区进剪贴板。rect 由 renderer 按 iframe 的 getBoundingClientRect 给（CSS px =
   * DIP，与 capturePage 同一套）；夹到窗口内容区内，坏值直接拒绝——不能让一次截图
   * 把整块屏幕（含别的窗口）截进来。
   */
  ipcMain.handle(
    ipcChannels.officeCapture,
    async (event, rect: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; error?: string }> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window === null) return { ok: false, error: "找不到窗口" };
      const size = window.getContentSize();
      const width = size[0] ?? 0;
      const height = size[1] ?? 0;
      const x = Math.max(0, Math.min(width - 1, Math.round(rect.x)));
      const y = Math.max(0, Math.min(height - 1, Math.round(rect.y)));
      const w = Math.max(0, Math.min(width - x, Math.round(rect.width)));
      const h = Math.max(0, Math.min(height - y, Math.round(rect.height)));
      if (w < 8 || h < 8) return { ok: false, error: "预览区太小，没法截图" };
      const image = await window.webContents.capturePage({ x, y, width: w, height: h });
      clipboard.writeImage(image);
      return { ok: true };
    },
  );

  return office;
}
