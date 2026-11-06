import type { OpenDocument } from "@shared/quote";

/**
 * 右栏正开着编辑的那份文档（模块级一格）。编辑面板挂载时登记、卸载时清掉；发送消息时
 * `useChatSession.send` 读它，拼成正文开头的 `<open_document …/>`——模型因此知道
 * 「在第二段后面加一段」说的是哪份文件。
 *
 * 为什么不是 context / props：写的一方（文件预览里的编辑面板）与读的一方（输入框的发送）
 * 隔着整棵 App，中间没有共同祖先该管这件事；它是「此刻用户眼前有什么」这种瞬时事实，
 * 不是任何组件的状态。
 */
let current: OpenDocument | null = null;

export function setOpenDocument(doc: OpenDocument | null): void {
  current = doc;
}

export function getOpenDocument(): OpenDocument | null {
  return current;
}
