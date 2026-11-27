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
 * 「在右栏打开插件的看板」的请求（对话里看板结果右上角的「在插件里打开」、状态卡里点子会话做的看板）：
 * 右栏插件页画的是插件**现在**的数据，不是对话里那次的快照。已装的插件进它的看板视图，草稿进草稿的长页。
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

/**
 * 「滚回对话里那次看板结果并原地展开」的请求（状态卡里的看板缩略图点击）：对话里每次 show_plugin_board 的结果
 * 是一条带 toolCallId 的行，状态卡与对话隔着整棵树，同样走 window 事件。
 *
 * 处理方是对应会话的对话列（`sessionId` 对得上才接，右栏辅助对话不会误接）：行在已加载的窗口里（虚拟化卸下的也算）
 * 就滚过去、展开；不在（会话分页，更早的轮次还没翻出来）就由它退回 `requestOpenPluginBoard`，所以请求里带上插件名与草稿路径。
 */
const REVEAL_BOARD_EVENT = "orbita:reveal-board";

export interface RevealBoardRequest extends PluginBoardOpenRequest {
  sessionId: string;
  toolCallId: string;
}

export function requestRevealBoard(request: RevealBoardRequest): void {
  window.dispatchEvent(new CustomEvent<RevealBoardRequest>(REVEAL_BOARD_EVENT, { detail: request }));
}

export function onRevealBoardRequest(handler: (request: RevealBoardRequest) => void): () => void {
  const listener = (event: Event): void => {
    handler((event as CustomEvent<RevealBoardRequest>).detail);
  };
  window.addEventListener(REVEAL_BOARD_EVENT, listener);
  return () => window.removeEventListener(REVEAL_BOARD_EVENT, listener);
}
