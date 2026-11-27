/**
 * 内嵌交互图的 contextBridge 面 —— 四层契约的第 3 层（契约在 shared/chat-embed.ts）。
 * 回答里的 ```html-embed 围栏：包好的文档换一个一次性 iframe 地址（每次挂 iframe 都要重新换）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ChatEmbedFrameRequest, ChatEmbedFrameResult } from "../../shared/chat-embed.ts";

export const chatEmbedApi = {
  /** 文档 → `orbita-panel://doc/<token>`；空串 / 超过 HTML_EMBED_MAX_BYTES 回 null */
  frame: (request: ChatEmbedFrameRequest): Promise<ChatEmbedFrameResult> => ipcRenderer.invoke(ipcChannels.chatEmbedFrame, request),
};
