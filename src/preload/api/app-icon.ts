/**
 * 应用图标的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { appIconChannels, type AppIconApplyRequest, type AppIconApplyResult } from "../../shared/app-icon.ts";

export const appIconApi = {
  /** 把画好的 PNG 交给主进程换 Dock / 任务栏图标并缓存；失败原因在返回值里（不抛） */
  apply: (request: AppIconApplyRequest): Promise<AppIconApplyResult> =>
    ipcRenderer.invoke(appIconChannels.appIconApply, request),
};
