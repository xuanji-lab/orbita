/**
 * 页面上的 CDP 调用（Electron 内建的 `webContents.debugger`，不引第三方浏览器库）。
 * 读取（agent-requests.ts）与交互（interactions.ts）共用这一个入口：懒 attach、每条命令带超时——
 * 卡死的页面不能把 agent 的一轮拖死。
 */
import type { WebContents } from "electron";

const CDP_TIMEOUT_MS = 10_000;

/**
 * cdp 命令超时。单独一个类型：截图路径（frame-capture.ts）要认出它来换补拍路径、
 * 换给模型的说法——其它错误（页面崩了、调试器装不上）照原样抛。
 */
export class CdpTimeoutError extends Error {}

/**
 * 懒 attach 调试器。attach 后页面崩溃或被别的调试器抢走，下次调用自己重连。
 * 失败给一句能读的话——截图路径要认出它来换补拍路径（frame-capture.ts）。
 */
export function ensureDebugger(contents: WebContents): void {
  const debuggerApi = contents.debugger;
  if (debuggerApi.isAttached()) return;
  try {
    debuggerApi.attach("1.3");
  } catch (cause) {
    throw new Error(`Could not inspect the page (${cause instanceof Error ? cause.message : String(cause)}).`);
  }
}

/** 懒 attach 调试器；每条命令带超时 */
export async function cdp(contents: WebContents, method: string, params?: object): Promise<unknown> {
  ensureDebugger(contents);
  return withTimeout(contents.debugger.sendCommand(method, params), CDP_TIMEOUT_MS, "The page did not respond in time.", CdpTimeoutError);
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  ErrorCtor: new (message: string) => Error = Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ErrorCtor(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
