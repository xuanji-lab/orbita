/**
 * 截图的取帧：主路 CDP `Page.captureScreenshot`，挂住时换 Electron 原生 `capturePage()` 补拍一次
 * （agent-requests.ts 的 screenshot / zoom 共用）。
 *
 * 为什么需要补路：captureScreenshot 要等页面合成器交出一帧。个别状态下页面活着——
 * `Runtime.evaluate`（browser_extract）照常秒回、导航照常完成——却等不来新帧：线上同一 tab 曾
 * 连续 15 次各超时 10 秒（2026-10-09 会话），模型原样重试白烧了 7 分钟。对策三层：
 *   1. 拍前强制出帧：关后台节流（幂等，视图建时已关过，防的是弹窗子窗口等别的构造路径）+
 *      `invalidate()` 请求重绘；
 *   2. 主路超时换补路：`capturePage()` 走 Electron 自己的拷贝路径，失败面不同（未显示过的窗口
 *      会立刻报错而不是挂住——正好把「挂 10 秒」变成「马上知道不行」）；
 *   3. 两条路都不行：抛 `shotStallMessage()` 的说法——说清这页暂时截不到、不是命令用错、
 *      别原样重试、改用 browser_extract / browser_observe 读页面。
 * 不用「把窗口弹到前面」换出帧：agent 在后台用浏览器是常态（sandbox.ts），弹出会抢用户的屏幕。
 */
import type { WebContents } from "electron";
import { CdpTimeoutError, cdp, withTimeout } from "./cdp.ts";

/** 补路超时：capturePage 没有 deadline，给它一个短的——两次都挂时这一轮总共别超过 ~18 秒 */
const FALLBACK_TIMEOUT_MS = 8_000;

/** 主路超时且补路也没拍出来时，给模型的完整说法（不是命令用错、别重试、换读取工具） */
export function shotStallMessage(): string {
  return (
    "This page cannot be captured right now: it is not producing a new frame, so the screenshot timed out. " +
    "This is a state of the page or its window, not a mistake in your command — calling browser_screenshot again " +
    "the same way will keep failing. Read the page with browser_extract or browser_observe instead. " +
    "Capturing usually works again after the user opens the built-in browser (globe icon) and shows this tab."
  );
}

/**
 * 整页截图取一帧：主路 CDP → 超时换 capturePage 补拍。回 PNG buffer；页面还没画出过东西（空 data）回 null，
 * 由调用方按「还没渲染」处理。主路非超时的错误（页面崩了、调试器装不上）补路也救不了的场景原样抛。
 */
export async function captureFrame(contents: WebContents): Promise<Buffer | null> {
  try {
    return await cdpShot(contents, { format: "png" });
  } catch (cause) {
    const fallback = await capturePageFallback(contents);
    if (fallback !== null) return fallback;
    // 超时说明页面不出帧：说清楚不是命令用错、别重试、换读取工具；其它错误（页面崩了、
    // 调试器装不上）保留原样，那才是要告诉模型的真原因
    throw cause instanceof CdpTimeoutError ? new Error(shotStallMessage()) : cause;
  }
}

/**
 * 局部放大取一帧：只走主路（补路 capturePage 拍的是整个视图，裁不出等价的 clip）。
 * 超时抛截不到的说法，其余错误原样抛。
 */
export async function captureRegion(
  contents: WebContents,
  clip: { x: number; y: number; width: number; height: number; scale: number },
): Promise<Buffer | null> {
  try {
    return await cdpShot(contents, { format: "png", clip });
  } catch (cause) {
    throw cause instanceof CdpTimeoutError ? new Error(shotStallMessage()) : cause;
  }
}

async function cdpShot(contents: WebContents, params: object): Promise<Buffer | null> {
  forceFrame(contents);
  const shot = (await cdp(contents, "Page.captureScreenshot", params)) as { data?: unknown };
  return typeof shot.data === "string" ? Buffer.from(shot.data, "base64") : null;
}

/** 主路失败后的补拍：再逼一帧，用 capturePage 换条路；成功回 PNG，不行回 null（换说法由调用方决定） */
async function capturePageFallback(contents: WebContents): Promise<Buffer | null> {
  forceFrame(contents);
  const image = await withTimeout(contents.capturePage(), FALLBACK_TIMEOUT_MS, "capturePage did not respond in time.").catch(
    () => null,
  );
  if (image === null || image.isEmpty()) return null;
  return image.toPNG();
}

function forceFrame(contents: WebContents): void {
  // try：视图可能恰在这时被关掉——那让后续的 cdp 调用去报真错误，这里不抢
  try {
    contents.setBackgroundThrottling(false);
  } catch {
    // 见上
  }
  try {
    contents.invalidate();
  } catch {
    // 见上
  }
}
