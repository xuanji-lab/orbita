/**
 * 工具结果的归位：把 transcript 里独立的 tool item 挂回它对应的那次工具调用。
 *
 * **为什么要归位。** 协议里工具调用与工具结果是两条独立的记录：
 * 调用是 assistant 消息里的一个 `toolCall` 块，结果是一条 `role: "tool"` 的 item。
 * 照原样渲染就会得到两行——「调用了 ls」和「ls 的结果」——而设计系统要的是
 * 「工具调用折叠成一行、**点击才展开**」（readme *Chat*）。所以结果不单独占一行，
 * 它是那次调用展开后的内容。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载。
 */
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";

/** toolCallId → 那次调用的结果。同一个 id 出现多次时以最后一条为准（终态帧在增量帧之后）。 */
export type ToolResultIndex = ReadonlyMap<string, ToolTranscriptItem>;

export function indexToolResults(transcript: readonly TranscriptItem[]): ToolResultIndex {
  const index = new Map<string, ToolTranscriptItem>();
  for (const item of transcript) {
    if (item.role === "tool") index.set(item.toolCallId, item);
  }
  return index;
}

/**
 * 这一条 item 该不该在主列表里单独占一行。
 *
 * tool item 一律不占——它已经被 `indexToolResults` 挂到对应的调用行上了。
 * **代价写明白**：万一某条 tool 结果找不到对应的调用（协议上不该发生，
 * 因为结果必然由一次调用产生），它就不会被显示。宁可如此，也不要为了兜这个
 * 不存在的情形，让正常路径多出一行冗余。
 */
export function isStandaloneItem(item: TranscriptItem): boolean {
  return item.role !== "tool";
}

/** 折叠态那一行右侧的摘要：让人不展开也能大致知道发生了什么。 */
export function summarizeToolResult(result: ToolTranscriptItem | undefined): string | null {
  if (result === undefined) return null;
  if (result.status === "running") return "running";
  if (result.status === "error") return "failed";
  const text = result.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n")
    .trim();
  if (text === "") return "no output";
  const lines = text.split("\n").length;
  return lines > 1 ? `${lines} lines` : `${text.length} chars`;
}

/** 展开后要显示的正文。图片暂不渲染，只标记它存在——真正的图片渲染是后面的事。 */
export function toolResultText(result: ToolTranscriptItem): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : `[image ${block.mimeType}]`))
    .join("\n");
}
