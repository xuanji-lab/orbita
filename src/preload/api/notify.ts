/**
 * 提示音记账的 contextBridge 面 —— 四层契约的第 3 层。
 * 时刻由主进程打；入参在主进程净化（notify/chime-log.ts），这里原样转交。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ChimeLogRequest } from "../../shared/notify.ts";

export const notifyApi = {
  /** 真响了一声：记进 `<userData>/chime-log.jsonl`（哪一刻、为什么、为谁） */
  logChime: (request: ChimeLogRequest): Promise<void> => ipcRenderer.invoke(ipcChannels.notifyChimeLog, request),
} as const;
