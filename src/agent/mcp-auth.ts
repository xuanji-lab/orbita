/**
 * 远程 MCP 的鉴权层：一个包在 `fetch` 外面的薄壳，传给 SDK 的 StreamableHTTP / SSE 传输。
 *
 * **为什么是包 fetch，不是 SDK 的 `authProvider`**：authProvider 路线里，401 之后 SDK 自己在 agent 进程里
 * 跑一遍发现 → 刷新 → 重新授权，refresh token 就得交给 agent 进程，而 refresh token 会被授权服务器轮换——
 * 主进程（实测连接、续期）与 agent 进程两边各拿旧的去换，后到的那路 invalid_grant（oauth.ts 的模块头
 * 讲过同一件事）。这里 agent 进程**只拿 access token**：每个请求前向主进程要此刻能用的那个，
 * 被 401 了就让主进程续期一次再试，仍 401 就是「需要登录」。登录、续期、存储全在主进程（main/mcp-oauth/）。
 *
 * 另一半：没标 `auth: "oauth"`、也没自带 Authorization 头的远端（用户手写的），服务端回 401 + Bearer 挑战时，
 * 抛 McpLoginRequiredError 而不是 SDK 的 `HTTP 401`——界面据此给「登录」入口（配置形态：任意远程 MCP 都能走登录）。
 */
import type { McpTokenOutcome } from "../shared/mcp-oauth.ts";

/** 服务端要求 OAuth 登录（或已存的授权失效了）。与「配置错 / 网络断」分开，界面给「登录」入口 */
export class McpLoginRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpLoginRequiredError";
  }
}

/** 取此刻能用的 access token；`forceRefresh` = 刚被 401 过，别给缓存里的 */
export type McpTokenSource = (forceRefresh: boolean) => Promise<McpTokenOutcome>;

type FetchLike = typeof globalThis.fetch;

function withBearer(init: RequestInit | undefined, accessToken: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return { ...init, headers };
}

/** 401 且带 Bearer 挑战（`WWW-Authenticate: Bearer …`，常带 resource_metadata）= 这台要 OAuth 登录 */
export function isBearerChallenge(response: Response): boolean {
  if (response.status !== 401) return false;
  const challenge = response.headers.get("www-authenticate") ?? "";
  return /resource_metadata\s*=/i.test(challenge) || /^\s*bearer\b/i.test(challenge);
}

function tokenFailure(outcome: Extract<McpTokenOutcome, { ok: false }>): Error {
  return outcome.code === "login-required" ? new McpLoginRequiredError(outcome.error) : new Error(outcome.error);
}

/** 丢掉不要的响应体，别让连接挂着 */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * 造这台 server 的 fetch。
 * - `tokenSource` 有（`auth: "oauth"`）：每个请求带 Bearer；401 → 续期一次重试一次；仍 401 → McpLoginRequiredError。
 * - `tokenSource` 没有：原样转发；仅当这台没有自带 Authorization 头时，把「401 + Bearer 挑战」翻成 McpLoginRequiredError。
 */
export function createAuthFetch(options: {
  serverName: string;
  tokenSource: McpTokenSource | null;
  /** 用户在 mcp.json 里自带了 Authorization 头（贴 token 的那种）：它 401 是 token 无效，不是要登录 */
  hasStaticAuthorization: boolean;
  baseFetch?: FetchLike;
}): FetchLike {
  const base = options.baseFetch ?? globalThis.fetch;
  const { tokenSource, serverName } = options;
  return async (input, init) => {
    if (tokenSource === null) {
      const response = await base(input, init);
      if (!options.hasStaticAuthorization && isBearerChallenge(response)) {
        await discard(response);
        throw new McpLoginRequiredError(`${serverName} 要求登录（服务端返回 401 并要求 OAuth 授权）`);
      }
      return response;
    }
    const first = await tokenSource(false);
    if (!first.ok) throw tokenFailure(first);
    const response = await base(input, withBearer(init, first.accessToken));
    if (response.status !== 401) return response;
    await discard(response);
    // 服务端不认这个 token（被撤销、时钟偏差、服务端重置）：让主进程续期一次，换了新的才值得重试
    const second = await tokenSource(true);
    if (!second.ok) throw tokenFailure(second);
    if (second.accessToken === first.accessToken) {
      throw new McpLoginRequiredError(`${serverName} 的登录已失效（服务端拒绝了当前的授权）`);
    }
    const retried = await base(input, withBearer(init, second.accessToken));
    if (retried.status === 401) {
      await discard(retried);
      throw new McpLoginRequiredError(`${serverName} 的登录已失效（续期后服务端仍拒绝）`);
    }
    return retried;
  };
}
