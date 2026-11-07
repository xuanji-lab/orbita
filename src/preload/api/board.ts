/**
 * 看板的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/plugin-board.ts）。
 * 全局周看板拉一周的数据；会话结果与周看板按快照画卡时，用模板哈希换一次性 iframe 地址。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { BoardFrameRequest, BoardFrameResult, BoardWeekRequest, BoardWeekResponse } from "../../shared/plugin-board.ts";

export const boardApi = {
  /** 一周 7 天的运行（带卡快照）与排期；入参当地周一 00:00，主进程会规整。weekStart 非有限数回 null */
  week: (request: BoardWeekRequest): Promise<BoardWeekResponse | null> => ipcRenderer.invoke(ipcChannels.boardWeek, request),
  /** 模板哈希 → 一次性 iframe 地址（orbita-panel://）；仓库里没有 / 哈希不合规回 null */
  frame: (request: BoardFrameRequest): Promise<BoardFrameResult> => ipcRenderer.invoke(ipcChannels.boardFrame, request),
};
