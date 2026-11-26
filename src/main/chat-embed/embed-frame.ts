/**
 * `chat:embed-frame` 的纯处理（不碰 Electron，`node --test` 直接加载；装配在 ipc.ts）：入参不合规回 null，
 * 否则把文档登记进看板卡同一个一次性仓库（plugin/panel-frame.ts）换地址。
 */
import { chatEmbedHtmlOf, type ChatEmbedFrameResult } from "../../shared/chat-embed.ts";
import type { PanelFrames } from "../plugin/panel-frame.ts";

export function chatEmbedFrameOf(frames: Pick<PanelFrames, "register">, raw: unknown): ChatEmbedFrameResult {
  const html = chatEmbedHtmlOf(raw);
  return html === null ? null : { frameUrl: frames.register(html) };
}
