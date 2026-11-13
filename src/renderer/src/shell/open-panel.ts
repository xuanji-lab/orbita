import type { OpenPanelHint } from "../../../shared/builtin-command.ts";

/**
 * 「在右栏打开某个文件」的请求总线（内置命令的完成卡点击、agent 新建 / 打开时自动开面板，共用这一条）。
 *
 * 发请求的（聊天里的卡、自动开面板钩子）与处理的（App：切面板、把路径交给面板）隔着整棵树，
 * 中间没有共同祖先该管这件事，所以走 window 事件——同 `setOpenDocument` 的取舍：这是瞬时动作，不是状态。
 */
const EVENT = "orbita:open-panel";

export function requestOpenPanel(hint: OpenPanelHint): void {
  window.dispatchEvent(new CustomEvent<OpenPanelHint>(EVENT, { detail: hint }));
}

/** 订阅请求；返回取消函数 */
export function onOpenPanelRequest(handler: (hint: OpenPanelHint) => void): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<OpenPanelHint>).detail);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
