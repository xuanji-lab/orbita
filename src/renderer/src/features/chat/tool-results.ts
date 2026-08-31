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
import type { SessionRecord } from "@shared/session";

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
 * 这一条记录该不该在主列表里单独占一行。
 *
 * tool item 一律不占——它已经被 `indexToolResults` 挂到对应的调用行上了。
 * **代价写明白**：万一某条 tool 结果找不到对应的调用（协议上不该发生，
 * 因为结果必然由一次调用产生），它就不会被显示。宁可如此，也不要为了兜这个
 * 不存在的情形，让正常路径多出一行冗余。
 */
export function isStandaloneItem(item: SessionRecord): boolean {
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

/**
 * 折叠行上工具名右边的参数摘要：`bash · git status`、`edit · src/app.ts`。
 * 字段名按 pi 工具 schema 的真名（bash→command，路径类→path，搜索类→pattern）；
 * 不认识的工具、input 不是对象、字段缺失或不是字符串，一律返回 null——
 * 摘要缺了不碍事，编造才碍事。
 */
export function toolCallSummary(toolName: string, input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  switch (toolName) {
    case "bash":
      return str("command");
    case "read":
    case "write":
    case "edit":
      return str("path");
    case "grep":
    case "find":
    case "glob": {
      const pattern = str("pattern");
      if (pattern === null) return null;
      const path = str("path");
      return path === null || path === "." ? pattern : `${pattern} in ${path}`;
    }
    case "ls":
      return str("path") ?? ".";
    default:
      return null;
  }
}

/** diff 行的四种角色：增 / 删 / 头与块标记 / 上下文 */
export type DiffLineKind = "add" | "del" | "meta" | "ctx";

/**
 * unified diff 一行的角色。`@@` 块头与 `diff --git`、`---`、`+++` 文件头归 meta；
 * 只看前缀不看内容——diff 的渲染是给它上色，不是给它解析语义。
 */
export function diffLineKind(line: string): DiffLineKind {
  if (
    line.startsWith("@@") ||
    line.startsWith("diff --git") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ")
  ) {
    return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/**
 * edit 落在 details 里的 diff（上一刀才带上来的，pi 算好的现成货）。
 * 不是 edit、没有 details、diff 不是非空字符串，都返回 null——调用方退回原文展示。
 */
export function editDiffText(result: ToolTranscriptItem): string | null {
  if (result.toolName !== "edit") return null;
  const details = result.details;
  if (typeof details !== "object" || details === null) return null;
  const diff = (details as Record<string, unknown>)["diff"];
  return typeof diff === "string" && diff !== "" ? diff : null;
}
