/**
 * Anthropic OAuth（Claude Pro / Max 订阅登录）—— 纯流程模块，不依赖 Electron。
 *
 * 流程与 pi 内建的 anthropicOAuth 同源（也是 Claude Code CLI 自己的路）：PKCE +
 * 本机回调服务器 + 平台 token 端点。不直接复用 pi 的实现，因为它长在 pi-ai 的
 * auth 交互框架里（interaction.prompt 的手工粘码路径、pi 自己的凭据存储），
 * 我们的凭据要落自己的 ProviderStore / SecretsPort——那套框架反向依赖我们的 IPC。
 *
 * 「持久」的两半都在仓内：refresh token 加密落盘（SafeStorageSecrets），用前按
 * 剩余寿命自动续期（ProviderStore.resolveOauthApiKey）。上游会轮换 refresh token，
 * 所以每次续期成功都要立刻把新的一对写回去——并发的续期必须合并成一次
 * （sub2api #1035：两路并发各拿旧 refresh token 去换，后到的那路 invalid_grant）。
 *
 * 端点口径（2026-10 核对）：authorize 走 claude.ai（会 302 到 claude.com/cai/oauth，
 * 两者等价）；token 在 platform.claude.com。回调用 loopback（RFC 8252），
 * 端口由操作系统分配——固定端口在 53692 撞上别的进程时登录会无声失败。
 */
import { createHash, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:http";
import type { OauthCredential } from "../../shared/provider.ts";

/** Claude Code CLI 的公开 client id（Anthropic 不开放注册第三方 client，所有桌面工具共用它） */
export const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const CLAUDE_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** 授权页要求的 scope 集合（与 Claude Code 一致；缺 user:inference 就调不了模型） */
const CLAUDE_SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
/** 访问令牌的提前刷新量：expiresAt 已含它，刷新判定不需要再留余量 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** OAuth 访问令牌的识别特征——上游用它判定 Bearer + oauth beta 头（pi-ai 同款判定） */
export function isClaudeOauthToken(key: string): boolean {
  return key.includes("sk-ant-oat");
}

/**
 * 测试连接 / 发现模型要带的请求头：Bearer 鉴权 + oauth beta（缺 claude-code beta
 * 上游会判「非 Claude Code 请求」拒收，见 sub2api 对上游流量的对齐记录）。
 * 只在 anthropic-messages 协议分支里使用，其它协议不该调它。
 */
export function anthropicOauthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
  };
}

type FetchLike = typeof globalThis.fetch;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function generatePkce(): Promise<PkcePair> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(input: { challenge: string; state: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLAUDE_CLIENT_ID,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: CLAUDE_SCOPES,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
  });
  return `${CLAUDE_AUTHORIZE_URL}?${params.toString()}`;
}

/** 回调查询串的解析（独立出来供测试：服务器只做透传） */
export function parseCallbackQuery(search: string): { code?: string; state?: string; error?: string } {
  const params = new URLSearchParams(search);
  const code = params.get("code") ?? undefined;
  const state = params.get("state") ?? undefined;
  const error = params.get("error") ?? undefined;
  return { ...(code !== undefined ? { code } : {}), ...(state !== undefined ? { state } : {}), ...(error !== undefined ? { error } : {}) };
}

async function postToken(
  body: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  let response: Response;
  try {
    response = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new Error(`Claude token 请求失败：${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    // invalid_grant 等 OAuth 错误在 body 里；带出来才能区分「网络问题」与「登录已失效」
    throw new Error(`Claude token 端点返回 ${response.status}：${text.slice(0, 300)}`);
  }
  try {
    const data = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number };
    if (typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || typeof data.expires_in !== "number") {
      throw new Error("字段缺失");
    }
    return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
  } catch {
    throw new Error(`Claude token 端点返回了无法解析的 JSON：${text.slice(0, 300)}`);
  }
}

/** 授权码换令牌（登录的最后一步） */
export async function exchangeCodeForCredential(
  input: { code: string; verifier: string; redirectUri: string },
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<OauthCredential> {
  const tokens = await postToken(
    {
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT_ID,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    fetchImpl,
    30_000,
  );
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000 - EXPIRY_MARGIN_MS,
    accountEmail: null,
  };
}

/**
 * 用 refresh token 续期。上游会轮换 refresh token（返回新的一对），旧的随即作废——
 * 调用方必须立刻把返回值落盘。账号邮箱尽力保留（它不会过期，只是展示信息）。
 */
export async function refreshClaudeCredential(
  credential: OauthCredential,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<OauthCredential> {
  const tokens = await postToken(
    { grant_type: "refresh_token", client_id: CLAUDE_CLIENT_ID, refresh_token: credential.refreshToken },
    fetchImpl,
    30_000,
  );
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000 - EXPIRY_MARGIN_MS,
    accountEmail: credential.accountEmail,
  };
}

/**
 * 问 /v1/me 拿账号邮箱（展示用）。任何失败都容忍为 null——拿不到不影响可用性，
 * 不该让一次成功的登录因为展示信息而报错。
 */
export async function fetchAccountEmail(
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<string | null> {
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/me", {
      headers: anthropicOauthHeaders(accessToken),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = JSON.parse(await response.text()) as { email?: string; account?: { email?: string } };
    return data.email ?? data.account?.email ?? null;
  } catch {
    return null;
  }
}

export interface CallbackServer {
  /** 实际拿到回调的 redirect_uri（端口由 OS 分配，拼进授权 URL） */
  redirectUri: string;
  /** 等授权码；null = 被取消。state 不匹配视为无效重试等待 */
  waitForCode: () => Promise<{ code: string; state: string } | null>;
  close: () => void;
}

/** 起本机回调服务器（127.0.0.1 + OS 分配端口）。redirect_uri 用 localhost 写法——Claude Code 同款。 */
export function listenForCallback(expectedState: string): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let settled: ((value: { code: string; state: string } | null) => void) | undefined;
    const waitForCode = new Promise<{ code: string; state: string } | null>((resolveWait) => {
      let done = false;
      settled = (value) => {
        if (done) return;
        done = true;
        resolveWait(value);
      };
    });
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const done = (html: string, status: number) => {
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      };
      const parsed = parseCallbackQuery(url.search.replace(/^\?/, ""));
      if (parsed.error !== undefined) {
        done("<html><body><p>授权未完成，可以关掉这个页面回到 Orbita。</p></body></html>", 400);
        settled?.(null);
        return;
      }
      if (parsed.code === undefined || parsed.state === undefined) {
        done("<html><body><p>回调缺少参数。</p></body></html>", 400);
        return;
      }
      if (parsed.state !== expectedState) {
        done("<html><body><p>state 不匹配，已忽略。</p></body></html>", 400);
        return;
      }
      done(
        "<html><body><p>授权完成，可以关掉这个页面回到 Orbita。</p></body></html>",
        200,
      );
      settled?.({ code: parsed.code, state: parsed.state });
    });
    server.on("error", (error) => reject(error));
    // 端口 0 = OS 分配。只绑 127.0.0.1：回调不需要对外可见，也不谈 IPv6 双栈的歧义
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("回调服务器拿到了意外的地址"));
        return;
      }
      resolve({
        redirectUri: `http://localhost:${address.port}/callback`,
        waitForCode: () => waitForCode,
        close: () => {
          settled?.(null);
          server.close();
        },
      });
    });
  });
}

export interface LoginPorts {
  /** 打开系统浏览器（Electron 侧注入 shell.openExternal；测试注入假实现） */
  openExternal: (url: string) => Promise<void>;
  fetchImpl?: FetchLike;
  /** 用户在浏览器里逗留的上限；到点未回调就放弃（默认 10 分钟） */
  timeoutMs?: number;
}

/** 完整登录：PKCE → 回调服务器 → 浏览器授权 → 换令牌 → 问账号邮箱。 */
export async function runClaudeLogin(ports: LoginPorts): Promise<OauthCredential> {
  const { verifier, challenge } = await generatePkce();
  const state = randomBytes(24).toString("hex");
  const server = await listenForCallback(state);
  const timeout = ports.timeoutMs ?? 10 * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await ports.openExternal(buildAuthorizeUrl({ challenge, state, redirectUri: server.redirectUri }));
    const result = await Promise.race([
      server.waitForCode(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeout);
      }),
    ]);
    if (result === null) throw new Error("登录没有在时限内完成（浏览器授权后需要回到本机回调）");
    const credential = await exchangeCodeForCredential(
      { code: result.code, verifier, redirectUri: server.redirectUri },
      ports.fetchImpl ?? globalThis.fetch,
    );
    const accountEmail = await fetchAccountEmail(credential.accessToken, ports.fetchImpl ?? globalThis.fetch);
    return { ...credential, accountEmail };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    server.close();
  }
}
