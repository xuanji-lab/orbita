/**
 * 面板 iframe 的文档仓库与响应（纯模块，不碰 Electron；协议的真实装配见 panel-protocol.ts）。
 *
 * **为什么不是 srcdoc**：主窗口 renderer 的 CSP 是 `script-src 'self'`，srcdoc 文档继承嵌入者的 CSP，
 * 模板里的内联脚本会被拦（2026-11-05 在 Electron 里实测：脚本没跑）。放开 renderer 的 CSP 等于削弱整个
 * 应用，所以改成自定义协议：iframe 用 `src="orbita-panel://doc/<token>"`，文档由主进程从内存里给出，
 * **CSP 走响应头**。走响应头还有一个好处：不用在不可信的模板里按字符串找 `<head>` 去插 meta——
 * 模板可以在注释里放一个假的 `<head>` 骗过插入位置，响应头没有这个问题。
 *
 * **谁能加载它**：
 * - token 是 128 位随机数，只在 `pluginPanelLoad` 的返回里出现一次；
 * - **一次性**：被取走一次就作废（iframe 取到文档之后，没有人能用同一个地址再取一遍）；未被取走的 60 秒后过期；
 * - 请求类型与发起者在 panel-protocol.ts 里把关（webRequest.onBeforeRequest，判定函数 `isPanelFrameLoad`）：
 *   只放行「主窗口自己的 renderer 页面的直接子框架」发起的 `subFrame` 请求，顶层导航、脚本、fetch、
 *   嵌套框架一律取消——协议处理器收到的请求没有 `Sec-Fetch-Dest`（2026-11-05 实测，它只带 accept 与
 *   upgrade-insecure-requests），所以不能靠请求头认 iframe；webRequest 的 `resourceType` 才是可靠的；
 * - 主窗口之外的 session（内置浏览器的持久化分区）根本没有这个协议；
 * - 仓库只按 token 查，不读盘，所以不存在路径穿越面。
 */
import { randomBytes } from "node:crypto";
import { PANEL_FRAME_HOST, PANEL_FRAME_SCHEME } from "../../shared/plugin-panel.ts";

/**
 * 文档的 CSP。前五条是约定里的（不能联网、不能读文件、不能嵌别的框架：default-src 'none' 兜住
 * connect / frame / media / object / worker / manifest / prefetch 一切未列出的类型），后三条只收紧：
 * 表单不许提交、不许改 base、整份文档再套一层 sandbox（只留脚本）——iframe 属性之外的第二道。
 */
export const PANEL_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

/** 一份文档没被取走多久就作废。 */
export const PANEL_FRAME_TTL_MS = 60_000;
/** 同时放着多少份没取走的文档（renderer 反复开关面板时的上限，满了丢最旧的）。 */
const MAX_PENDING = 96;

export interface PanelFrameResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Pending {
  html: string;
  expiresAt: number;
}

export class PanelFrames {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** 放进一份模板，返回只能被取走一次的 iframe 地址。 */
  register(html: string): string {
    this.prune();
    const token = randomBytes(16).toString("hex");
    this.pending.set(token, { html, expiresAt: this.now() + PANEL_FRAME_TTL_MS });
    while (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) break;
      this.pending.delete(oldest.value);
    }
    return `${PANEL_FRAME_SCHEME}://${PANEL_FRAME_HOST}/${token}`;
  }

  /** 此刻还放着几份没被取走的（测试与诊断用）。 */
  size(): number {
    this.prune();
    return this.pending.size;
  }

  /**
   * 协议请求的应答：只按 token 查，只认 GET。请求类型 / 发起者的判定在它之前（webRequest），这里只管
   * token——一次性：取走就作废。非 GET 的请求不消耗 token（别处一次探测就能把真 iframe 的文档偷掉）。
   */
  respond(url: string, method = "GET"): PanelFrameResponse {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return plain(400, "bad request");
    }
    if (parsed.protocol !== `${PANEL_FRAME_SCHEME}:` || parsed.hostname !== PANEL_FRAME_HOST) return plain(404, "not found");
    if (method !== "GET") return plain(405, "method not allowed");
    const token = parsed.pathname.slice(1);
    this.prune();
    const doc = this.pending.get(token);
    if (doc === undefined) return plain(404, "not found");
    this.pending.delete(token);
    return {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": PANEL_FRAME_CSP,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
      body: doc.html,
    };
  }

  private prune(): void {
    const at = this.now();
    for (const [token, doc] of this.pending) {
      if (doc.expiresAt <= at) this.pending.delete(token);
    }
  }
}

function plain(status: number, body: string): PanelFrameResponse {
  return { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body };
}

/** webRequest 给出的、判定一次 `orbita-panel://` 请求要用的事实。 */
export interface PanelRequestInfo {
  /** Chromium 的请求类型：iframe 文档是 `subFrame`，顶层导航 `mainFrame`，其余 `script` / `xhr` / `image`… */
  resourceType: string;
  /** 发起这个请求的框架的父框架 URL；发起者就是主框架（没有父框架）为 null */
  parentUrl: string | null;
  /** 父框架自己还有没有父框架（= 请求来自嵌套两层以上的框架） */
  parentHasParent: boolean;
}

/**
 * 这次请求是不是「主窗口自己的 renderer 页面里的面板 iframe 在加载文档」：类型必须是 subFrame，发起框架的
 * 父框架必须是主框架（不许嵌套）且是我们自己的 renderer 页面。别的一律该取消。
 */
export function isPanelFrameLoad(info: PanelRequestInfo, isOwnPage: (url: string) => boolean): boolean {
  return info.resourceType === "subFrame" && info.parentUrl !== null && !info.parentHasParent && isOwnPage(info.parentUrl);
}

/** 主窗口子框架的导航闸（will-frame-navigate）：只放行面板协议——renderer 里除了面板 iframe 没有别的子框架。 */
export function isPanelFrameUrl(url: string): boolean {
  return url.startsWith(`${PANEL_FRAME_SCHEME}://${PANEL_FRAME_HOST}/`);
}
