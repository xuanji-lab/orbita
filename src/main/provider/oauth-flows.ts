/**
 * 浏览器登录订阅的分派层：Claude 走我们手写的流程（oauth.ts），ChatGPT（Codex）/
 * GitHub Copilot / xAI 三家**复用 pi 自带的流程**（pi-ai 的 OAuthAuth：login / refresh /
 * toAuth）。纯流程模块，不依赖 Electron；凭据仍落我们自己的 ProviderStore / SecretsPort，
 * 不落 ~/.pi/agent。
 *
 * 为什么这三家能复用、Claude 当初没复用：pi 的 OAuthAuth 只要一个交互回调（prompt / notify），
 * 返回一份凭据对象，存哪里由调用方定——它不依赖 pi 的凭据存储。三家的协议细节（Codex 的
 * PKCE + 1455 端口回调、Copilot 与 xAI 的设备码、Copilot 令牌里的 proxy-ep 地址）都在 pi
 * 里，跟着 pi 升级；我们只把交互接到 Electron 上：
 *   - auth_url / device_code → 用系统浏览器打开；设备码另推给设置页显示；
 *   - select（Codex 问浏览器还是设备码）→ 选浏览器；text（Copilot 问企业域名）→ 留空 = github.com；
 *   - manual_code（Codex 的手工粘码兜底）→ 不提供，挂到流程自己取消为止。
 *
 * 取流程走 pi-ai 的两个公开入口：`providers/<id>` 给出 provider 定义（auth.oauth 是懒加载
 * 的 OAuthAuth），`bun-oauth` 把各流程**静态**登记进懒加载器——pi 默认用变量路径动态
 * import 流程模块，打进 electron-vite 的 bundle 后那条路径就不存在了。
 */
import type { AuthEvent, AuthPrompt, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { OauthCredential } from "../../shared/provider.ts";
import { refreshClaudeCredential } from "./oauth.ts";

registerBunOAuthFlows();

/** 复用 pi 流程的三家（目录条目 id → pi 的 provider 定义） */
const PI_PROVIDERS = {
  "openai-codex": openaiCodexProvider,
  "github-copilot": githubCopilotProvider,
  xai: xaiProvider,
} as const;

type PiFlowKind = keyof typeof PI_PROVIDERS;

const flowCache = new Map<PiFlowKind, OAuthAuth>();

function isPiFlowKind(kind: string): kind is PiFlowKind {
  return Object.hasOwn(PI_PROVIDERS, kind);
}

/** 这个目录条目是不是走 pi 的登录流程 */
export function isPiOauthKind(kind: string): boolean {
  return isPiFlowKind(kind);
}

function piFlow(kind: string): OAuthAuth {
  if (!isPiFlowKind(kind)) throw new Error(`没有「${kind}」的浏览器登录流程`);
  const cached = flowCache.get(kind);
  if (cached !== undefined) return cached;
  const oauth = PI_PROVIDERS[kind]().auth.oauth;
  if (oauth === undefined) throw new Error(`pi 的 ${kind} 没有 OAuth 登录`);
  flowCache.set(kind, oauth);
  return oauth;
}

/**
 * 续期判定的提前量。Copilot / xAI 的流程已经扣过 5 分钟，Codex 没扣——统一再扣 1 分钟，
 * 不至于拿一个只剩几秒的令牌去发一整轮。
 */
const EXPIRY_MARGIN_MS = 60_000;

/** pi 凭据 → 我们的形状：四个公共字段之外的都进 flowData，原样保管 */
export function fromPiCredential(credential: OAuthCredential, accountEmail: string | null): OauthCredential {
  const { type: _type, access, refresh, expires, ...rest } = credential;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: expires - EXPIRY_MARGIN_MS,
    accountEmail,
    ...(Object.keys(rest).length === 0 ? {} : { flowData: rest }),
  };
}

/** 我们的形状 → pi 凭据：flowData 摊回去（Copilot 续期要 enterpriseUrl，Codex 要 accountId） */
export function toPiCredential(credential: OauthCredential): OAuthCredential {
  return {
    ...(credential.flowData ?? {}),
    type: "oauth",
    access: credential.accessToken,
    refresh: credential.refreshToken,
    expires: credential.expiresAt,
  };
}

/** 从 JWT 访问令牌里取账号邮箱（展示用；Codex 的令牌带 profile 声明，取不到就是 null） */
export function emailFromJwt(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    const profile = claims["https://api.openai.com/profile"];
    const nested =
      typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>)["email"] : undefined;
    const email = nested ?? claims["email"];
    return typeof email === "string" && email !== "" ? email : null;
  } catch {
    return null;
  }
}

export interface PiLoginPorts {
  /** 打开系统浏览器（Electron 侧注入 shell.openExternal；测试注入假实现） */
  openExternal: (url: string) => Promise<void>;
  /** 设备码到了：设置页要把码显示出来（用户在浏览器里手输） */
  onDeviceCode: (code: { userCode: string; verificationUri: string }) => void;
  /** 用户点了取消 */
  signal: AbortSignal;
  /** 浏览器里逗留的上限（默认 15 分钟，与设备码的有效期同长） */
  timeoutMs?: number;
}

/**
 * 把 pi 的交互回调接到 Electron 上（规则见模块头）。导出供测试：每一种 prompt / notify
 * 都要有确定的去向——漏接一种，流程就会挂在那里等一个永远不来的回答。
 */
export function createInteraction(ports: PiLoginPorts, signal: AbortSignal) {
  return {
    signal,
    prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "select") {
        const browser = prompt.options.find((option) => option.id === "browser") ?? prompt.options[0];
        return browser === undefined ? Promise.reject(new Error("登录流程没有给可选的方式")) : Promise.resolve(browser.id);
      }
      // Copilot 问 GitHub Enterprise 域名：留空 = github.com（企业版今天不接）
      if (prompt.type === "text") return Promise.resolve("");
      if (prompt.type === "manual_code") {
        // 不提供手工粘码：挂着，直到流程拿到回调后自己取消它，或整个登录被取消 / 超时
        return new Promise<string>((_resolve, reject) => {
          const abort = () => reject(new Error("Login cancelled"));
          if (prompt.signal?.aborted === true || signal.aborted) {
            abort();
            return;
          }
          prompt.signal?.addEventListener("abort", abort, { once: true });
          signal.addEventListener("abort", abort, { once: true });
        });
      }
      return Promise.reject(new Error("这一步要手填密钥，浏览器登录不支持"));
    },
    notify(event: AuthEvent): void {
      if (event.type === "auth_url") {
        void ports.openExternal(event.url).catch(() => undefined);
        return;
      }
      if (event.type === "device_code") {
        ports.onDeviceCode({ userCode: event.userCode, verificationUri: event.verificationUri });
        void ports.openExternal(event.verificationUri).catch(() => undefined);
      }
    },
  };
}

/** 完整登录：交给 pi 的流程跑，拿回凭据换成我们的形状。取消与超时都抛错 */
export async function runPiOauthLogin(kind: string, ports: PiLoginPorts): Promise<OauthCredential> {
  const flow = piFlow(kind);
  const timeout = AbortSignal.timeout(ports.timeoutMs ?? 15 * 60 * 1000);
  const signal = AbortSignal.any([ports.signal, timeout]);
  try {
    const credential = await flow.login(createInteraction(ports, signal));
    return fromPiCredential(credential, emailFromJwt(credential.access));
  } catch (error) {
    if (ports.signal.aborted) throw new Error("登录已取消");
    if (timeout.aborted) throw new Error("登录没有在时限内完成（浏览器里授权后要回到 Orbita）");
    throw error;
  }
}

/** 续期：Claude 走我们的 token 端点，其余交给 pi 的流程。账号邮箱沿用（它不过期） */
export async function refreshOauthCredential(kind: string, credential: OauthCredential): Promise<OauthCredential> {
  if (!isPiFlowKind(kind)) return refreshClaudeCredential(credential);
  const fresh = await piFlow(kind).refresh(toPiCredential(credential), AbortSignal.timeout(30_000));
  return fromPiCredential(fresh, credential.accountEmail ?? emailFromJwt(fresh.access));
}

/**
 * 凭据 → 请求鉴权。Claude 与 Codex / xAI 就是访问令牌本身；Copilot 的令牌里写着这个账号
 * 该打哪个地址（proxy-ep：个人 / 商业 / 企业版各不同），由 pi 的 toAuth 解出来。
 */
export async function oauthRequestAuth(
  kind: string,
  credential: OauthCredential,
): Promise<{ apiKey: string; baseUrl?: string; headers?: Record<string, string> }> {
  if (!isPiFlowKind(kind)) return { apiKey: credential.accessToken };
  const auth = await piFlow(kind).toAuth(toPiCredential(credential));
  // pi 的头允许 null（= 删掉这个头）；我们的 endpoint 头只有字符串，null 的那几个直接不带
  const headers = Object.fromEntries(
    Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  return {
    apiKey: auth.apiKey ?? credential.accessToken,
    ...(auth.baseUrl === undefined ? {} : { baseUrl: auth.baseUrl }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
  };
}

/**
 * 登录后预填的型号：Copilot 的登录会顺手问出这个账号**实际开着**的型号（availableModelIds），
 * 比目录准；其余几家没有这一项，返回空（用户用「获取列表」，失败时退目录候选）。
 */
export function modelsFromCredential(credential: OauthCredential): string[] {
  const ids = credential.flowData?.["availableModelIds"];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id !== "") : [];
}
