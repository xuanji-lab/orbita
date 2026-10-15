/**
 * 意图系统（实验功能 intent-system）的 contextBridge 面 —— 四层契约的第 3 层。
 *
 * intent-lab 是本机另一个进程；renderer 不直连它（沙盒里的 fetch 也该走四层契约
 * 的边界），HTTP 在主进程（main/agent/intent-lab-client.ts）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { IntentEdges } from "../../shared/intent-edges.ts";
import type { IntentHealth } from "../../shared/intent-lab.ts";

export const intentApi = {
  /** 探活 intent-lab（GET /health）。null = 连不上 / 形状坏（探活语义：畸形等于不可用） */
  health: (): Promise<IntentHealth | null> => ipcRenderer.invoke(ipcChannels.intentHealth),
  /** 某一问的图数据（GET /edges?sessionId=&turnId=）。null = 连不上 / 畸形 / 没跑过召回 */
  edges: (sessionId: string, turnId: string): Promise<IntentEdges | null> =>
    ipcRenderer.invoke(ipcChannels.intentEdges, sessionId, turnId),
};
