/**
 * 把 Electron 的 net 接到可续传下载器上（`resilient-download.ts`）。
 *
 * 两个 Electron 特有的点：
 *
 * 1. **更新走独立 session**：electron-updater 用分区 `electron-updater`，代理 / 证书策略
 *    都挂在这个 session 上；这里必须用同一个，否则 HTTPS_PROXY 设了也不生效。
 * 2. **GitHub 资产要先解析 302**：`api.github.com/.../releases/assets/<id>` 返回的是
 *    指向 `release-assets.githubusercontent.com` 的签名地址。签名地址只解析一次并存起来，
 *    所有分段直接请求它——不这么做的话，177MB 分成几十段就是几十次 API 请求，会撞上
 *    GitHub 未认证的 60 次/小时限额。签名过期（403）时清掉缓存重新解析一次。
 *
 * 这里只 override `download()`（完整安装包走它）；差分下载的 blockmap 仍走库原有的
 * `downloadToBuffer` / Range 逻辑。
 */
import { net, session, type IncomingMessage, type Session } from "electron";
import type { AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor.js";
import { NET_SESSION_NAME } from "electron-updater/out/electronHttpExecutor.js";
import {
  downloadFile,
  DownloadChecksumError,
  DownloadUnsupportedError,
  type RangeRequest,
  type RangeResponse,
  type RangeTransport,
} from "./resilient-download.ts";

/** 连接建立 / 两次收到数据之间的上限；超过就中止并续传 */
const IDLE_TIMEOUT_MS = 30_000;

type DownloadOptions = Parameters<ElectronHttpExecutor["download"]>[2];

/** `OutgoingHttpHeaders | readonly string[]` 统一成小写字符串表 */
function normalizeHeaders(headers: DownloadOptions["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (headers === null || headers === undefined || Array.isArray(headers)) {
    return { accept: "application/octet-stream" };
  }
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") result[key.toLowerCase()] = value;
    else if (Array.isArray(value)) result[key.toLowerCase()] = value.join(", ");
  }
  if (result.accept === undefined) result.accept = "application/octet-stream";
  return result;
}

function headerValue(headers: IncomingMessage["headers"], name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** GitHub 的发布资产端点：只有它需要先解析 302 */
function needsRedirectResolution(url: URL): boolean {
  return url.hostname === "api.github.com" && url.pathname.includes("/releases/assets/");
}

/**
 * 一段响应的 body 转成异步迭代器。
 *
 * Electron 的 IncomingMessage 只暴露事件、不是 Node Readable，所以不能直接
 * `for await`；这里自己做队列 + 空闲超时。空闲计时器触发时主动 abort，让下载器按
 * “这一段断了”处理并从已写位置续传。
 */
async function* bodyOf(request: Electron.ClientRequest, response: IncomingMessage): AsyncGenerator<Buffer> {
  const queue: Buffer[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;

  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const resetIdle = (): void => {
    if (idle !== null) clearTimeout(idle);
    idle = setTimeout(() => {
      failure = new Error("更新下载连接空闲超时");
      ended = true;
      request.abort();
      notify();
    }, IDLE_TIMEOUT_MS);
  };

  const onData = (chunk: Buffer): void => {
    queue.push(chunk);
    resetIdle();
    notify();
  };
  const onEnd = (): void => {
    ended = true;
    notify();
  };
  // 官方文档要求 end 监听先于 data 注册
  response.on("end", onEnd);
  response.on("data", onData);
  response.on("error", (error: Error) => {
    failure = error;
    ended = true;
    notify();
  });

  resetIdle();
  try {
    while (!ended || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const chunk = queue.shift();
      if (chunk !== undefined) yield chunk;
    }
    if (failure !== null) throw failure;
  } finally {
    if (idle !== null) clearTimeout(idle);
    response.removeListener("data", onData);
    response.removeListener("end", onEnd);
    wake = null;
  }
}

class ElectronRangeTransport implements RangeTransport {
  private readonly httpSession: Session;
  /** 原始 URL → 已解析的签名地址（多个分段共享；过期后由 open() 清掉重解析） */
  private readonly resolved = new Map<string, Promise<string>>();

  constructor() {
    this.httpSession = session.fromPartition(NET_SESSION_NAME, { cache: false });
  }

  async open(url: URL, headers: Readonly<Record<string, string>>, range: RangeRequest): Promise<RangeResponse> {
    const target = await this.targetOf(url, headers);
    const response = await this.request(target, headers, range);
    if (response.status === 403 || response.status === 401) {
      // 签名地址过期：重新解析一次再试。API 请求只多一次，不会撞限流。
      response.close();
      this.resolved.delete(url.href);
      const refreshed = await this.targetOf(url, headers);
      return await this.request(refreshed, headers, range);
    }
    return response;
  }

  private async targetOf(url: URL, headers: Readonly<Record<string, string>>): Promise<string> {
    if (!needsRedirectResolution(url)) return url.href;
    const cached = this.resolved.get(url.href);
    if (cached !== undefined) return await cached;

    const promise = this.resolveRedirect(url, headers);
    this.resolved.set(url.href, promise);
    try {
      return await promise;
    } catch (error) {
      this.resolved.delete(url.href);
      throw error;
    }
  }

  /** 只取 302 的 Location，不读 body；没有重定向就返回原地址 */
  private async resolveRedirect(url: URL, headers: Readonly<Record<string, string>>): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const request = net.request({
        url: url.href,
        method: "GET",
        session: this.httpSession,
        redirect: "manual",
        headers: { ...headers, range: "bytes=0-0" },
      });
      const finish = (error: Error | null, target?: string): void => {
        if (settled) return;
        settled = true;
        request.abort();
        if (error !== null) reject(error);
        else resolve(target ?? url.href);
      };
      request.on("response", (response) => {
        // 有些地址不会重定向（镜像 / 直链）：直接用原地址
        const location = headerValue(response.headers, "location");
        if (isRedirect(response.statusCode) && location !== null) {
          try {
            finish(null, new URL(location, url).href);
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
          }
        } else {
          finish(null, url.href);
        }
      });
      // manual 模式下 Electron 重定向走 `redirect` 事件而不是 response；
      // 不 follow 的话之后会补一个 "Redirect was cancelled"，由 settled 守卫吃掉。
      request.on("redirect", (_status: number, _method: string, redirectUrl: string) => {
        try {
          finish(null, new URL(redirectUrl, url).href);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      request.on("error", (error: Error) => finish(error));
      request.end();
    });
  }

  private async request(
    target: string,
    headers: Readonly<Record<string, string>>,
    range: RangeRequest,
  ): Promise<RangeResponse> {
    return await new Promise<RangeResponse>((resolve, reject) => {
      let settled = false;
      const request = net.request({
        url: target,
        method: "GET",
        session: this.httpSession,
        redirect: "follow",
        headers: { ...headers, range: `bytes=${range.start}-${range.end}` },
      });
      request.on("response", (response) => {
        settled = true;
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: bodyOf(request, response),
          close: () => request.abort(),
        });
      });
      request.on("error", (error: Error) => {
        if (!settled) reject(error);
      });
      request.end();
    });
  }
}

/**
 * 换掉 electron-updater 的下载器。**必须在 `setFeedURL` 之前调用**：provider 的
 * runtimeOptions 在 setFeedURL 时捕获 `httpExecutor`，晚一步换，provider 还在用旧的。
 */
export class ResilientElectronHttpExecutor extends ElectronHttpExecutor {
  override async download(url: URL, destination: string, options: DownloadOptions): Promise<string> {
    try {
      await downloadFile(new ElectronRangeTransport(), {
        url,
        destination,
        headers: normalizeHeaders(options.headers),
        sha512: options.sha512,
        cancellation: options.cancellationToken,
        onProgress: options.onProgress,
        log: (message) => console.info(message),
      });
      return destination;
    } catch (error) {
      // 只有“这个服务器没法分段/没法确定大小”才退回库的单连接下载；
      // 校验失败、用户取消、重试耗尽都如实抛给上层，不掩盖。
      if (error instanceof DownloadUnsupportedError) {
        console.warn(`[更新] 分段下载不可用，退回单连接：${error.message}`);
        return await super.download(url, destination, options);
      }
      if (error instanceof DownloadChecksumError) {
        console.error("[更新] 更新包校验失败，丢弃本次下载");
      }
      throw error;
    }
  }
}

/** 供 service.ts 在 setFeedURL 前安装 */
export function installResilientDownload(updater: AppUpdater): void {
  (updater as AppUpdater & { httpExecutor: ElectronHttpExecutor }).httpExecutor = new ResilientElectronHttpExecutor();
}
