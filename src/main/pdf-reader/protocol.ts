/**
 * `orbita-reader://` 协议在 Electron 里的装配（应答逻辑在 respond.ts，判定在 `isReaderRequestAllowed`，都可单测）。
 *
 * **三层同源**：面板 iframe（reader.html，桥脚本在里面）→ 阅读器为 pdf.js 再建的 iframe（pdf/web/viewer.html）
 * → worker。三层都在 `orbita-reader://app` 下，阅读器内部的 `contentWindow` 访问与 module worker 才成立；
 * 面板（renderer 页面）与它们跨源，只走 postMessage。
 *
 * 特权：`standard`（相对 URL）+ `secure`（可信来源：module worker、wasm 要它）+ `supportFetchAPI`
 * （pdf.js 用 fetch 取 PDF 与 cmaps / wasm）+ `stream`（Range 分段流式读，几十 MB 的 PDF 不整份进内存）。
 * 不给 bypassCSP（CSP 走响应头，见 respond.ts）与 corsEnabled（只有同源请求）。
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { protocol, type CustomScheme } from "electron";
import { PDF_READER_SCHEME } from "../../shared/pdf-reader.ts";
import { isReaderRequestAllowed } from "./gate.ts";
import { respondReader, type ReaderResponseDeps } from "./respond.ts";
import type { RequestGate } from "../window/request-gate.ts";

export const READER_SCHEME_PRIVILEGE: CustomScheme = {
  scheme: PDF_READER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
};

export function readerRequestGate(isOwnPage: (url: string) => boolean): RequestGate {
  return { scheme: PDF_READER_SCHEME, allow: (info) => isReaderRequestAllowed(info, isOwnPage) };
}

export function installReaderProtocol(deps: ReaderResponseDeps): void {
  protocol.handle(PDF_READER_SCHEME, async (request) => {
    const reply = await respondReader(request.url, request.method, request.headers.get("range"), deps);
    if ("file" in reply) {
      const stream = Readable.toWeb(createReadStream(reply.file.path, { start: reply.file.start, end: reply.file.end }));
      return new Response(stream as ReadableStream<Uint8Array>, { status: reply.status, headers: reply.headers });
    }
    return new Response(reply.status === 416 || reply.body === "" ? null : reply.body, { status: reply.status, headers: reply.headers });
  });
}
