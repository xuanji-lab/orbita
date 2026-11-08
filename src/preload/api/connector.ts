/**
 * 连接目录的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ConnectorId, ConnectorSaveResult, ConnectorStatus } from "../../shared/connectors.ts";

export const connectorApi = {
  /** 实测一家的状态（命令行跑官方状态命令、远程 MCP 真连一次）。不会 reject：探测失败以 failed 数据返回 */
  probe: (id: ConnectorId): Promise<ConnectorStatus> => ipcRenderer.invoke(ipcChannels.connectorProbe, id),
  /** 把 token 写进 mcp.json、重连并实测。校验不过 / 写失败以数据返回 */
  saveToken: (id: ConnectorId, token: string): Promise<ConnectorSaveResult> =>
    ipcRenderer.invoke(ipcChannels.connectorSaveToken, id, token),
} as const;
