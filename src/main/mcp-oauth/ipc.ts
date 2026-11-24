/**
 * 远程 MCP OAuth 的 IPC —— 四层契约的第 2 层。三个通道：登录（会等浏览器回来）、取消、目录里的「断开」。
 * agent 进程要 token 走的是另一条线（agent 事件 `mcpTokenRequest`，在 main/index.ts 接到 manager.accessToken）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ConnectorStatus } from "../../shared/connectors.ts";
import type { McpOauthLoginResult, McpOauthTarget } from "../../shared/mcp-oauth.ts";
import { disconnectConnector, loginMcpServer, type OauthActionDeps } from "./actions.ts";

export function registerMcpOauthIpc(deps: OauthActionDeps): void {
  ipcMain.handle(ipcChannels.mcpOauthLogin, async (_e, target: McpOauthTarget): Promise<McpOauthLoginResult> => {
    // 入参来自 renderer：只认两种形状，别的当不支持（不让一个畸形对象走到 mcp.json 的读写）
    const shaped =
      typeof target === "object" && target !== null
        ? "connectorId" in target && typeof target.connectorId === "string"
          ? { connectorId: target.connectorId }
          : "serverName" in target && typeof target.serverName === "string"
            ? { serverName: target.serverName }
            : null
        : null;
    if (shaped === null) return { ok: false, code: "unsupported", message: "unknown login target" };
    return loginMcpServer(shaped as McpOauthTarget, deps);
  });
  ipcMain.handle(ipcChannels.mcpOauthCancel, (_e, serverName: string): void => {
    deps.oauth.cancel(String(serverName));
  });
  ipcMain.handle(
    ipcChannels.connectorDisconnect,
    (_e, connectorId: string): Promise<ConnectorStatus> => disconnectConnector(String(connectorId), deps),
  );
}
