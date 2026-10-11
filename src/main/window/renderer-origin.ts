/**
 * will-navigate 闸门的判定：「这个 URL 是不是我们自己的 renderer 页面」。**纯模块**
 * （不 import electron）：dev server 地址与打包 renderer 目录由调用方注入，node --test
 * 可直接测；真实环境值在 index.ts 装配。
 *
 * 为什么要这道闸（2026-10-10 安全加固）：把一个链接拖进窗口（text/uri-list）、或页面
 * 自己动 `location`，Chromium 的默认行为是把**整个窗口导航过去**——preload 跟着
 * WebContents 走，落地页就带着我们全部的 IPC 面。renderer 侧 main.tsx 只拦了带文件的
 * 拖拽（file://），链接拖拽没人管，所以判定必须放在主进程。
 *
 * 放行范围恰好是 loadRendererPage 会装的那两页的来源：dev 下 ELECTRON_RENDERER_URL
 * 同源（reload / HMR 全量刷新也走这条，不能拦）；打包下 `out/renderer` 目录内的
 * `file://`。同文档锚点（`#…`）不触发 will-navigate，无需另判。
 */
import { fileURLToPath } from "node:url";
import { isAbsolute, relative } from "node:path";

/** 路径算法。默认随平台（node:path），测试注入 win32 保持可移植——同 agent-policy.ts 的先例 */
export interface RendererOriginPathApi {
  relative: (from: string, to: string) => string;
}

export interface RendererOriginDeps {
  /** dev server 地址（未打包时的 ELECTRON_RENDERER_URL）；打包产物是 undefined */
  devServerUrl: string | undefined;
  /** 打包产物里 renderer 的目录（`out/renderer`）；dev 下不用 */
  rendererDir: string;
  path?: RendererOriginPathApi;
}

export function isOwnRendererPage(url: string, deps: RendererOriginDeps): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (deps.devServerUrl !== undefined) {
    let own: URL;
    try {
      own = new URL(deps.devServerUrl);
    } catch {
      return false;
    }
    return parsed.origin === own.origin;
  }
  if (parsed.protocol !== "file:") return false;
  const path = deps.path ?? { relative };
  const rel = path.relative(deps.rendererDir, fileURLToPath(parsed));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
