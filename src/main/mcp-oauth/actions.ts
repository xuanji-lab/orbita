/**
 * 登录 / 断开的编排：把 manager（OAuth 本体）、mcp.json 的读写、agent 进程的重连、实测串起来。
 * 单独成文件（不 import electron），好用 `node --test` 直接测——同 connector/save-token.ts 的做法。
 */
import { connectorOauthServerConfig, findConnector, type ConnectorStatus } from "../../shared/connectors.ts";
import { isHttpServer, type McpServer } from "../../shared/mcp.ts";
import type { McpOauthLoginResult, McpOauthTarget } from "../../shared/mcp-oauth.ts";

/** 编排用到的 OAuth 本体面（McpOauthManager 的子集，测试注入假的） */
export interface OauthOps {
  login(serverName: string, serverUrl: string): Promise<McpOauthLoginResult>;
  logout(serverName: string): Promise<{ revoked: boolean }>;
  cancel(serverName: string): void;
}

/** mcp.json 的读写面（McpStore 的子集） */
export interface OauthConfigStore {
  read(): Promise<Record<string, McpServer>>;
  upsert(name: string, server: McpServer): Promise<void>;
  remove(name: string): Promise<void>;
}

export interface OauthActionDeps {
  oauth: OauthOps;
  store: OauthConfigStore;
  /** 让 agent 进程拆连接重来（登录 / 断开后用新配置、新 token） */
  reload: () => Promise<void>;
  /** 断开后重新实测这一家，把新状态交回界面 */
  probe: (connectorId: string) => Promise<ConnectorStatus>;
}

const NOT_GLOBAL =
  "只能登录全局 mcp.json 里的远程 MCP。工作区自带的 .mcp.json 里的，请在那个文件里给这条加 \"auth\": \"oauth\" 后再登录。";

/** 登录：成功后把 `auth: "oauth"` 标记写进 mcp.json 并重连。失败原样带回，不动配置。 */
export async function loginMcpServer(target: McpOauthTarget, deps: OauthActionDeps): Promise<McpOauthLoginResult> {
  let name: string;
  let url: string;
  let config: McpServer;
  if ("connectorId" in target) {
    const entry = findConnector(String(target.connectorId));
    const wanted = entry === undefined ? null : connectorOauthServerConfig(entry);
    if (entry?.mcp === undefined || wanted === null) {
      return { ok: false, code: "unsupported", message: "这一家不走 OAuth 登录" };
    }
    name = entry.mcp.serverName;
    url = entry.mcp.url;
    config = wanted;
  } else {
    name = String(target.serverName);
    let servers: Record<string, McpServer>;
    try {
      servers = await deps.store.read();
    } catch (cause) {
      return { ok: false, code: "failed", message: `读不了 mcp.json：${cause instanceof Error ? cause.message : String(cause)}` };
    }
    const server = servers[name];
    if (server === undefined) return { ok: false, code: "unsupported", message: NOT_GLOBAL };
    if (!isHttpServer(server)) return { ok: false, code: "unsupported", message: "只有远程（URL）MCP 能走 OAuth 登录" };
    url = server.url;
    config = { ...server, auth: "oauth" as const };
  }
  const result = await deps.oauth.login(name, url);
  if (!result.ok) return result;
  try {
    await deps.store.upsert(name, config);
  } catch (cause) {
    return { ok: false, code: "failed", message: `登录成功但写不进 mcp.json：${cause instanceof Error ? cause.message : String(cause)}` };
  }
  await deps.reload().catch((cause: unknown) => {
    console.error("[main] MCP 登录成功、mcp.json 已写入，但重连失败（下次开轮会用新配置）", cause instanceof Error ? cause.message : "");
  });
  return result;
}

/** 断开一家目录里的 OAuth 型：撤销（尽力）→ 删本机凭据 → 移除 mcp.json 里的那条 → 重连 → 返回新状态。 */
export async function disconnectConnector(connectorId: string, deps: OauthActionDeps): Promise<ConnectorStatus> {
  const entry = findConnector(connectorId);
  if (entry?.kind !== "mcp-oauth" || entry.mcp === undefined) {
    return { kind: "failed", code: "error", message: "这一家不是 OAuth 登录的，没有可断开的登录" };
  }
  try {
    await deps.oauth.logout(entry.mcp.serverName);
    await deps.store.remove(entry.mcp.serverName).catch((cause: unknown) => {
      // 条目本来就不在（用户手动删过）不算失败：断开的目的已经达到
      if (!(cause instanceof Error && cause.message.startsWith("No such server"))) throw cause;
    });
  } catch (cause) {
    return { kind: "failed", code: "error", message: cause instanceof Error ? cause.message : String(cause) };
  }
  await deps.reload().catch((cause: unknown) => {
    console.error("[main] MCP 已断开、mcp.json 已更新，但重连失败（下次开轮会用新配置）", cause instanceof Error ? cause.message : "");
  });
  return deps.probe(connectorId);
}
