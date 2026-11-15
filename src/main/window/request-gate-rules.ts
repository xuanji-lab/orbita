/**
 * 合并请求闸的判定部分（不碰 Electron，可单测；装配在 request-gate.ts）。
 *
 * 一个监听管几个协议：过滤式只列这几个协议（别的请求根本不进来），进来的按 URL 的协议找到那一道闸，
 * 交给它自己的判定（插件面板：panel-frame.ts 的 isPanelFrameLoad；PDF 阅读器：pdf-reader/gate.ts）。
 * 找不到闸的一律取消——不会因为合并而多放行任何东西。
 */

/** 判定一次请求要用的事实（从 webRequest 的 details 里取） */
export interface GateRequestInfo {
  url: string;
  /** Chromium 的请求类型：iframe 文档是 `subFrame`，顶层导航 `mainFrame`，其余 `script` / `xhr` / `image`… */
  resourceType: string;
  /** 发起请求的框架（subFrame 请求里是被加载的那个 iframe 本身）的 URL；没有框架（worker 等）为 null */
  frameUrl: string | null;
  /** 该框架的父框架 URL；没有父框架为 null */
  parentUrl: string | null;
  /** 父框架自己还有没有父框架 */
  parentHasParent: boolean;
  /** 父框架的父框架 URL（三层嵌套的阅读器要看到它） */
  grandparentUrl: string | null;
  referrer: string;
}

export interface RequestGate {
  /** 这道闸管的协议名，如 `orbita-panel`；webRequest 的过滤式由它派生 */
  scheme: string;
  allow: (info: GateRequestInfo) => boolean;
}

/** webRequest 给的 details 里我们用到的那一小块（Electron 的 WebFrameMain 结构上满足它） */
export interface GateFrame {
  url: string;
  parent: GateFrame | null;
}
export interface GateDetails {
  url: string;
  resourceType: string;
  referrer: string;
  frame?: GateFrame | null;
}

export function gateInfo(details: GateDetails): GateRequestInfo {
  const frame = details.frame ?? null;
  const parent = frame?.parent ?? null;
  const grandparent = parent?.parent ?? null;
  return {
    url: details.url,
    resourceType: details.resourceType,
    frameUrl: frame === null ? null : frame.url,
    parentUrl: parent === null ? null : parent.url,
    parentHasParent: grandparent !== null,
    grandparentUrl: grandparent === null ? null : grandparent.url,
    referrer: details.referrer,
  };
}

/** webRequest 的过滤式：只列这几个协议 */
export function gateFilter(gates: readonly RequestGate[]): { urls: string[] } {
  return { urls: gates.map((gate) => `${gate.scheme}://*/*`) };
}

/** 该不该取消：按协议找闸，找不到就取消 */
export function shouldCancel(gates: readonly RequestGate[], details: GateDetails): boolean {
  const gate = gates.find((each) => details.url.startsWith(`${each.scheme}:`));
  return gate === undefined || !gate.allow(gateInfo(details));
}
