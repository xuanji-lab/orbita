/**
 * 远程 MCP 的 OAuth 客户端（登录 / 续期 / 断开）—— **全部在主进程**。
 *
 * 为什么放主进程（而 MCP 连接在 agent 进程）：浏览器、本机回调端口、加密存储（safeStorage 只在主进程）、
 * 持久化都是主进程的事（AGENTS.md「架构边界」）；而 refresh token 会被授权服务器轮换，两个进程各拿一份去换，
 * 后到的那路 invalid_grant（oauth.ts 的模块头讲过同一个坑）。所以：
 *   - 主进程独占 client 信息 + refresh token，到期前自己续期（同一台的并发续期合并成一次）；
 *   - agent 进程每次发请求前经 IPC 问 `accessToken()` 要此刻能用的 access token，别的什么都拿不到。
 *
 * 协议部分交给 SDK 的 `auth()`（MCP 授权规范：Protected Resource Metadata → 授权服务器元数据 → 动态客户端注册 →
 * PKCE S256 授权码 → token / refresh），不自己重写。我们补的是 SDK 不管的那一圈：
 *   本机 127.0.0.1 随机端口回调（state 校验、5 分钟时限、取消、端口起不来）、系统浏览器只开 https 授权地址、
 *   凭据绑定登录时的 MCP 地址、加密落盘、撤销。
 */
import { randomBytes } from "node:crypto";
import { auth, discoverOAuthServerInfo, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
  UnsupportedGrantTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { sameMcpUrl, type McpOauthFailureCode, type McpOauthLoginResult, type McpTokenOutcome } from "../../shared/mcp-oauth.ts";
import { listenForCallback } from "../provider/oauth.ts";
import type { McpOauthCredential, McpOauthCredentialStore } from "./credential-store.ts";
import { McpOauthFlowProvider } from "./provider.ts";

type FetchLike = typeof globalThis.fetch;

/** 浏览器里逗留的上限 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** access token 离失效不足这么久就先续期：免得拿一个只剩几秒的去发一整轮 */
export const EXPIRY_MARGIN_MS = 60 * 1000;
/** 授权服务器每一次请求（发现 / 注册 / 换 token / 撤销）的上限 */
const REQUEST_TIMEOUT_MS = 20_000;
const REVOKE_TIMEOUT_MS = 5_000;

export interface McpOauthPorts {
  /** 打开系统浏览器（Electron 侧注入 shell.openExternal；测试注入假的） */
  openExternal: (url: string) => Promise<void>;
  fetch?: FetchLike;
  loginTimeoutMs?: number;
  /** 指定回调端口（默认 OS 分配）；只有测试「端口被占」时用 */
  callbackPort?: number;
  now?: () => number;
}

/** 浏览器只许打开 https 授权页（loopback 的 http 留给本机联调 / 测试）：授权地址来自远端的元数据，不能让它塞 file: 或自定义协议 */
export function isSafeAuthorizationUrl(url: URL): boolean {
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** 授权服务器明确拒绝了这次续期（而不是网络 / 5xx）：此后再试也不会好，要用户重新登录 */
function isRefreshRefused(cause: unknown): boolean {
  return cause instanceof InvalidGrantError || cause instanceof InvalidClientError || cause instanceof UnauthorizedClientError || cause instanceof UnsupportedGrantTypeError;
}

interface ActiveLogin {
  promise: Promise<McpOauthLoginResult>;
  controller: AbortController;
}

export class McpOauthManager {
  private readonly store: McpOauthCredentialStore;
  private readonly ports: McpOauthPorts;
  private readonly logins = new Map<string, ActiveLogin>();
  private readonly refreshing = new Map<string, Promise<McpTokenOutcome>>();

  constructor(store: McpOauthCredentialStore, ports: McpOauthPorts) {
    this.store = store;
    this.ports = ports;
  }

  private now(): number {
    return (this.ports.now ?? Date.now)();
  }

  /** 每个对授权服务器的请求都带时限：卡住的服务不该把登录 / 续期拖死 */
  private fetchWithTimeout(timeoutMs: number = REQUEST_TIMEOUT_MS): FetchLike {
    const base = this.ports.fetch ?? globalThis.fetch;
    return (input, init) => base(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  isLoggingIn(serverName: string): boolean {
    return this.logins.has(serverName);
  }

  cancel(serverName: string): void {
    this.logins.get(serverName)?.controller.abort();
  }

  async hasCredential(serverName: string): Promise<boolean> {
    return (await this.store.get(serverName)) !== null;
  }

  /** 登录一台。同一台已在登录中的并入那一次（用户连点两下不会开两个浏览器页） */
  login(serverName: string, serverUrl: string): Promise<McpOauthLoginResult> {
    const running = this.logins.get(serverName);
    if (running !== undefined) return running.promise;
    const controller = new AbortController();
    const promise = this.runLogin(serverName, serverUrl, controller.signal).finally(() => {
      this.logins.delete(serverName);
    });
    this.logins.set(serverName, { promise, controller });
    return promise;
  }

  private async runLogin(serverName: string, serverUrl: string, signal: AbortSignal): Promise<McpOauthLoginResult> {
    const fail = (code: McpOauthFailureCode, message: string): McpOauthLoginResult => ({ ok: false, code, message });
    let target: URL;
    try {
      target = new URL(serverUrl);
    } catch {
      return fail("unsupported", `不是有效的地址：${serverUrl}`);
    }
    if (!isSafeAuthorizationUrl(target)) return fail("unsupported", "只有 https 的远程 MCP 能走 OAuth 登录");

    const state = randomBytes(24).toString("hex");
    let server: Awaited<ReturnType<typeof listenForCallback>>;
    try {
      server = await listenForCallback(state, {
        redirectHost: "127.0.0.1",
        strictErrors: true,
        ...(this.ports.callbackPort === undefined ? {} : { port: this.ports.callbackPort }),
      });
    } catch (cause) {
      return fail("failed", `无法在本机开启登录回调：${messageOf(cause)}`);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const provider = new McpOauthFlowProvider({
        redirectUrl: server.redirectUri,
        state,
        ...(this.ports.now === undefined ? {} : { now: this.ports.now }),
        onRedirect: async (authorizationUrl) => {
          if (!isSafeAuthorizationUrl(authorizationUrl)) {
            throw new Error(`授权地址不是 https，已拒绝打开：${authorizationUrl.protocol}`);
          }
          await this.ports.openExternal(authorizationUrl.toString());
        },
      });
      const fetchFn = this.fetchWithTimeout();

      // 第一段：发现 → 动态注册 → 拼授权地址（PKCE S256）→ 开浏览器。出错多半是服务端不支持（没有动态注册等）
      try {
        const started = await auth(provider, { serverUrl: target, fetchFn });
        if (started !== "REDIRECT") return fail("failed", "授权流程没有进入浏览器授权步骤");
      } catch (cause) {
        if (signal.aborted) return fail("cancelled", "登录已取消");
        return fail("discovery", messageOf(cause));
      }

      // 等浏览器回来：时限 / 取消 / 授权页的 error 各自说清
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.ports.loginTimeoutMs ?? LOGIN_TIMEOUT_MS);
      });
      const aborted = new Promise<"abort">((resolve) => {
        if (signal.aborted) resolve("abort");
        signal.addEventListener("abort", () => resolve("abort"), { once: true });
      });
      const outcome = await Promise.race([server.waitForOutcome(), timedOut, aborted]);
      if (outcome === "abort") return fail("cancelled", "登录已取消");
      if (outcome === "timeout") return fail("timeout", "登录没有在 5 分钟内完成（浏览器授权后需要回到本机回调）");
      if (outcome.kind === "closed") return fail("cancelled", "登录已取消");
      if (outcome.kind === "error") {
        return fail(outcome.error === "access_denied" ? "denied" : "failed", outcome.description ?? `授权页返回了 ${outcome.error}`);
      }

      // 第二段：授权码换 token。state 已由回调服务器核对；code_verifier 在 provider 里
      try {
        await auth(provider, { serverUrl: target, authorizationCode: outcome.code, fetchFn });
      } catch (cause) {
        if (signal.aborted) return fail("cancelled", "登录已取消");
        return fail("failed", `授权码换 token 失败：${messageOf(cause)}`);
      }
      const { client, tokens } = provider.snapshot();
      if (client === undefined || tokens === undefined) return fail("failed", "授权完成但没有拿到 token");
      await this.store.set(serverName, {
        serverUrl,
        clientInformation: client,
        tokens,
        expiresAt: this.expiryOf(tokens.expires_in, provider.tokensSavedAt),
        revocationEndpoint: provider.revocationEndpoint,
        savedAt: this.now(),
      });
      return { ok: true, serverName };
    } catch (cause) {
      return fail("failed", messageOf(cause));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      server.close();
    }
  }

  private expiryOf(expiresIn: number | undefined, savedAt: number | null): number | null {
    if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) return null;
    return (savedAt ?? this.now()) + expiresIn * 1000;
  }

  /**
   * agent 进程（与主进程自己的实测）要 access token。
   * 地址与登录时不是同一个 → 不给（login-required）；快失效 / 被 401 过 → 先续期（同一台并发合并）。
   */
  async accessToken(serverName: string, serverUrl: string, forceRefresh: boolean): Promise<McpTokenOutcome> {
    let credential: McpOauthCredential | null;
    try {
      credential = await this.store.get(serverName);
    } catch (cause) {
      return { ok: false, code: "error", error: `读不了本机保存的登录凭据：${messageOf(cause)}` };
    }
    if (credential === null) return { ok: false, code: "login-required", error: `${serverName} 还没有登录` };
    if (!sameMcpUrl(credential.serverUrl, serverUrl)) {
      return { ok: false, code: "login-required", error: `${serverName} 的地址与登录时不同（登录的是 ${credential.serverUrl}），需要重新登录` };
    }
    const expiring = credential.expiresAt !== null && credential.expiresAt - EXPIRY_MARGIN_MS <= this.now();
    if (!forceRefresh && !expiring) return { ok: true, accessToken: credential.tokens.access_token };
    const running = this.refreshing.get(serverName);
    if (running !== undefined) return running;
    const next = this.refresh(serverName, credential).finally(() => {
      this.refreshing.delete(serverName);
    });
    this.refreshing.set(serverName, next);
    return next;
  }

  private async refresh(serverName: string, credential: McpOauthCredential): Promise<McpTokenOutcome> {
    const refreshToken = credential.tokens.refresh_token;
    if (refreshToken === undefined) {
      return { ok: false, code: "login-required", error: `${serverName} 的登录已过期，需要重新登录` };
    }
    const fetchFn = this.fetchWithTimeout();
    let renewedTokens: OAuthTokens;
    try {
      const info = await discoverOAuthServerInfo(credential.serverUrl, { fetchFn });
      renewedTokens = await refreshAuthorization(info.authorizationServerUrl, {
        ...(info.authorizationServerMetadata === undefined ? {} : { metadata: info.authorizationServerMetadata }),
        clientInformation: credential.clientInformation,
        refreshToken,
        resource: new URL(info.resourceMetadata?.resource ?? credential.serverUrl),
        fetchFn,
      });
    } catch (cause) {
      if (isRefreshRefused(cause)) {
        // 授权服务器明确不认这个 refresh token / client（过期、被撤销、用过了）：留着没用，删掉，界面如实说需要登录
        await this.store.delete(serverName).catch(() => undefined);
        return { ok: false, code: "login-required", error: `${serverName} 的登录已失效（续期被拒绝），需要重新登录` };
      }
      // 网络 / 服务端暂时的问题：凭据原样留着，下次再试
      return { ok: false, code: "error", error: `续期 ${serverName} 的登录失败：${messageOf(cause)}` };
    }
    const renewed: McpOauthCredential = {
      ...credential,
      // refreshAuthorization 在响应里没有新 refresh token 时沿用旧的；有就是轮换了——旧的随即作废
      tokens: renewedTokens,
      expiresAt: this.expiryOf(renewedTokens.expires_in, this.now()),
      savedAt: this.now(),
    };
    try {
      // 上游轮换了 refresh token 的话，旧的已作废——必须立刻落盘
      await this.store.set(serverName, renewed);
    } catch (cause) {
      return { ok: false, code: "error", error: `续期成功但存不下新 token：${messageOf(cause)}` };
    }
    return { ok: true, accessToken: renewedTokens.access_token };
  }

  /**
   * 断开：有撤销端点就尽力撤销（失败不挡断开），再删本机凭据。返回是否确认撤销了——
   * 界面不靠它做判断，只用于日志 / 测试：撤销是对服务端的礼貌，本机删除才是断开的保证。
   */
  async logout(serverName: string): Promise<{ revoked: boolean }> {
    this.cancel(serverName);
    const credential = await this.store.get(serverName);
    let revoked = false;
    if (credential !== null) revoked = await this.revoke(credential);
    await this.store.delete(serverName);
    return { revoked };
  }

  private async revoke(credential: McpOauthCredential): Promise<boolean> {
    const endpoint = credential.revocationEndpoint;
    if (endpoint === null) return false;
    try {
      const url = new URL(endpoint);
      if (!isSafeAuthorizationUrl(url)) return false;
      const token = credential.tokens.refresh_token ?? credential.tokens.access_token;
      const hint = credential.tokens.refresh_token === undefined ? "access_token" : "refresh_token";
      const body = new URLSearchParams({ token, token_type_hint: hint, client_id: credential.clientInformation.client_id });
      const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
      const secret = (credential.clientInformation as { client_secret?: string }).client_secret;
      if (secret !== undefined) body.set("client_secret", secret);
      const response = await this.fetchWithTimeout(REVOKE_TIMEOUT_MS)(url, { method: "POST", headers, body });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }
}
