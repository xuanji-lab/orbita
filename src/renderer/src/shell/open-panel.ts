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

/**
 * 文件面板的「打开这个文件」请求此刻还算不算数（2026-11-23 用户：「我每次点文件面板，他都要出现这个 handoff 文件，
 * 即使我关了，离开文件面板，再次来文件面板，也还是记忆这刚写的」）。
 *
 * 请求（focus.fileOpen，token 自增）发出后一直挂在 App 的 state 里；文件面板每次重挂，它记「已处理」的 ref 归零，
 * 旧请求就被重放一遍。请求的效力只到「那一次面板打开」为止：面板一离开 files，App 记下当时的 token（dismissed），
 * 之后这条请求不再交给面板；新请求 token 不同，照常生效。与 citeFocus 的「面板离开即作废」同一条纪律。
 */
export function liveFileOpen<T extends { token: number }>(request: T | null, dismissedToken: number | null): T | null {
  return request !== null && request.token !== dismissedToken ? request : null;
}
