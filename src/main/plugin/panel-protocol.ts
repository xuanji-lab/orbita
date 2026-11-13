/**
 * `orbita-panel://` 协议在 Electron 里的装配（判定与应答的逻辑在 panel-frame.ts，可单测）。
 *
 * 两步分开，因为 Electron 要求不同时机：
 * - `registerPanelScheme()`：**必须在 app ready 之前**（模块顶层）。只给 `standard`（相对 URL、主机段按标准解析）
 *   与 `secure`（Chromium 只对「可信来源」发 `Sec-Fetch-Dest`，PanelFrames 靠它认 iframe 请求）；
 *   不给 supportFetchAPI / bypassCSP / corsEnabled / stream——文档不需要，也不该有。
 * - `installPanelProtocol()`：ready 之后在默认 session 上挂应答。内置浏览器用的是别的持久化分区，
 *   没有这个协议，网页里导航到 `orbita-panel://` 只会得到「未知协议」。
 */
import { protocol, session } from "electron";
import { PANEL_FRAME_SCHEME } from "../../shared/plugin-panel.ts";
import { isPanelFrameLoad, type PanelFrames } from "./panel-frame.ts";

export function registerPanelScheme(): void {
  // 只给 standard（相对 URL、主机段按标准解析）。不给 secure / supportFetchAPI / bypassCSP / corsEnabled / stream：
  // 文档不需要，也不该有
  protocol.registerSchemesAsPrivileged([{ scheme: PANEL_FRAME_SCHEME, privileges: { standard: true } }]);
}

/**
 * `isOwnPage`：这个 URL 是不是我们自己的 renderer 页面（index.ts 注入，与 will-navigate 闸同一份判定）。
 * 两道关：webRequest 在请求发出前按类型与发起者取消不该加载的（只放行主窗口 renderer 页面的直接子框架的
 * subFrame 请求）；处理器再按一次性 token 给文档。
 */
export function installPanelProtocol(frames: PanelFrames, isOwnPage: (url: string) => boolean): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: [`${PANEL_FRAME_SCHEME}://*/*`] }, (details, callback) => {
    const parent = details.frame?.parent ?? null;
    const allowed = isPanelFrameLoad(
      { resourceType: details.resourceType, parentUrl: parent === null ? null : parent.url, parentHasParent: parent?.parent != null },
      isOwnPage,
    );
    callback({ cancel: !allowed });
  });
  protocol.handle(PANEL_FRAME_SCHEME, (request) => {
    const reply = frames.respond(request.url, request.method);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  });
}
