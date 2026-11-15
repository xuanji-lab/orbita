/**
 * 默认 session 上自定义协议的请求闸（webRequest.onBeforeRequest）与特权登记，几个协议合在一处装
 * （判定在 request-gate-rules.ts，可单测）。
 *
 * 为什么必须合：Electron 的 `webRequest.onBeforeRequest` 一个 session 只认一个监听——文档原话
 * 「Only the last attached `listener` will be used」（electron/electron docs/api/web-request.md）；
 * `protocol.registerSchemesAsPrivileged` 文档写明「can be called only once」（docs/api/protocol.md），
 * 所有协议的特权必须在一次调用里登记。插件面板（orbita-panel://）与 PDF 阅读器（orbita-reader://）若各装各的，
 * 后装的那个会把前一个的闸静默拆掉——插件面板的请求就不再过任何判定。
 */
import { protocol, session, type CustomScheme } from "electron";
import { gateFilter, shouldCancel, type RequestGate } from "./request-gate-rules.ts";

/** 一次装齐（只装在默认 session 上：内置浏览器用的是别的持久化分区，那里根本没有这两个协议） */
export function installRequestGates(gates: readonly RequestGate[]): void {
  session.defaultSession.webRequest.onBeforeRequest(gateFilter(gates), (details, callback) => {
    callback({ cancel: shouldCancel(gates, details) });
  });
}

/** 模块顶层（app ready 之前）调一次，把所有自定义协议的特权一起登记 */
export function registerPrivilegedSchemes(schemes: readonly CustomScheme[]): void {
  protocol.registerSchemesAsPrivileged([...schemes]);
}
