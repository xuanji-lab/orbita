/**
 * 整段复制的纯计算（L3d）：从已加载的记录拼纯文本、判断 Ctrl/Cmd+A 该不该接管。
 *
 * 历史段虚拟化只挂载视口附近的行（跨页拖选拿不到 DOM），所以「整段复制」不能靠
 * 浏览器全选，而是从数据源拼文本写剪贴板。这个模块不依赖 React / DOM，
 * `node --test` 可以直接加载；DOM 侧的选区判定与剪贴板写入留在 ChatView。
 */
import type { TranscriptRecord } from "@shared/session";

/**
 * 纯文本口径：按记录顺序取 user 与 assistant 的 **text 块**，块间与记录间都用空行
 * 分隔。工具结果、thinking、压缩摘要、通道标记、轮尾文件账都不是「对话正文」，
 * 不进剪贴板（大工具输出尤其不该被整段复制带上）。空白块不占段，整段为空返回 ""。
 *
 * 与「复制回答」（tool-results.ts 的 answerText）同一口径，只是这里连 user 一起收。
 */
export function transcriptCopyText(records: readonly TranscriptRecord[]): string {
  const parts: string[] = [];
  for (const record of records) {
    if (record.role !== "user" && record.role !== "assistant") continue;
    for (const block of record.content) {
      if (block.type !== "text") continue;
      if (block.text.trim() === "") continue;
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

/** 一次全选按键里判定会用到的字段（KeyboardEvent 的子集，测试直接造字面量） */
export interface SelectAllKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * 焦点快照。`inTranscript` 由调用方算：**焦点元素或当前选区**落在转录容器内即为真
 * （点正文后焦点常落在 body，只看 activeElement 会漏掉「选区在转录里」这一种）。
 */
export interface SelectAllFocus {
  tagName: string;
  isContentEditable: boolean;
  inTranscript: boolean;
}

/**
 * Ctrl/Cmd+A 是否该由「整段复制」接管。
 *
 * - 只认 A、Ctrl 或 Cmd 至少一个，Alt / Shift 一律不抢（组合键各有各的语义）；
 * - 焦点在 INPUT / TEXTAREA / contentEditable 里不接管——输入框里的 Ctrl+A 仍是
 *   全选输入框（composer 是 contentEditable）；
 * - 焦点与选区都不在转录里不接管（右栏、设置页、其它面板的正常全选不受影响）。
 */
export function shouldInterceptSelectAll(
  event: SelectAllKeyEvent,
  focus: SelectAllFocus | null,
): boolean {
  if (event.key.toLowerCase() !== "a") return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  if (event.altKey || event.shiftKey) return false;
  if (focus === null) return false;
  const tag = focus.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || focus.isContentEditable) return false;
  return focus.inTranscript;
}
