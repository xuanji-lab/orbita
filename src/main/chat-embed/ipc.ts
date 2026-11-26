/**
 * 内嵌交互图的 IPC —— 四层契约的第 2 层（契约在 shared/chat-embed.ts）。
 * `chat:embed-frame`：renderer 包好的 HTML 文档 → 一次性 iframe 地址。文档放进看板卡同一个内存仓库
 * （plugin/panel-frame.ts：一次性 token、60 秒过期、CSP 走响应头），主进程不读盘、不解析内容。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { PanelFrames } from "../plugin/panel-frame.ts";
import { chatEmbedFrameOf } from "./embed-frame.ts";

export function registerChatEmbedIpc(frames: Pick<PanelFrames, "register">): void {
  ipcMain.handle(ipcChannels.chatEmbedFrame, (_e, raw: unknown) => chatEmbedFrameOf(frames, raw));
}
