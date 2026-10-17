/** 距底多少像素内仍算「在底部」：流式渲染的亚像素抖动不该把用户踢出跟随态 */
export const BOTTOM_THRESHOLD_PX = 40;

/**
 * 距底超过多少像素算「脱离底部」：一键回底浮钮的出现阈值（Telegram 同款 300px，
 * 2026-09-27 grill 定案）。跟随恢复仍走 BOTTOM_THRESHOLD_PX——40~300px 之间是
 * 「按钮不出现、跟随也已让位」的中间带，避免轻轻一滚按钮就闪现。
 */
export const SCROLL_DOWN_THRESHOLD_PX = 300;

/**
 * 是否贴着底部。视口在底（scrollTop + viewportHeight 不小于 scrollHeight - threshold）
 * 即真——内容不足一屏时恒为真（无处可滚，等价于在底部）。
 */
export function isAtBottom(
  scrollTop: number,
  viewportHeight: number,
  scrollHeight: number,
  threshold: number = BOTTOM_THRESHOLD_PX,
): boolean {
  return scrollTop + viewportHeight >= scrollHeight - threshold;
}

/** 距底距离（scrollHeight - scrollTop - clientHeight）够不够远、该不该浮现回底按钮 */
export function isBeyondScrollDown(
  distancePx: number,
  threshold: number = SCROLL_DOWN_THRESHOLD_PX,
): boolean {
  return distancePx > threshold;
}

/**
 * 触顶阈值（源侧分页）：距顶多少像素内就去拉更早的一页。
 *
 * 200px ≈ 一屏的四分之一：不必等到 scrollTop 恰好为 0——真到 0 时顶部已经露出一段
 * 空白，而请求要过 IPC + 一段渲染才回来。提前发出去，落地时人往往还在往上滚。
 */
export const OLDER_TRIGGER_PX = 200;

/** 滚到顶附近了就拉更早的一页（触发回执的防重、幂等由调用方负责） */
export function shouldLoadOlder(scrollTop: number, threshold: number = OLDER_TRIGGER_PX): boolean {
  return scrollTop <= threshold;
}

/**
 * End 键是否归「一键回底」管：非 End 键、带修饰键（组合键各有各的语义，不抢）、
 * 焦点在文本框里（INPUT / TEXTAREA / contentEditable——composer 里 End 是行尾光标）
 * 都不接管。
 */
export function shouldJumpToEnd(
  key: string,
  modifiers: { ctrl: boolean; meta: boolean; alt: boolean; shift: boolean },
  target: { tagName: string; isContentEditable: boolean },
): boolean {
  if (key !== "End") return false;
  if (modifiers.ctrl || modifiers.meta || modifiers.alt || modifiers.shift) return false;
  const tag = target.tagName.toUpperCase();
  return tag !== "INPUT" && tag !== "TEXTAREA" && !target.isContentEditable;
}
