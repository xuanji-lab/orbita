/**
 * `orbita-media://` 协议在 Electron 里的装配（token 校验、Range 解析与应答规划在 media-stream.ts，可单测）。
 *
 * 两步分开，因为 Electron 要求不同时机（同 plugin/panel-protocol.ts）：
 * - `registerMediaScheme()`：**必须在 app ready 之前**（模块顶层）。`standard`（相对 URL、主机段按标准解析）
 *   + `stream`（Chromium 的 <video> / <audio> 经自定义协议播放必须有它，否则拖进度与边下边播都不工作）；
 *   不给 secure / supportFetchAPI / bypassCSP / corsEnabled——只服务 <audio> / <video> 元素。
 * - `installMediaProtocol()`：ready 之后在默认 session 上挂应答，并用 webRequest 只放行**主窗口 renderer
 *   页面**发起的 media 类请求（别的页面 / 子框架 / fetch 一律取消）。
 */
import { protocol, session } from "electron";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { MEDIA_SCHEME } from "../../shared/files.ts";
import { MediaTokens, planMediaResponse } from "./media-stream.ts";

export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, stream: true } }]);
}

export function installMediaProtocol(tokens: MediaTokens, isOwnPage: (url: string) => boolean): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${MEDIA_SCHEME}://*/*`] }, (details, callback) => {
    const pageUrl = details.webContents?.getURL() ?? "";
    callback({ cancel: details.resourceType !== "media" || !isOwnPage(pageUrl) });
  });
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const plan = await planMediaResponse(tokens, {
      url: request.url,
      method: request.method,
      range: request.headers.get("range"),
    });
    if (plan.body === null) {
      const errorBody = plan.status === 400 || plan.status === 404 || plan.status === 405 ? String(plan.status) : null;
      return new Response(errorBody, { status: plan.status, headers: plan.headers });
    }
    // 闭区间 [start, end]；播放器中途 seek / 关面板会取消请求，Readable.toWeb 在取消时销毁文件流
    const stream = createReadStream(plan.body.path, { start: plan.body.start, end: plan.body.end });
    const body = Readable.toWeb(stream) as ReadableStream<Uint8Array>;
    return new Response(body, { status: plan.status, headers: plan.headers });
  });
}
