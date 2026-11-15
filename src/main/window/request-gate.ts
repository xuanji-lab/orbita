/**
 * 默认 session 上自定义协议的请求闸（webRequest.onBeforeRequest）与特权登记，几个协议合在一处装。
 *
 * 为什么要合：Electron 每个 session 的 `webRequest.onBeforeRequest` **只能有一个监听**（后装的顶掉先装的），
 * `protocol.registerSchemesAsPrivileged` 也只认最后一次调用。插件面板（orbita-panel://）与 PDF 阅读器
 * （orbita-reader://）各装各的，后装的那个会把前一个的闸静默拆掉。
 */
import { protocol, session, type CustomScheme, type OnBeforeRequestListenerDetails } from "electron";

/** 判定一次请求要用的事实（从 webRequest 的 details 里取，可单测） */
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
  /** 这道闸管的 URL 前缀，如 `orbita-panel://`；webRequest 的过滤式由它派生 */
  scheme: string;
  allow: (info: GateRequestInfo) => boolean;
}

export function gateInfo(details: OnBeforeRequestListenerDetails): GateRequestInfo {
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

/** 一次装齐：按 URL 的协议分派到各自的闸；不归任何闸管的请求不会进来（过滤式只列这几个协议） */
export function installRequestGates(gates: readonly RequestGate[]): void {
  session.defaultSession.webRequest.onBeforeRequest({ urls: gates.map((gate) => `${gate.scheme}://*/*`) }, (details, callback) => {
    const gate = gates.find((each) => details.url.startsWith(`${each.scheme}:`));
    callback({ cancel: gate === undefined || !gate.allow(gateInfo(details)) });
  });
}

/** 模块顶层（app ready 之前）调一次，把所有自定义协议的特权一起登记 */
export function registerPrivilegedSchemes(schemes: readonly CustomScheme[]): void {
  protocol.registerSchemesAsPrivileged([...schemes]);
}
