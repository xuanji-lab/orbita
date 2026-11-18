/**
 * Office「指哪打哪」的 contextBridge 面 —— 四层契约的第 3 层。
 * 白名单与子进程都在主进程（shared/office.ts 顶注释）：这里只是把请求递过去。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  OfficeChanges,
  OfficeRenderRequest,
  OfficeRenderResult,
  OfficeRevertResult,
  OfficeStatus,
} from "../../shared/office.ts";

export interface OfficeChangedEvent {
  /** 被改的文件（主进程判过白名单的真实路径） */
  path: string;
}

export const officeApi = {
  /**
   * OfficeCLI 是否可用（定位 + 验活，主进程缓存；设置变了下次自动重探）。
   * `force` = 丢掉缓存重新探测（设置页的「重新检测」）。
   */
  status: (force?: boolean): Promise<OfficeStatus> => ipcRenderer.invoke(ipcChannels.officeStatus, force === true),
  /** `view html` 的自包含 HTML；不可用时 kind:"unavailable"（面板退回网格 / 大纲） */
  render: (req: OfficeRenderRequest): Promise<OfficeRenderResult> => ipcRenderer.invoke(ipcChannels.officeRender, req),
  /** 这一批改动清单（agent 用 edit_office 改的） */
  changes: (req: OfficeRenderRequest): Promise<OfficeChanges> => ipcRenderer.invoke(ipcChannels.officeChanges, req),
  /** 整批回退（用备份还原整份文件） */
  revert: (req: OfficeRenderRequest): Promise<OfficeRevertResult> => ipcRenderer.invoke(ipcChannels.officeRevert, req),
  /** 截预览区进剪贴板（Electron capturePage，不用外部浏览器） */
  capture: (rect: { x: number; y: number; width: number; height: number }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(ipcChannels.officeCapture, rect),
  /** 订阅「agent 改过一份文件」；返回退订函数 */
  onChanged: (listener: (event: OfficeChangedEvent) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: OfficeChangedEvent): void => listener(payload);
    ipcRenderer.on(ipcChannels.officeChanged, handler);
    return () => ipcRenderer.removeListener(ipcChannels.officeChanged, handler);
  },
} as const;
