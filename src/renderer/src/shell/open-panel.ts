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

/** 「在右栏看进度」的请求（对话里开头那张计划卡的按钮）：App 收到后切到「这条任务 › 进度」 */
const PROGRESS_EVENT = "orbita:open-progress";

export function requestOpenProgress(): void {
  window.dispatchEvent(new Event(PROGRESS_EVENT));
}

export function onOpenProgressRequest(handler: () => void): () => void {
  window.addEventListener(PROGRESS_EVENT, handler);
  return () => window.removeEventListener(PROGRESS_EVENT, handler);
}

/**
 * 「在右栏看完整的插件看板」的请求（对话里看板结果底部的「展开」）：对话里的看板限高约半屏，
 * 完整的在右栏的插件页里看。已装的插件进它的看板视图，草稿进草稿的长页。
 */
const PLUGIN_BOARD_EVENT = "orbita:open-plugin-board";

export interface PluginBoardOpenRequest {
  plugin: string;
  /** 草稿的真实路径；已装的插件为 null */
  draftPath: string | null;
}

export function requestOpenPluginBoard(request: PluginBoardOpenRequest): void {
  window.dispatchEvent(new CustomEvent<PluginBoardOpenRequest>(PLUGIN_BOARD_EVENT, { detail: request }));
}

export function onOpenPluginBoardRequest(handler: (request: PluginBoardOpenRequest) => void): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<PluginBoardOpenRequest>).detail);
  };
  window.addEventListener(PLUGIN_BOARD_EVENT, listener);
  return () => window.removeEventListener(PLUGIN_BOARD_EVENT, listener);
}
