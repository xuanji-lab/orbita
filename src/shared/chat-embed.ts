/**
 * 回答里的内嵌交互图（```html-embed 围栏）—— IPC 四层契约的第 1 层。
 *
 * 模型在回答里写一段 ```html-embed 围栏，renderer 把它包成一份完整文档（主题变量、量高度、暂停动画的引导脚本
 * 在最前面，见 renderer/features/chat/html-embed.ts），经 `chat:embed-frame` 交给主进程换一个**一次性**的
 * `orbita-panel://doc/<token>` 地址，再挂进 `sandbox="allow-scripts"` 的 iframe。
 *
 * **为什么不用 srcdoc**：srcdoc 文档继承嵌入者的 CSP，主窗口是 `script-src 'self'`，图里的内联脚本跑不起来；
 * 放开主窗口 CSP 等于削弱整个应用。看板卡已经有现成的一次性协议（main/plugin/panel-frame.ts，CSP 走响应头：
 * 不能联网、不能读本地文件、不能嵌框架、不能提交表单），这里复用同一个仓库，不另起一套。
 *
 * **信任边界**：图的内容是模型写的，一律当不可信代码。主进程只认字符串、按字节数限长，别的什么都不做——
 * 它不读盘、不拼路径，所以没有路径穿越面；沙箱与 CSP 由 iframe 属性和协议响应头两道把住。
 */

/** 围栏标记（info string 的第一个词）。不劫持普通 ```html：那是「给我一段 HTML 代码」的回答，要看源码 */
export const HTML_EMBED_LANG = "html-embed";

/**
 * 包好的文档上限（UTF-8 字节）。一张讲解图正常几 KB 到几十 KB；放宽只会放大拒绝服务面。
 * 主进程与 renderer 各查一次（renderer 超了直接显示源码 + 一行原因，不发 IPC）。
 */
export const HTML_EMBED_MAX_BYTES = 256 * 1024;

/** `chat:embed-frame` 入参：renderer 包好的完整 HTML 文档 */
export interface ChatEmbedFrameRequest {
  html: string;
}

/** 一次性 iframe 地址（同看板卡的 `orbita-panel://doc/<token>`，取走一次即作废）；入参不合规为 null */
export type ChatEmbedFrameResult = { frameUrl: string } | null;

/** 入参校验（主进程用；renderer 的入参不是信任边界）：不是 `{ html: string }`、空串、超长都回 null */
export function chatEmbedHtmlOf(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const html = (raw as Record<string, unknown>)["html"];
  if (typeof html !== "string" || html === "") return null;
  // 字符数先挡一道（UTF-8 每字符至少 1 字节），再精确量字节
  if (html.length > HTML_EMBED_MAX_BYTES) return null;
  return utf8Bytes(html) > HTML_EMBED_MAX_BYTES ? null : html;
}

/** UTF-8 字节数（不依赖 Buffer / TextEncoder，两端都能用） */
export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      // 代理对 = 一个 4 字节字符
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}
