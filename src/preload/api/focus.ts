/**
 * 专注模式的 contextBridge 面 —— 四层契约的第 3 层。
 * 路径白名单在主进程（focus/ipc.ts）：renderer 只传 workspaceId。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { FocusChanges, FocusNotifyRequest } from "../../shared/focus.ts";

export const focusApi = {
  /** 一个工作区此刻的 U / M 改动（含增删行数与当前分支名）；git 只读 */
  changes: (workspaceId: string): Promise<FocusChanges> =>
    ipcRenderer.invoke(ipcChannels.focusChanges, workspaceId),
  /** 专注时间到：发一条系统通知（点按聚焦窗口） */
  notifyDone: (req: FocusNotifyRequest): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.focusNotifyDone, req),
} as const;
