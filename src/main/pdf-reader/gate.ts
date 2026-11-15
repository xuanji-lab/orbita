/**
 * `orbita-reader://` 的请求闸判定（纯函数，可单测；装在 window/request-gate.ts 的合并监听里）。
 */
import { PDF_READER_ORIGIN, PDF_READER_PAGE_URL, PDF_READER_SCHEME } from "../../shared/pdf-reader.ts";
import type { GateRequestInfo, RequestGate } from "../window/request-gate-rules.ts";

const isOurs = (url: string | null): boolean => url !== null && url.startsWith(`${PDF_READER_ORIGIN}/`);
const withoutQuery = (url: string): string => url.split(/[?#]/)[0] ?? url;

/**
 * 放行：
 * - 入口页（subFrame）：只能是主窗口 renderer 页面的直接子框架，地址只能是 reader.html；
 * - 阅读器内部的 iframe（subFrame）：父框架是阅读器页面、祖父是我们的 renderer 页面；
 * - 子资源（脚本、样式、字体、fetch、worker…）：发起的框架是阅读器的页面之一；没有框架（worker 里发的）
 *   看 referrer。
 * 顶层导航（mainFrame）一律拦：协议里的页面不该被开成一个窗口。
 */
export function isReaderRequestAllowed(info: GateRequestInfo, isOwnPage: (url: string) => boolean): boolean {
  if (info.resourceType === "mainFrame") return false;
  if (info.resourceType === "subFrame") {
    if (info.parentUrl !== null && !info.parentHasParent && isOwnPage(info.parentUrl)) {
      return withoutQuery(info.url) === PDF_READER_PAGE_URL;
    }
    return isOurs(info.parentUrl) && info.grandparentUrl !== null && isOwnPage(info.grandparentUrl);
  }
  if (info.frameUrl !== null) return isOurs(info.frameUrl);
  return isOurs(info.referrer);
}

export function readerRequestGate(isOwnPage: (url: string) => boolean): RequestGate {
  return { scheme: PDF_READER_SCHEME, allow: (info) => isReaderRequestAllowed(info, isOwnPage) };
}
