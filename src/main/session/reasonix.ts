/**
 * Reasonix 桌面版的会话 JSONL → pi Message 序列。读盘（只读）+ 转换两段，转换是纯函数。
 *
 * ## 源格式（2026-09-27 本机调研：projects/ 下 10 个项目 326 条真会话，304 MB）
 *
 * Reasonix 桌面版把会话按项目存 `<userData>/projects/<项目 slug>/sessions/<id>.jsonl`，
 * 一行一条 OpenAI Messages 风格的平面 JSON；旁边有 `<id>.jsonl.meta`（会话级元数据）。
 * 同目录的 `*.events.jsonl` / `*.turns.jsonl` 是它自己的派生物、`*.conflicts.jsonl` 是
 * 恢复冲突副本（不是会话），都不读。9-18 起的新会话写进 v5 库（desktop-sessions-v5/，
 * RX4F 二进制帧容器）——另立一刀，不在这里。
 *
 * - 行类型：system（运行时系统提示）/ user / assistant / tool（工具结果），另有不带 role 的
 *   分支记账行（branch_id / revision 之类）。system 与记账行跳过——pi 的 system prompt
 *   运行时自造，收别人的会跟自己的撞车。
 * - **content 是模型看到的**（带 `<reasoning-language>`、`<capability-route>` 等 host 包装的
 *   拼接字符串），**raw_content 是用户原文**。pi 消息收 content（保真：续聊时模型看到的
 *   上下文与当时一致），transcript 显示收 raw_content——opencode 的 synthetic 同款纪律。
 * - origin: "host" 的 user 行是宿主注入的上下文快照（没有原文），进 pi、不显示。
 * - thinking：一部分行是 thinking_blocks（`[{type, thinking, signature}]`），另一部分是
 *   reasoning_content + reasoning_signature——都转 pi 的 thinking 块，签名进 thinkingSignature
 *   （回原渠道有效、其他渠道无害，claude-legacy 同款）。
 * - tool_calls 是 OpenAI function 形（function.arguments 是 JSON 字符串）；tool 行按
 *   tool_call_id 配对，顺序即流序。
 * - **assistant 行没有时间戳**；user 行约 84% 带 createdAt（epoch ms）。pi 消息要时间戳：
 *   沿行序继承「最后见过的时间」，全会话一个都没有时由扫描层拿 meta 的时间兜底。
 * - usage 无处可寻（行上没有，meta 只有 totalCostUsd 这类会话级数）→ 全零，不造数字。
 * - UI 元数据不进 pi：workDurationMs、reasoning_state、decision_receipts（ask 工具的选项
 *   收据——对话流里已有它的 tool_call 与结果）、tool_execution / tool_run_state、read_result、
 *   memoryCitations、server_search。
 * - local_only 行（工具名 `__reasonix_local_only__`）没发给模型 → 跳过——进 pi 会替模型
 *   捏造它没见过的上下文。
 * - interrupted_turn 的空工具结果跳过，让配对审计补占位（auditToolPairs）。
 *
 * ## 转成 pi
 *
 * api 一律 openai-completions（DeepSeek 系走 OpenAI 兼容渠道，会话里没见过别的）。
 * 转换产出走 auditToolPairs 收尾：孤儿结果丢弃、悬空 toolCall 补合成占位。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import { isNotFound } from "../fs-errors.ts";
import { auditToolPairs, type ConvertedEntry } from "./tool-pairing.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** meta 的时间是 ISO 字符串；epoch ms 的数字也认（防御，字段在版本间换过形）。 */
function isoMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || value === "") return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** 没发给模型的本地工具的占位工具名（行上 local_only === true 与它同义，双保险）。 */
const LOCAL_ONLY_TOOL = "__reasonix_local_only__";

// ---------------------------------------------------------------------------
// 清单：projects/<项目>/sessions/*.jsonl 与 meta
// ---------------------------------------------------------------------------

/** meta 侧车里我们用得上的字段；缺 meta 或字段缺席时为 null（导入按缺省走）。 */
export interface ReasonixMeta {
  /** meta 里的会话 id（20260906-021150.…-deepseek-v4-flash 这种形） */
  id: string | null;
  /** topic_title：宿主起的会话标题 */
  title: string | null;
  model: string | null;
  /** 会话在哪个目录开的（工作区归属的原料） */
  workspaceRoot: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface ReasonixSessionFile {
  /** 会话主 JSONL 的绝对路径（幂等键，importedFrom 存它） */
  file: string;
  meta: ReasonixMeta | null;
  bytes: number;
}

/**
 * 会话目录里的一个文件名是不是我们要的真会话：主 JSONL（`<id>.jsonl`），排除它自己的
 * 派生物与恢复副本（events / turns / conflicts，后缀都挂在主名后面）。
 */
export function isReasonixConversationFile(name: string): boolean {
  return (
    name.endsWith(".jsonl") &&
    !name.endsWith(".events.jsonl") &&
    !name.endsWith(".turns.jsonl") &&
    !name.endsWith(".conflicts.jsonl")
  );
}

/** meta 的路径惯例：主文件名后缀 `.meta`（20260906-….jsonl.meta）。 */
export async function readReasonixMeta(file: string): Promise<ReasonixMeta | null> {
  let raw: string;
  try {
    raw = await readFile(`${file}.meta`, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return null;
  return {
    id: optionalString(parsed["id"]),
    title: optionalString(parsed["topic_title"]),
    model: optionalString(parsed["model"]),
    workspaceRoot: optionalString(parsed["workspace_root"]),
    createdAt: isoMs(parsed["created_at"]),
    updatedAt: isoMs(parsed["updated_at"]),
  };
}

/**
 * 列出迁移源里的全部会话文件（projects/<项目>/sessions/ 一层一层走）。根不在（没装
 * Reasonix）返回空；某个项目下没有 sessions/ 也跳过（记账上的缺，不值得拦整批）。
 * 文件多、meta 小，一个项目的文件串行读 meta 也够快；整体交给调用方的进度提示。
 */
export async function listReasonixSessions(projectsRoot: string): Promise<ReasonixSessionFile[]> {
  const out: ReasonixSessionFile[] = [];
  let projects: string[];
  try {
    projects = await readdir(projectsRoot);
  } catch (cause) {
    if (isNotFound(cause)) return out;
    throw cause;
  }
  for (const project of projects) {
    const sessionsDir = join(projectsRoot, project, "sessions");
    let names: string[];
    try {
      names = await readdir(sessionsDir);
    } catch (cause) {
      if (isNotFound(cause)) continue;
      throw cause;
    }
    for (const name of names) {
      if (!isReasonixConversationFile(name)) continue;
      const file = join(sessionsDir, name);
      let bytes = 0;
      try {
        bytes = (await stat(file)).size;
      } catch (cause) {
        if (isNotFound(cause)) continue;
        throw cause;
      }
      out.push({ file, meta: await readReasonixMeta(file), bytes });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 转换：OpenAI 扁平行 → pi Message
// ---------------------------------------------------------------------------

export interface ReasonixStats {
  /** 跳过的行：system、分支记账行、空 assistant 行 */
  skippedRows: number;
  /** 跳过的 local_only 工具结果（没发给模型的） */
  localOnlyResults: number;
  /** 跳过的被打断的空工具结果（交给审计补占位） */
  interruptedResults: number;
  orphanToolResults: number;
  patchedToolCalls: number;
}

export interface ReasonixParse {
  messages: Message[];
  /** 每条 user 消息在 transcript 里的原文（按 messages 里 user 消息的顺序）；null = 不显示 */
  userDisplays: (string | null)[];
  /** 第一句用户写的话（标题兜底） */
  firstPrompt: string | null;
  firstAt: number | null;
  lastAt: number | null;
  stats: ReasonixStats;
}

/** 一份会话 JSONL 的原文 → 行数组。坏行计数不拦整批（行间独立，坏一行好过丢全会话）。 */
export function parseReasonixRows(raw: string): { rows: unknown[]; badLines: number } {
  const rows: unknown[] = [];
  let badLines = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parsed = parseJson(trimmed);
    if (parsed === null) {
      badLines += 1;
      continue;
    }
    rows.push(parsed);
  }
  return { rows, badLines };
}

/** OpenAI 的 function.arguments 是 JSON 字符串；解析不出就整段塞进 raw 键，不静默丢。 */
function safeArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return isRecord(value) ? value : {};
  const trimmed = value.trim();
  if (trimmed === "") return {};
  const parsed = parseJson(trimmed);
  return isRecord(parsed) ? parsed : { raw: trimmed };
}

/**
 * 会话行 → pi Message。providerId 与 sessionModel 由调用方注入（模型映射与 meta 的结果，
 * 每条 assistant 消息都盖同一个章——源行上没有 per-message 模型）。
 */
export function reasonixToMessages(
  rows: readonly unknown[],
  providerId: string,
  sessionModel: string | null,
): ReasonixParse {
  const stats: ReasonixStats = { skippedRows: 0, localOnlyResults: 0, interruptedResults: 0, orphanToolResults: 0, patchedToolCalls: 0 };
  const entries: ConvertedEntry[] = [];
  /** 继承钟：assistant 没有时间戳，user 行的 createdAt 是唯一的钟；0 = 全会话都没给 */
  let clock = 0;

  for (const row of rows) {
    if (!isRecord(row)) {
      stats.skippedRows += 1;
      continue;
    }
    const role = row["role"];
    if (role !== "user" && role !== "assistant" && role !== "tool") {
      stats.skippedRows += 1; // system 行与不带 role 的分支记账行
      continue;
    }

    const createdAt = row["createdAt"];
    if (typeof createdAt === "number" && Number.isFinite(createdAt) && createdAt > 0) clock = createdAt;
    const timestamp = clock;

    if (role === "user") {
      const seen = typeof row["content"] === "string" ? row["content"] : null;
      const written = typeof row["raw_content"] === "string" ? row["raw_content"] : null;
      if ((seen === null || seen.trim() === "") && (written === null || written.trim() === "")) {
        stats.skippedRows += 1;
        continue;
      }
      const display =
        written !== null && written.trim() !== ""
          ? written
          : row["origin"] === "host"
            ? null
            : seen;
      entries.push({
        kind: "user",
        message: { role: "user", content: [{ type: "text", text: seen ?? written ?? "" }], timestamp },
        display: display !== null && display.trim() !== "" ? display : null,
      });
      continue;
    }

    if (role === "assistant") {
      const content: AssistantMessage["content"] = [];
      // thinking_blocks（新形，自带签名）优先；一条都没收着再退 reasoning_content + reasoning_signature
      const thinkingBlocks = row["thinking_blocks"];
      if (Array.isArray(thinkingBlocks)) {
        for (const block of thinkingBlocks) {
          if (!isRecord(block)) continue;
          const thinking = block["thinking"];
          if (typeof thinking !== "string" || thinking.trim() === "") continue;
          const signature = optionalString(block["signature"]);
          content.push(
            signature === null
              ? { type: "thinking", thinking }
              : { type: "thinking", thinking, thinkingSignature: signature },
          );
        }
      }
      if (content.length === 0) {
        const reasoning = row["reasoning_content"];
        if (typeof reasoning === "string" && reasoning.trim() !== "") {
          const signature = optionalString(row["reasoning_signature"]);
          content.push(
            signature === null
              ? { type: "thinking", thinking: reasoning }
              : { type: "thinking", thinking: reasoning, thinkingSignature: signature },
          );
        }
      }
      const text = row["content"];
      if (typeof text === "string" && text.trim() !== "") content.push({ type: "text", text });

      const calls: ToolCall[] = [];
      const listed = row["tool_calls"];
      if (Array.isArray(listed)) {
        for (const call of listed) {
          if (!isRecord(call) || !isRecord(call["function"])) continue;
          const id = optionalString(call["id"]);
          const name = optionalString(call["function"]["name"]);
          if (id === null || name === null) continue;
          calls.push({ type: "toolCall", id, name, arguments: safeArguments(call["function"]["arguments"]) });
        }
      }
      content.push(...calls);
      if (content.length === 0) {
        stats.skippedRows += 1; // 既没字也没思考也没调工具的空行
        continue;
      }
      entries.push({
        kind: "assistant",
        message: {
          role: "assistant",
          content,
          api: "openai-completions",
          provider: providerId,
          model: sessionModel ?? "unknown",
          usage: ZERO_USAGE,
          stopReason: row["interrupted_turn"] === true ? "aborted" : calls.length > 0 ? "toolUse" : "stop",
          timestamp,
        },
      });
      continue;
    }

    // tool 行：工具结果
    if (row["local_only"] === true || row["name"] === LOCAL_ONLY_TOOL) {
      stats.localOnlyResults += 1; // 没发给模型，不算对话
      continue;
    }
    const toolCallId = optionalString(row["tool_call_id"]);
    if (toolCallId === null) {
      stats.skippedRows += 1;
      continue;
    }
    const resultText = row["content"];
    const hasText = typeof resultText === "string" && resultText.trim() !== "";
    if (!hasText && row["interrupted_turn"] === true) {
      stats.interruptedResults += 1; // 空结果 + 被打断：审计会补占位
      continue;
    }
    const execution = isRecord(row["tool_execution"])
      ? row["tool_execution"]
      : isRecord(row["tool_run_state"])
        ? row["tool_run_state"]
        : null;
    const content: (TextContent | ImageContent)[] = [];
    if (hasText) content.push({ type: "text", text: resultText as string });
    entries.push({
      kind: "result",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: optionalString(row["name"]) ?? "unknown",
        content,
        isError: execution !== null && execution["state"] === "error",
        timestamp,
      },
    });
  }

  const audited = auditToolPairs(entries, "reasonix");
  stats.orphanToolResults = audited.orphanToolResults;
  stats.patchedToolCalls = audited.patchedToolCalls;
  return {
    messages: audited.messages,
    userDisplays: audited.userDisplays,
    firstPrompt: audited.firstPrompt,
    firstAt: audited.firstAt,
    lastAt: audited.lastAt,
    stats,
  };
}
