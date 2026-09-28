/**
 * opencode 的会话 → pi Message 序列。读库（只读打开）+ 转换两段，转换是纯函数。
 *
 * ## 源格式（2026-09-25 本机库：237 条会话，其中 167 条是子会话；3710 条消息，14881 个 part）
 *
 * 库在 `~/.local/share/opencode/opencode.db`（SQLite，WAL）。只用三张表：
 * - `session`：id、parent_id（子会话：task 工具派出去的子 agent，母会话的工具结果已含它的产出，
 *   不导，同 Claude Code 的子代理）、directory（在哪个目录开的）、title（默认
 *   「New session - <ISO 时间>」，算没有标题）、time_created / time_updated、revert（撤回点）。
 * - `message`：一行一条消息，data 是 JSON：role、time.created；assistant 另有 providerID /
 *   modelID、error（MessageAbortedError = 用户打断）、summary（true = 压缩摘要）。
 * - `part`：消息的内容，data 是 JSON，按 id 排序即产生顺序：
 *   - user：text（synthetic = opencode 替用户插的，如读文件的结果；ignored = 不发给模型）、
 *     file（data: URL 的图 / PDF，file:// 的文本文件——后者 opencode 已另插 synthetic 文字）、
 *     compaction（这条是「压缩」请求，不是用户写的话）。
 *   - assistant：step-start / step-finish（一个 step 的边界，finish 带 reason 与 tokens）、
 *     reasoning、text、tool（callID、tool、state：completed 带 output 与 attachments、error 带
 *     error、running = 被打断）、patch（文件快照，不进对话）。
 *
 * ## 转成 pi
 *
 * - 一条 assistant 消息按 step 拆：每个 step 一条 pi assistant（思考、文字、toolCall），后面跟
 *   这个 step 里各工具的结果——与 opencode 发给模型时的拆法一致。
 * - api：anthropic 的记 anthropic-messages，思考带回 metadata.anthropic.signature；其余记
 *   openai-completions。usage 按 step-finish 的 tokens 换算（input / output / cache.read / cache.write）。
 * - 压缩：保留全部历史；摘要消息（summary: true）落成 pi 的 compaction entry，位置就是它在源里
 *   的位置——transcript 在那里出一条可展开的压缩界碑（摘要全文），续聊时模型看到的是「摘要 +
 *   压缩之后的消息」，与 opencode 压缩后发给模型的一致。此前摘要整条丢弃（对账：本机 2 条会话
 *   丢 5 段摘要，opencode 里看得到）。压缩请求（user 消息里的 compaction part）不是用户写的话，
 *   仍不导。tokensBefore 取摘要那一步 step-finish 的输入 token（摘要是读着整段上下文写的）。
 * - 撤回（session.revert）：撤回点之后的消息不导；带 partID 的，那条消息从这个 part 起截掉。
 * - 用户消息在 transcript 里的原文：非 synthetic 的文字；只有 synthetic 文字的消息为 null（进 pi、
 *   不显示）。插件（oh-my-opencode 等）插进来却没标 synthetic 的文字按内容认：以
 *   `<system-reminder>`（后台任务完成通知等）、`[SYSTEM DIRECTIVE:`（待办续跑）、`[xxx-mode]` /
 *   `<xxx-mode>`（关键词触发的模式说明）开头的整段不显示；用户自己的话后面挂的
 *   `<system-reminder>…</system-reminder>` 剥掉。本机 367 段用户文字里这类 116 段。
 *   附件里的图进 pi，其余类型（PDF 等）pi 没有对应块，丢弃。
 */
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, ImageContent, Message, TextContent, ToolCall, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { auditToolPairs, type ConvertedCompaction, type ConvertedEntry } from "./tool-pairing.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 读库
// ---------------------------------------------------------------------------

/** 一条根会话（子会话不列）。 */
export interface OpencodeSessionRow {
  id: string;
  directory: string | null;
  /** 默认标题（「New session - …」）已换成 null */
  title: string | null;
  createdAt: number;
  updatedAt: number;
  /** session.revert 原文（JSON 或 null） */
  revert: string | null;
}

/** 会话里的一条消息：data 原文与它的 part（按 id 排好）。 */
export interface OpencodeMessageRow {
  id: string;
  data: string;
  parts: { id: string; data: string }[];
}

/** opencode 新建会话时的默认标题：「New session - 2026-01-17T07:10:22.607Z」。 */
const DEFAULT_TITLE = /^New session - \d{4}-\d{2}-\d{2}T/;

/**
 * 只读打开 opencode 的库做一件事，做完就关。库不在、打不开（格式不认识、被锁）一律抛，
 * 由调用方决定怎么报。
 */
export function withOpencodeDb<T>(dbPath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readOpencodeSessions(db: DatabaseSync): OpencodeSessionRow[] {
  const rows = db
    .prepare(
      "select id, directory, title, time_created, time_updated, revert from session where parent_id is null order by time_created, id",
    )
    .all();
  return rows.flatMap((row) => {
    const id = text(row["id"]);
    if (id === null) return [];
    const title = text(row["title"]);
    return [
      {
        id,
        directory: optionalString(row["directory"]),
        title: title === null || title.trim() === "" || DEFAULT_TITLE.test(title) ? null : title,
        createdAt: num(row["time_created"]),
        updatedAt: num(row["time_updated"]),
        revert: text(row["revert"]),
      },
    ];
  });
}

/** 一条会话的全部消息与 part（part 按 id 排即产生顺序）。 */
export function readOpencodeMessages(db: DatabaseSync, sessionId: string): OpencodeMessageRow[] {
  const messages = db.prepare("select id, data from message where session_id = ? order by time_created, id").all(sessionId);
  const parts = db.prepare("select id, message_id, data from part where session_id = ? order by message_id, id").all(sessionId);
  const byMessage = new Map<string, { id: string; data: string }[]>();
  for (const part of parts) {
    const id = text(part["id"]);
    const messageId = text(part["message_id"]);
    const data = text(part["data"]);
    if (id === null || messageId === null || data === null) continue;
    const list = byMessage.get(messageId);
    if (list === undefined) byMessage.set(messageId, [{ id, data }]);
    else list.push({ id, data });
  }
  return messages.flatMap((row) => {
    const id = text(row["id"]);
    const data = text(row["data"]);
    return id === null || data === null ? [] : [{ id, data, parts: byMessage.get(id) ?? [] }];
  });
}

/** 一条会话在库里的体量（消息与 part 的 JSON 长度之和）：页面「大约复制多少」用。 */
export function opencodeSessionBytes(db: DatabaseSync, sessionId: string): number {
  const sum = (table: string): number =>
    num(db.prepare(`select sum(length(data)) as total from ${table} where session_id = ?`).get(sessionId)?.["total"]);
  return sum("message") + sum("part");
}

// ---------------------------------------------------------------------------
// 转换
// ---------------------------------------------------------------------------

export interface OpencodeStats {
  /** pi 没有对应块、丢掉的附件（PDF 等） */
  droppedFiles: number;
  /** 不导的压缩请求与摘要 */
  compactionMessages: number;
  /** 撤回点之后丢掉的消息 */
  revertedMessages: number;
  orphanToolResults: number;
  patchedToolCalls: number;
}

export interface OpencodeParse {
  messages: Message[];
  /** 源里的压缩摘要及其在 messages 里的位置（落 pi 时插 compaction entry） */
  compactions: ConvertedCompaction[];
  /** 每条 user 消息在 transcript 里的原文（按 messages 里 user 消息的顺序）；null = 不显示 */
  userDisplays: (string | null)[];
  /** 最后一条 assistant 的模型 id */
  model: string | null;
  firstPrompt: string | null;
  firstAt: number | null;
  lastAt: number | null;
  stats: OpencodeStats;
}

/** 插件插进用户消息、没标 synthetic 的整段文字（见文件头）。 */
const GENERATED_PART = /^\s*(?:<system-reminder>|\[SYSTEM DIRECTIVE:|\[[a-z]+(?:-[a-z]+)*-mode\]|<[a-z]+(?:-[a-z]+)*-mode>)/;
const TRAILING_REMINDER = /\s*<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;

/** 一段非 synthetic 的用户文字在 transcript 里的样子；整段是插件插的返回 null。 */
export function opencodeUserText(text: string): string | null {
  if (GENERATED_PART.test(text)) return null;
  const cleaned = text.replace(TRAILING_REMINDER, "").trim();
  return cleaned === "" ? null : cleaned;
}

/** data: URL 的图 → pi 图片块；别的（PDF、file:// 文本）返回 null。 */
function toImage(part: Record<string, unknown>): ImageContent | null {
  const url = optionalString(part["url"]);
  const match = url === null ? null : /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(url);
  return match === null ? null : { type: "image", data: match[2]!, mimeType: match[1]! };
}

function toUsage(tokens: unknown): Usage {
  const source = isRecord(tokens) ? tokens : {};
  const cache = isRecord(source["cache"]) ? source["cache"] : {};
  const input = num(source["input"]);
  const output = num(source["output"]);
  const cacheRead = num(cache["read"]);
  const cacheWrite = num(cache["write"]);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

interface Step {
  content: AssistantMessage["content"];
  tools: Record<string, unknown>[];
  finish: Record<string, unknown> | null;
}

/**
 * 撤回点：`{ messageID, partID? }`。返回截掉之后的消息（带 partID 的那条从这个 part 起截掉，
 * 截完没内容了整条不要）。
 */
function applyRevert(rows: readonly OpencodeMessageRow[], revert: string | null): { rows: OpencodeMessageRow[]; dropped: number } {
  const point = revert === null ? null : parseJson(revert);
  const messageId = optionalString(point?.["messageID"]);
  const index = messageId === null ? -1 : rows.findIndex((row) => row.id === messageId);
  if (index === -1) return { rows: [...rows], dropped: 0 };
  const partId = optionalString(point?.["partID"]);
  const kept = rows.slice(0, index);
  const target = rows[index]!;
  const cut = partId === null ? -1 : target.parts.findIndex((part) => part.id === partId);
  if (cut > 0) kept.push({ ...target, parts: target.parts.slice(0, cut) });
  return { rows: kept, dropped: rows.length - kept.length };
}

/** 一条会话的消息 → pi Message。providerId 由调用方注入（模型映射的结果）。 */
export function opencodeToMessages(
  source: readonly OpencodeMessageRow[],
  providerId: string,
  revert: string | null,
): OpencodeParse {
  const stats: OpencodeStats = { droppedFiles: 0, compactionMessages: 0, revertedMessages: 0, orphanToolResults: 0, patchedToolCalls: 0 };
  const { rows, dropped } = applyRevert(source, revert);
  stats.revertedMessages = dropped;
  const entries: ConvertedEntry[] = [];
  let model: string | null = null;

  for (const row of rows) {
    const info = parseJson(row.data);
    if (info === null) continue;
    const time = isRecord(info["time"]) ? num(info["time"]["created"]) : 0;
    const parts = row.parts.flatMap((part) => {
      const parsed = parseJson(part.data);
      return parsed === null ? [] : [parsed];
    });

    if (info["role"] === "user") {
      if (parts.some((part) => part["type"] === "compaction")) {
        stats.compactionMessages += 1;
        continue;
      }
      const content: (TextContent | ImageContent)[] = [];
      const written: string[] = [];
      for (const part of parts) {
        if (part["type"] === "text" && typeof part["text"] === "string" && part["ignored"] !== true) {
          if (part["text"] === "") continue;
          content.push({ type: "text", text: part["text"] });
          const shown = part["synthetic"] === true ? null : opencodeUserText(part["text"]);
          if (shown !== null) written.push(shown);
        } else if (part["type"] === "file") {
          const image = toImage(part);
          if (image !== null) content.push(image);
          // file:// 的文本文件：opencode 已把内容另插成 synthetic 文字，这里不算丢
          else if (!String(part["url"]).startsWith("file://")) stats.droppedFiles += 1;
        }
      }
      if (content.length === 0) continue;
      entries.push({ kind: "user", message: { role: "user", content, timestamp: time }, display: written.length === 0 ? null : written.join("\n") });
      continue;
    }

    if (info["role"] !== "assistant") continue;
    if (info["summary"] === true) {
      stats.compactionMessages += 1;
      const summary = parts
        .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
        .map((part) => String(part["text"]))
        .join("\n")
        .trim();
      if (summary !== "") {
        const finish = [...parts].reverse().find((part) => part["type"] === "step-finish");
        const usage = toUsage(finish?.["tokens"]);
        entries.push({ kind: "compaction", summary, tokensBefore: usage.input + usage.cacheRead + usage.cacheWrite, timestamp: time });
      }
      continue;
    }
    // ZCode 的 message.data 用小写 d 的 providerId/modelId（opencode 是大写 D，两家的库
    // 同源不同代）——两个拼写都认，zcode 来源直接喂同一台转换器
    const modelId = optionalString(info["modelID"]) ?? optionalString(info["modelId"]);
    if (modelId !== null) model = modelId;
    const anthropic = info["providerID"] === "anthropic" || info["providerId"] === "anthropic";
    const error = isRecord(info["error"]) ? info["error"] : null;

    // 按 step 拆：step-start 开新的，step-finish 收尾；step-start 之前的 part（旧版没有 step）归第一个
    const steps: Step[] = [];
    let current: Step | null = null;
    const ensure = (): Step => {
      if (current === null) {
        current = { content: [], tools: [], finish: null };
        steps.push(current);
      }
      return current;
    };
    for (const part of parts) {
      const type = part["type"];
      if (type === "step-start") {
        current = null;
        ensure();
      } else if (type === "step-finish") {
        ensure().finish = part;
        current = null;
      } else if (type === "reasoning" && typeof part["text"] === "string" && part["text"].trim() !== "") {
        const metadata = isRecord(part["metadata"]) ? part["metadata"] : null;
        const signature = anthropic && isRecord(metadata?.["anthropic"]) ? optionalString(metadata["anthropic"]["signature"]) : null;
        ensure().content.push(
          signature === null ? { type: "thinking", thinking: part["text"] } : { type: "thinking", thinking: part["text"], thinkingSignature: signature },
        );
      } else if (type === "text" && typeof part["text"] === "string" && part["text"].trim() !== "" && part["ignored"] !== true) {
        ensure().content.push({ type: "text", text: part["text"] });
      } else if (type === "tool") {
        const callId = optionalString(part["callID"]);
        const name = optionalString(part["tool"]);
        if (callId === null || name === null) continue;
        const state = isRecord(part["state"]) ? part["state"] : {};
        const call: ToolCall = { type: "toolCall", id: callId, name, arguments: isRecord(state["input"]) ? state["input"] : {} };
        const step = ensure();
        step.content.push(call);
        step.tools.push(part);
      }
    }

    steps.forEach((step, index) => {
      if (step.content.length === 0) return;
      const last = index === steps.length - 1;
      const reason = step.finish?.["reason"];
      const hasCalls = step.tools.length > 0;
      let stopReason: AssistantMessage["stopReason"] =
        reason === "tool-calls" ? "toolUse" : reason === "length" ? "length" : reason === "error" ? "error" : hasCalls ? "toolUse" : "stop";
      if (last && step.finish === null && error !== null) stopReason = error["name"] === "MessageAbortedError" ? "aborted" : "error";
      const errorMessage =
        last && error !== null && stopReason === "error"
          ? (optionalString(isRecord(error["data"]) ? error["data"]["message"] : null) ?? optionalString(error["name"]))
          : null;
      entries.push({
        kind: "assistant",
        message: {
          role: "assistant",
          content: step.content,
          api: anthropic ? "anthropic-messages" : "openai-completions",
          provider: providerId,
          model: modelId ?? "unknown",
          usage: toUsage(step.finish?.["tokens"]),
          stopReason,
          ...(errorMessage === null ? null : { errorMessage }),
          timestamp: time,
        },
      });
      for (const part of step.tools) {
        const state = isRecord(part["state"]) ? part["state"] : {};
        const status = state["status"];
        if (status !== "completed" && status !== "error") continue;
        const content: (TextContent | ImageContent)[] = [];
        if (status === "completed") {
          const output = text(state["output"]);
          if (output !== null && output !== "") content.push({ type: "text", text: output });
          for (const attachment of Array.isArray(state["attachments"]) ? state["attachments"] : []) {
            const image = isRecord(attachment) ? toImage(attachment) : null;
            if (image !== null) content.push(image);
            else stats.droppedFiles += 1;
          }
        } else {
          content.push({ type: "text", text: text(state["error"]) ?? "error" });
        }
        const times = isRecord(state["time"]) ? state["time"] : {};
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: optionalString(part["callID"]) ?? "",
          toolName: optionalString(part["tool"]) ?? "unknown",
          content,
          isError: status === "error",
          timestamp: num(times["end"]) || time,
        };
        entries.push({ kind: "result", message: result });
      }
    });
  }

  const audited = auditToolPairs(entries, "opencode");
  stats.orphanToolResults = audited.orphanToolResults;
  stats.patchedToolCalls = audited.patchedToolCalls;
  return {
    messages: audited.messages,
    compactions: audited.compactions,
    userDisplays: audited.userDisplays,
    model,
    firstPrompt: audited.firstPrompt,
    firstAt: audited.firstAt,
    lastAt: audited.lastAt,
    stats,
  };
}
