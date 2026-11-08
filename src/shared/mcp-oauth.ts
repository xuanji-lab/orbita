/**
 * 远程 MCP 的 OAuth 登录契约 —— IPC 四层的第 1 层。
 *
 * **进程分工**（为什么这样分，见 main/mcp-oauth/manager.ts 的模块头）：
 * - 主进程：开系统浏览器、起本机回调、跟授权服务器说话、加密存 client 信息与 token、到期前续期。
 * - agent 进程：只在每次发请求前问主进程要「此刻能用的 access token」；**refresh token 永远不出主进程**。
 * - renderer：点「登录」，等一个结果；取消、断开也是它发起。
 */
import type { ConnectorId } from "./connectors.ts";

/** 登录哪一台：目录里的一家（还没写进 mcp.json 也行，成功后由主进程写），或 mcp.json 里已有的一条 */
export type McpOauthTarget = { connectorId: ConnectorId } | { serverName: string };

/** 登录没成的原因：界面把已知的几种说成本地话，其余原样给 message */
export type McpOauthFailureCode =
  /** 用户点了取消 */
  | "cancelled"
  /** 时限（5 分钟）内浏览器没有回来 */
  | "timeout"
  /** 用户在授权页点了拒绝（回调带 error） */
  | "denied"
  /** 这台不能走 OAuth 登录（不是远端 URL 型 / 工作区自带的配置不能由我们改 / 目录里没有这家） */
  | "unsupported"
  /** 服务端的授权元数据读不到或不支持（没有动态注册、不支持 PKCE S256 等） */
  | "discovery"
  /** 其余：授权码换 token 被拒、本机回调起不来、系统不能加密存储…… */
  | "failed";

export type McpOauthLoginResult =
  | { ok: true; serverName: string }
  | { ok: false; code: McpOauthFailureCode; message: string };

/** agent 进程向主进程要 access token 的回执（requestId 问答的又一对，见 agent-ipc 的 mcpTokenRequest） */
export type McpTokenOutcome =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      /** `login-required`：没登录过 / 授权已失效（续期被拒）/ 配置里的 URL 与登录时不是同一个；`error`：其余（网络、本机存储坏了） */
      code: "login-required" | "error";
      error: string;
    };

/**
 * 两个 MCP 地址是不是同一个资源。凭据按 server 名存，但**绑着登录时的 URL**：
 * 用户把 mcp.json 里的 url 改成别处（或同名的工作区配置指向别家），旧 token 不能被带过去。
 * 比较 origin + 路径（忽略末尾斜杠）+ 查询串；认不出的 URL 一律当不同。
 */
export function sameMcpUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    const path = (url: URL): string => (url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "");
    return x.origin === y.origin && path(x) === path(y) && x.search === y.search;
  } catch {
    return false;
  }
}
