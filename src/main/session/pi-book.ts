/**
 * pi 会话本子（JSONL，header version 3）的只读解析 —— 纯模块：不 import electron 与 pi，
 * `node --test` 直接测。
 *
 * 主进程只有一件事要读 pi 本子：把别家工具（Proma 与 pi 同构）留在磁盘上的会话投影成
 * read_task 用的 SessionRecord[]。此前借 pi-coding-agent 的 `parseSessionEntries` /
 * `migrateSessionEntries` / `SessionManager.inMemory` 做，主进程为此加载整个 coding-agent；
 * 本子格式 v3 已冻结（pi 0.84 → 1.5 未变），这里自己读，换内核时主进程不随之改。
 *
 * 规则与 pi 对齐（对照测试见 pi-book.test.ts，拿 testdata 的三份真实本子逐条比）：
 *
 * - 坏行跳过（pi 的 parseSessionEntries 同款），一条坏行不炸整份。
 * - 版本迁移在内存里做：v1 补 id / parentId 链（pi 用随机 id，这里按行号铸稳定 id——只读投影
 *   不写回，稳定 id 让同一份文件两次读出同样的记录）；v2 → v3 把 hookMessage 角色改名 custom。
 * - 版本比 3 新的拒读：未来格式硬解可能错，宁可如实报错。
 * - 当前分支 = 从最后一条沿 parentId 走到根再反转（pi 的 buildSessionPath，未导出）。
 */
import type { Message, Usage } from "@earendil-works/pi-ai";
import type { AssistantTranscriptItem, ToolTranscriptItem, TranscriptItem } from "../../shared/transcript.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { isEmptyErrorAssistantEntry } from "../../agent/branch-cut.ts";
import type { ConvertedCompaction } from "./tool-pairing.ts";
import { withUserTexts } from "./proma-user-text.ts";

/** 本子能读到的最高版本（pi 的 CURRENT_SESSION_VERSION，v3 格式冻结）。 */
export const PI_BOOK_VERSION = 3;

/**
 * 本子里除 header 外的一条 entry。只声明投影用得到的字段，其余按未知输入防御。
 * pi 的 SessionEntry 结构化满足它（导入器在退场前仍传 pi 的类型进来）。
 */
export interface PiBookEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  /** type = "message"：pi-ai 的 Message（按未知输入读） */
  message?: unknown;
  /** type = "compaction" */
  summary?: unknown;
  tokensBefore?: unknown;
}

export interface PiBookHeader {
  version: number;
  id: string | null;
  cwd: string;
  /** header 的创建时刻；解析不了为 0 */
  timestamp: number;
}

export interface PiBook {
  header: PiBookHeader;
  /** 文件顺序，不含 header；已迁到 v3 */
  entries: PiBookEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 解一份本子。没有 header、版本超前抛错（调用方带上来源与文件路径如实报）；其余坏行跳过。
 */
export function parsePiBook(raw: string): PiBook {
  const lines: Record<string, unknown>[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) lines.push(parsed);
    } catch {
      // 坏行跳过（pi 同款）
    }
  }
  const head = lines.find((line) => line["type"] === "session");
  if (head === undefined) throw new Error("no session header");
  const version = optionalNumber(head["version"]) ?? 1;
  if (version > PI_BOOK_VERSION) {
    throw new Error(`session version ${version} is newer than supported (${PI_BOOK_VERSION})`);
  }
  const body = lines.filter((line) => line !== head && typeof line["type"] === "string");
  if (version < 2) {
    // v1 → v2：补 id 与线性 parentId 链；compaction 的 firstKeptEntryIndex 投影用不到，不换算
    let previous: string | null = null;
    body.forEach((line, index) => {
      const id = `v1-${index}`;
      line["id"] = id;
      line["parentId"] = previous;
      previous = id;
    });
  }
  if (version < 3) {
    for (const line of body) {
      const message = line["message"];
      if (line["type"] === "message" && isRecord(message) && message["role"] === "hookMessage") message["role"] = "custom";
    }
  }
  const entries: PiBookEntry[] = [];
  for (const line of body) {
    const id = optionalString(line["id"]);
    if (id === null) continue;
    entries.push({
      ...line,
      type: line["type"] as string,
      id,
      parentId: optionalString(line["parentId"]),
      timestamp: typeof line["timestamp"] === "string" ? line["timestamp"] : "",
    });
  }
  const created = Date.parse(typeof head["timestamp"] === "string" ? head["timestamp"] : "");
  return {
    header: {
      version,
      id: optionalString(head["id"]),
      cwd: typeof head["cwd"] === "string" ? head["cwd"] : "",
      timestamp: Number.isNaN(created) ? 0 : created,
    },
    entries,
  };
}

/**
 * 会话当前分支上的全部 entry，按时间顺序：从文件最后一条沿 parentId 走到根再反转——与 pi
 * 自己的 buildSessionPath 同一条规则（它没导出）。回退重答留下的旧枝不在路径上，与源应用
 * 界面显示的一致。
 *
 * **不用 pi 的 buildContextEntries**：那是发给模型的上下文，压缩过的会话只留压缩点之后的条目；
 * 这里要的是给人看的全量历史（早先导入用了前者，本机 17 条压缩过的会话丢了约 141 条用户消息）。
 *
 * 成环（只可能来自手改的文件）走到重复节点即停，不无限展开。
 */
export function branchEntries<E extends PiBookEntry>(entries: readonly E[]): E[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: E[] = [];
  const seen = new Set<string>();
  let current = entries[entries.length - 1];
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}

type UserContent = Extract<TranscriptItem, { role: "user" }>["content"][number];
type AssistantContent = AssistantTranscriptItem["content"][number];
type ToolContent = ToolTranscriptItem["content"][number];

function messageTimestamp(entry: PiBookEntry, message: Record<string, unknown>): number {
  const ts = optionalNumber(message["timestamp"]);
  if (ts !== null) return ts;
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** 未知形状（未来 pi 版本的新内容类型）原样丢弃，不猜——坏一条好过错一条。 */
function toUserBlocks(content: unknown): UserContent[] {
  const blocks: UserContent[] = [];
  if (typeof content === "string") {
    if (content !== "") blocks.push({ type: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      blocks.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "image" && typeof block["data"] === "string" && typeof block["mimeType"] === "string") {
      blocks.push({ type: "image", data: block["data"], mimeType: block["mimeType"] });
    }
  }
  return blocks;
}

function toAssistantBlocks(content: unknown): AssistantContent[] {
  const blocks: AssistantContent[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      blocks.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
      const redacted = block["redacted"];
      blocks.push(
        typeof redacted === "boolean"
          ? { type: "thinking", thinking: block["thinking"], redacted }
          : { type: "thinking", thinking: block["thinking"] },
      );
    } else if (block["type"] === "toolCall" && typeof block["id"] === "string" && typeof block["name"] === "string") {
      blocks.push({
        type: "toolCall",
        toolCallId: block["id"],
        toolName: block["name"],
        // 入参本来就是模型产出的 JSON（pi-ai 上游声明 Record<string, any>），
        // 与 transcript-adapter 的 toAssistantContent 同一个形合点
        input: block["arguments"] as Extract<AssistantContent, { type: "toolCall" }>["input"],
      });
    }
  }
  return blocks;
}

function toToolBlocks(content: unknown): ToolContent[] {
  const blocks: ToolContent[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      blocks.push({ type: "text", text: block["text"] });
    } else if (block["type"] === "image" && typeof block["data"] === "string" && typeof block["mimeType"] === "string") {
      blocks.push({ type: "image", data: block["data"], mimeType: block["mimeType"] });
    }
  }
  return blocks;
}

/**
 * assistant 条目的完整构造（含终态判定），与 transcript-adapter 的 finalAssistantItem
 * 同一套规则：error/aborted 各自成态；协议只认 length/toolUse 两个 stopReason，其余落 "stop"。
 */
function assistantRecord(entry: PiBookEntry, message: Record<string, unknown>, timestamp: number): AssistantTranscriptItem {
  const usage = message["usage"];
  const base = {
    id: entry.id,
    role: "assistant" as const,
    content: toAssistantBlocks(message["content"]),
    model: {
      provider: optionalString(message["provider"]) ?? "unknown",
      id: optionalString(message["model"]) ?? "unknown",
    },
    ...(isRecord(usage) ? { usage: usage as unknown as Usage } : null),
    timestamp,
  };
  const stopReason = message["stopReason"];
  if (stopReason === "error") return { ...base, status: "error" as const, stopReason: "error" as const };
  if (stopReason === "aborted") return { ...base, status: "aborted" as const, stopReason: "aborted" as const };
  // pi 的 StopReason 比协议宽（还有 pending / deferred）；只有 length / toolUse 协议认，
  // 其余落回 "stop"——它表示「就这么结束了」，是最不失真的兜底
  if (stopReason === "length" || stopReason === "toolUse") return { ...base, status: "complete" as const, stopReason };
  return { ...base, status: "complete" as const, stopReason: "stop" as const };
}

/** 从 assistant 消息的 content 里收 toolCallId → 入参（文件顺序保证先于对应 toolResult）。 */
function collectToolInputs(content: unknown, into: Map<string, unknown>): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || block["type"] !== "toolCall") continue;
    const id = optionalString(block["id"]);
    if (id !== null) into.set(id, block["arguments"]);
  }
}

/**
 * 当前分支的 entry 列表（branchEntries）→ orbita 的 SessionRecord[]。
 *
 * - message：user / assistant / toolResult 翻译成 TranscriptItem；**空 error 回答不进**
 *   （isEmptyErrorAssistantEntry——与落盘侧、分支对账侧同一个谓词）。
 * - compaction → CompactedRecord 界碑，落在它在历史里的原位。
 * - model_change / thinking_level_change / custom / label / session_info / branch_summary 不进：
 *   transcript 是渲染投影，不是发给模型的上下文。
 *
 * toolResult 的 input 从**全局前文**的 toolCall 块里按 toolCallId 找；找不到（孤儿结果）落 {}。
 */
export function entriesToRecords(entries: readonly PiBookEntry[]): SessionRecord[] {
  const records: SessionRecord[] = [];
  const toolInputs = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry.type === "compaction") {
      records.push({
        role: "compacted",
        id: entry.id,
        summary: typeof entry.summary === "string" ? entry.summary : "",
        tokensBefore: optionalNumber(entry.tokensBefore) ?? 0,
        timestamp: Date.parse(entry.timestamp) || 0,
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const message = isRecord(entry.message) ? entry.message : null;
    if (message === null) continue;
    if (isEmptyErrorAssistantEntry({ type: entry.type, id: entry.id, message })) continue;
    const role = message["role"];
    const timestamp = messageTimestamp(entry, message);
    if (role === "user") {
      records.push({ id: entry.id, role: "user", content: toUserBlocks(message["content"]), timestamp });
      continue;
    }
    if (role === "assistant") {
      collectToolInputs(message["content"], toolInputs);
      records.push(assistantRecord(entry, message, timestamp));
      continue;
    }
    if (role === "toolResult") {
      const toolCallId = optionalString(message["toolCallId"]) ?? "";
      records.push({
        id: entry.id,
        role: "tool",
        toolCallId,
        toolName: optionalString(message["toolName"]) ?? "unknown",
        input: (toolInputs.get(toolCallId) ?? {}) as ToolTranscriptItem["input"],
        content: toToolBlocks(message["content"]),
        timestamp,
        ...(message["isError"] === true
          ? { status: "error" as const, isError: true }
          : { status: "complete" as const, isError: false }),
      });
      continue;
    }
    // 未来 pi 版本的新 role：跳过（同未知块策略）
  }
  return records;
}

/**
 * 转换类来源（Claude Code、Codex、Kimi……）解析出的 Message[] → read_task 的记录，全在内存里。
 * 等价于此前「SessionManager.inMemory + appendMessage 逐条灌入 → branchEntries → entriesToRecords」：
 * 一条直链，id 按顺序铸（`m<序号>` / `c<序号>`，同一份源两次读出同样的 id）。
 *
 * userDisplays：每条 user 消息在 transcript 里的原文（按 messages 里 user 消息的顺序）；null =
 * 模型读到、用户没写（注入的上下文），这条用户记录不出现。compactions：源里的压缩，在第 at 条
 * 消息之前落一块界碑。
 */
export function messagesToRecords(
  messages: readonly Message[],
  userDisplays: readonly (string | null)[],
  compactions: readonly ConvertedCompaction[] = [],
): SessionRecord[] {
  const entries: PiBookEntry[] = [];
  const hidden = new Set<string>();
  const texts = new Map<string, string>();
  let parentId: string | null = null;
  let userIndex = 0;
  let compactionIndex = 0;
  const append = (entry: Omit<PiBookEntry, "parentId">): void => {
    entries.push({ ...entry, parentId });
    parentId = entry.id;
  };
  const compactBefore = (index: number): void => {
    for (const compaction of compactions) {
      if (compaction.at !== index) continue;
      const at = compaction.timestamp > 0 ? compaction.timestamp : Date.now();
      append({
        type: "compaction",
        id: `c${compactionIndex}`,
        timestamp: new Date(at).toISOString(),
        summary: compaction.summary,
        tokensBefore: compaction.tokensBefore,
      });
      compactionIndex += 1;
    }
  };
  messages.forEach((message, index) => {
    compactBefore(index);
    const id = `m${index}`;
    const at = optionalNumber((message as { timestamp?: unknown }).timestamp) ?? Date.now();
    append({ type: "message", id, timestamp: new Date(at).toISOString(), message });
    if (message.role !== "user") return;
    const display = userDisplays[userIndex] ?? null;
    userIndex += 1;
    if (display === null) hidden.add(id);
    else texts.set(id, display);
  });
  compactBefore(messages.length);
  const records = entriesToRecords(entries).filter((record) => record.role !== "user" || !hidden.has(record.id));
  return withUserTexts(records, texts);
}
