/**
 * 专注模式的 contextBridge 面 —— 四层契约的第 3 层。
 * 路径白名单在主进程（focus/ipc.ts）：renderer 只传 workspaceId。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { FocusChanges, FocusNotifyRequest, FocusSummaryRequest, FocusSummaryResult } from "../../shared/focus.ts";

export const focusApi = {
  /** 一个工作区此刻的 U / M 改动（含增删行数与当前分支名）；git 只读 */
  changes: (workspaceId: string): Promise<FocusChanges> =>
    ipcRenderer.invoke(ipcChannels.focusChanges, workspaceId),
  /** 专注时间到：发一条系统通知（点按聚焦窗口） */
  notifyDone: (req: FocusNotifyRequest): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.focusNotifyDone, req),
  /** 收工小结：归拢 [startedAt, until] 的素材交给家务活模型，回 3–5 条要点 */
  summarize: (req: FocusSummaryRequest): Promise<FocusSummaryResult> =>
    ipcRenderer.invoke(ipcChannels.focusSummarize, req),
  /**
   * 系统即将睡眠（powerMonitor 的 suspend，无载荷）。返回退订函数，与其它域的
   * onEvent 同款。renderer 收到后按「睡眠即结束专注」处理当前一轮。
   */
  onSuspend: (listener: () => void): (() => void) => {
    const handler = (): void => listener();
    ipcRenderer.on(ipcChannels.focusSuspend, handler);
    return () => {
      ipcRenderer.removeListener(ipcChannels.focusSuspend, handler);
    };
  },
} as const;
