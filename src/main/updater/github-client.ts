/**
 * GitHub 出口 —— 更新器 provider 与「历史版本」列表**共用**的一层（纯逻辑，`node --test` 直接测）。
 *
 * 为什么要有这一层：同一份 Release 被两处读（`github-api-provider.ts` 查更新、
 * `recent-releases.ts` 列历史版本），以前两处各调一套网络：更新器走 electron-updater 自己的
 * Electron session（因此吃得到 `HTTPS_PROXY`，见 github-net.ts），列表走全局 fetch
 * （拿不到那个 session，也就没有代理），缓存 / 限流各记各的。这里把三件事收成一处：
 *
 * 1. **同一套网络**：请求只经过注入的 transport；生产环境是 `github-net.ts` 的
 *    Electron `net` + `NET_SESSION_NAME` 那个 session——与下载器同一条出口、同一份代理。
 * 2. **共享缓存**：按「地址 + Accept」记文本，成功才缓存（失败下次还是真打一次），
 *    默认 10 分钟。两处最值钱的共享点是每版 Release 附带的 `latest.yml`：更新器与历史列表
 *    读的是同一个资产，第二处直接命中。**`cache: false` 给「必须看当下」的请求用**
 *    （`releases/latest`、tag 查询）：用户点「检查更新」就该真的问一次。
 * 3. **限流记录**：GitHub 未认证请求 60 次/小时，响应头带 `x-ratelimit-*`。配额归零后
 *    在重置时刻前不再发新请求（缓存命中照常），否则每次都白撞一次 403，界面只能说
 *    「稍后再试」。记录在实例上，两处看的是同一本账。
 *
 * **不做的**：不带 token（发布的是公开仓）、不做 ETag 条件请求、不引镜像源。
 */
import type { OutgoingHttpHeaders, RequestOptions } from "node:http";

/** GitHub REST API。网页域名（github.com）在部分网络被拦，这个域名仍通（issue #283） */
export const API_ORIGIN = "https://api.github.com";

/** 读 JSON 元数据（releases/latest、releases/tags/...、releases 列表） */
export const JSON_ACCEPT = "application/vnd.github+json";

/** 读发布资产（latest.yml、安装包、blockmap）：不带这个头，API 只会回 JSON 元数据 */
export const ASSET_ACCEPT = "application/octet-stream";

/** 成功的响应记多久。内测期发布节奏远慢于 10 分钟 */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;

/** GitHub 要求带 User-Agent；Chromium 会给一个，这里写成自己的名字，日志里看得出是谁 */
const USER_AGENT = "orbita";

export interface GitHubResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}

export interface GitHubRequest {
  url: URL;
  headers: Readonly<Record<string, string>>;
}

/** 传输层：生产是 `github-net.ts` 的 Electron net，测试注入替身 */
export type GitHubTransport = (request: GitHubRequest) => Promise<GitHubResponse>;

/** 读一次请求的选项 */
export interface GitHubReadOptions {
  /** 默认 true（按 TTL 命中缓存）；false = 必须打一次网络（检查更新、按 tag 查 Release） */
  cache?: boolean;
}

/** 限流状态快照（日志 / 测试用） */
export interface GitHubRateLimit {
  limit: number | null;
  remaining: number | null;
  /** 配额重置时刻（epoch ms） */
  resetAt: number | null;
  /** 这之前不再发新请求（epoch ms）；没被限流时 null */
  blockedUntil: number | null;
}

/** HTTP 层失败：带 statusCode，`failure.ts` 按它分类（404 / 429 / 5xx） */
export class GitHubHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly body: string;

  constructor(status: number, url: URL, body: string) {
    const excerpt = body.trim().slice(0, 300);
    super(excerpt === "" ? `HTTP ${status} ${url.href}` : `HTTP ${status} ${url.href}：${excerpt}`);
    this.name = "GitHubHttpError";
    this.statusCode = status;
    this.code = `HTTP_ERROR_${status}`;
    this.body = body;
  }
}

/** 客户端的最小面：「历史版本」列表只需要读 */
export interface GitHubReader {
  getJson(url: URL | string, options?: GitHubReadOptions): Promise<unknown>;
  getText(url: URL | string, accept: string, options?: GitHubReadOptions): Promise<string>;
}

export interface GitHubClientOptions {
  transport: GitHubTransport;
  /** 时钟（测试注入用） */
  now?: () => number;
  cacheTtlMs?: number;
}

/** 响应头里取一个数字（`x-ratelimit-reset` 是秒级 epoch） */
function headerNumber(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): number | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** `api.github.com/repos/<o>/<r>/releases/assets/<id>`：必须带资产头才会 302 到文件 */
export function isGitHubAssetUrl(url: URL): boolean {
  return url.hostname === "api.github.com" && url.pathname.includes("/releases/assets/");
}

/**
 * 同一规则的 Node 请求形态版（`configureRequestUrl` 之后只有 hostname + path）。
 * 下载器要用：库在差分下载里把 Accept 写死成通配符（DifferentialDownloader.createRequestOptions），
 * 资产端点收到它回的是 **206 + JSON 元数据**——比 200 JSON 更糟，分段长度对得上、内容对不上，
 * 要等到 sha512 校验才失败。地址认得出是资产端点，就把头改回来。
 */
export function isGitHubAssetRequest(hostname: string | null | undefined, path: string | null | undefined): boolean {
  return hostname === "api.github.com" && (path ?? "").includes("/releases/assets/");
}

/** 资产端点请求补上 `Accept: application/octet-stream`；别的地址原样返回 */
export function withAssetAccept(options: RequestOptions): RequestOptions {
  if (!isGitHubAssetRequest(options.hostname ?? undefined, options.path)) return options;
  return { ...options, headers: { ...options.headers, accept: ASSET_ACCEPT } };
}

/**
 * 资产重定向的目标域白名单（安全纵深：302 不许把下载带去陌生域）。
 *
 * 实测（2026-10-31）：`api.github.com/repos/<o>/<r>/releases/assets/<id>` 带
 * `Accept: application/octet-stream` 时 302 到 `release-assets.githubusercontent.com`
 * 的签名地址；历史上还有 `objects.githubusercontent.com` 一族。白名单 = https 的
 * `github.com`、`api.github.com` 与 `*.githubusercontent.com` 子域（裸 apex 不放）。
 * 更新器（resilient-executor.ts 的 resolveRedirect）与「历史版本」说明的退路 URL
 * （recent-releases.ts 的 browser_download_url）共用这一张表。
 */
export function githubRedirectAllowed(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host === "api.github.com") return true;
  return host.endsWith(".githubusercontent.com");
}

/**
 * 这条通道（electronGitHubTransport）只服务 JSON 元数据与 latest.yml 一类小文件；
 * 超过它说明端点被换 / 出错，别把内存吃进去。blockmap / 安装包不走这条通道。
 */
export const GITHUB_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

/** 攒响应体时判一笔：未超限 null；超限给出错误（调用方中止请求并丢弃已收字节） */
export function githubBodyLimitError(received: number): Error | null {
  if (received <= GITHUB_BODY_LIMIT_BYTES) return null;
  return new Error(
    `GitHub 响应超过 ${GITHUB_BODY_LIMIT_BYTES} 字节上限（这条通道只读 JSON / latest.yml，不该出现大响应）`,
  );
}

export class GitHubClient implements GitHubReader {
  private readonly transport: GitHubTransport;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  /** `Accept + 地址` → 上次成功的原文 */
  private readonly cache = new Map<string, { at: number; body: string }>();
  private rate: GitHubRateLimit = { limit: null, remaining: null, resetAt: null, blockedUntil: null };

  constructor(options: GitHubClientOptions) {
    this.transport = options.transport;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /** 共享的限流账：`remaining` 归零后到 `resetAt` 之前不发新请求 */
  rateLimit(): GitHubRateLimit {
    return { ...this.rate };
  }

  /** 读 JSON（`releases/latest`、列表端点）。形状不对当失败，不猜 */
  async getJson(url: URL | string, options: GitHubReadOptions = {}): Promise<unknown> {
    const target = this.urlOf(url);
    const raw = await this.getText(target, JSON_ACCEPT, options);
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`GitHub API 返回的不是 JSON：${target.href}`);
    }
  }

  /** 读发布资产（latest.yml / blockmap）；下载器读大文件不走这里 */
  async getAsset(url: URL | string, options: GitHubReadOptions = {}): Promise<string> {
    return await this.getText(this.urlOf(url), ASSET_ACCEPT, options);
  }

  async getText(url: URL | string, accept: string, options: GitHubReadOptions = {}): Promise<string> {
    const target = this.urlOf(url);
    const cacheable = options.cache !== false;
    const key = `${accept} ${target.href}`;

    if (cacheable) {
      const hit = this.cache.get(key);
      if (hit !== undefined) {
        if (this.now() - hit.at < this.cacheTtlMs) return hit.body;
        this.cache.delete(key);
      }
    }

    this.throwIfRateLimited(target);
    const response = await this.transport({
      url: target,
      headers: { accept, "user-agent": USER_AGENT },
    });
    this.recordRateLimit(response.headers);

    if (response.status < 200 || response.status >= 300) {
      throw new GitHubHttpError(response.status, target, response.body);
    }
    // 只缓存成功：断网 / 5xx 之后的下一次必须真的再打
    if (cacheable) this.cache.set(key, { at: this.now(), body: response.body });
    return response.body;
  }

  /** 缓存命中不需要网络，所以限流检查只在真正要发请求时做 */
  private throwIfRateLimited(url: URL): void {
    const until = this.rate.blockedUntil;
    if (until === null || this.now() >= until) return;
    const error = new GitHubHttpError(
      429,
      url,
      `GitHub API 限流中：${new Date(until).toISOString()} 之后恢复（未认证请求每小时 ${this.rate.limit ?? 60} 次）。`,
    );
    throw error;
  }

  /** 每次响应都记一笔；配额归零或 429 的 Retry-After 都折成「到某时刻为止别再发」 */
  private recordRateLimit(headers: Readonly<Record<string, string | string[] | undefined>>): void {
    const limit = headerNumber(headers, "x-ratelimit-limit");
    const remaining = headerNumber(headers, "x-ratelimit-remaining");
    const reset = headerNumber(headers, "x-ratelimit-reset");
    const retryAfter = headerNumber(headers, "retry-after");

    if (limit !== null) this.rate.limit = limit;
    if (remaining !== null) this.rate.remaining = remaining;
    if (reset !== null) this.rate.resetAt = reset * 1000;

    let blockedUntil = this.rate.blockedUntil;
    if (remaining !== null && remaining <= 0 && reset !== null) blockedUntil = reset * 1000;
    if (retryAfter !== null) {
      blockedUntil = Math.max(blockedUntil ?? 0, this.now() + retryAfter * 1000);
    }
    this.rate.blockedUntil = blockedUntil;
  }

  private urlOf(url: URL | string): URL {
    return typeof url === "string" ? new URL(url) : url;
  }
}
