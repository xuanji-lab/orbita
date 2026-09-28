/**
 * 页面上的 CDP 调用（Electron 内建的 `webContents.debugger`，不引第三方浏览器库）。
 * 读取（agent-requests.ts）与交互（interactions.ts）共用这一个入口：懒 attach、每条命令带超时——
 * 卡死的页面不能把 agent 的一轮拖死。
 */
import type { WebContents } from "electron";

const CDP_TIMEOUT_MS = 10_000;

/** 懒 attach 调试器；页面崩溃或被别的调试器抢走后下次调用自己重连。每条命令带超时 */
export async function cdp(contents: WebContents, method: string, params?: object): Promise<unknown> {
  const debuggerApi = contents.debugger;
  if (!debuggerApi.isAttached()) {
    try {
      debuggerApi.attach("1.3");
    } catch (cause) {
      throw new Error(`Could not inspect the page (${cause instanceof Error ? cause.message : String(cause)}).`);
    }
  }
  return withTimeout(debuggerApi.sendCommand(method, params), CDP_TIMEOUT_MS, "The page did not respond in time.");
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
