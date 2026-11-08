/**
 * 连接目录的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ConnectorId, ConnectorSaveResult, ConnectorStatus } from "../../shared/connectors.ts";
import type { McpOauthLoginResult, McpOauthTarget } from "../../shared/mcp-oauth.ts";

export const connectorApi = {
  /** 实测一家的状态（命令行跑官方状态命令、远程 MCP 真连一次）。不会 reject：探测失败以 failed 数据返回 */
  probe: (id: ConnectorId): Promise<ConnectorStatus> => ipcRenderer.invoke(ipcChannels.connectorProbe, id),
  /** 把 token 写进 mcp.json、重连并实测。校验不过 / 写失败以数据返回 */
  saveToken: (id: ConnectorId, token: string): Promise<ConnectorSaveResult> =>
    ipcRenderer.invoke(ipcChannels.connectorSaveToken, id, token),
  /**
   * 浏览器登录一台远程 MCP（目录里的一家，或 mcp.json 里已有的一条）。会等到登录结束才返回（成功 / 取消 / 超时 / 拒绝），
   * 失败以数据返回，不会 reject。成功后 `auth: "oauth"` 已写进 mcp.json、agent 进程已重连
   */
  oauthLogin: (target: McpOauthTarget): Promise<McpOauthLoginResult> => ipcRenderer.invoke(ipcChannels.mcpOauthLogin, target),
  /** 取消一台正在进行的登录（入参 server 名） */
  oauthCancel: (serverName: string): Promise<void> => ipcRenderer.invoke(ipcChannels.mcpOauthCancel, serverName),
  /** 断开一家 OAuth 型：撤销（尽力）、删本机凭据、移除 mcp.json 里的条目、重连；返回断开后的状态 */
  disconnect: (id: ConnectorId): Promise<ConnectorStatus> => ipcRenderer.invoke(ipcChannels.connectorDisconnect, id),
} as const;
