/**
 * Kimi Code（~/.kimi-code）的会话 → pi Message 序列 —— 纯模块，`node --test` 直接测。
 *
 * ## 源格式（2026-09-25 本机 3 个会话 + kimi 1.x 程序里的读取逻辑）
 *
 * 会话目录 `sessions/<工作区 id>/<会话 id>/`：state.json 是元数据（标题、cwd、时间），对话在
 * `agents/main/wire.jsonl`（其余 agents/<id> 是子 agent，主对话的工具结果已含它们的产出，不导）。
 * wire 是事件流，一行一条记录，只有下面这些与对话有关：
 *
 * - `context.append_message`：一条 user 消息，`origin.kind` 区分用户写的（user）与模型读到、
 *   用户没写的（injection 日期 / 权限提醒、skill_activation 技能正文、task 后台任务通知）。
 * - `context.append_loop_event`：助手侧事件。`step.begin` → 若干 `content.part`（think / text）
 *   与 `tool.call` → `step.end`（finishReason、usage）。一个 step 就是一条 assistant 消息；
 *   `tool.result` 按 toolCallId 对应，可能早于 step.end 到达。
 * - `llm.request`：模型 id（`model`，如 k3）。
 * - `context.undo {count}`：撤回最近 count 个用户回合（回合锚点 = 用户写的消息，含用户敲的
 *   /技能；注入不算）。撤回不能越过 clear / 压缩。
 * - `agent.switched {branch, base: {branch, line}, legacyUndoLine}`：新版本的撤回写成分支——
 *   活动链 = 基线分支到 base.line 为止 + 新分支自 switched 那行之后。与它配对的 context.undo
 *   （legacyUndoLine 指向的那行）是写给旧版本读的，按分支读时跳过，`context.undone` 同样跳过。
 * - `context.clear` / `context.apply_compaction`：Kimi 之后只给模型看这之后的（或摘要）。
 *   **导入保留全部历史**（迁移的是聊天记录；与 Claude Code 压缩的处理一致），续聊时 pi 自己
 *   按窗口压缩。它们只作为撤回的下限。
 *
 * ## 转成 pi
 *
 * - assistant：api `openai-completions`（Kimi 走 OpenAI 兼容协议）；think 块落 thinking，
 *   `reasoningKey`（reasoning_content）落 thinkingSignature——pi 的 openai-completions 按它把
 *   思考发回原字段。usage：inputOther→input、inputCacheRead→cacheRead、
 *   inputCacheCreation→cacheWrite。
 * - 工具结果里的图是 `blobref:<mime>;<sha256>`，本体在 `agents/main/blobs/<sha256>`（原始字节）。
 *   调用方先用 kimiBlobRefs 列出引用、读成 base64 传进来；读不到的换一行文字说明。
 * - 配对审计（tool-pairing.ts，与 opencode 共用）：孤儿结果丢弃，悬空的 toolCall 在下一条
 *   user / assistant / 文件尾前补合成结果（续聊时 API 要求严格配对）。
 * - 用户消息在 transcript 里的原文：用户写的原样；用户敲的 /技能 写成「/名字 参数」；
 *   其余（注入、技能正文、任务通知）为 null——pi 副本里照留，transcript 不显示。
 */
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { auditToolPairs } from "./tool-pairing.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** 时间：新版是毫秒数，旧版 state.json 是 ISO 字符串。 */
function toTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// state.json
// ---------------------------------------------------------------------------

export interface KimiSessionState {
  /** Kimi 显示的标题；新建未命名的「New Session」算没有 */
  title: string | null;
  cwd: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** 读不懂返回 null（这条会话按没有元数据处理，标题与时间从对话里取）。 */
export function parseKimiSessionState(raw: string): KimiSessionState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const title = optionalString(parsed["title"]);
  return {
    title: title === null || (title === "New Session" && parsed["isCustomTitle"] !== true) ? null : title,
    cwd: optionalString(parsed["cwd"]),
    createdAt: toTime(parsed["createdAt"]),
    updatedAt: toTime(parsed["updatedAt"]),
  };
}

// ---------------------------------------------------------------------------
// wire.jsonl
// ---------------------------------------------------------------------------

/** 工具结果与用户消息里引用的图：`blobref:<mime>;<sha256>`。 */
const BLOB_REF = /^blobref:([\w.+-]+\/[\w.+-]+);([0-9a-f]{64})$/;
const BLOB_REF_GLOBAL = /blobref:[\w.+-]+\/[\w.+-]+;([0-9a-f]{64})/g;

/** wire 里引用到的 blob（sha256，去重）。调用方按它读 `agents/main/blobs/<sha256>`。 */
export function kimiBlobRefs(raw: string): string[] {
  return [...new Set([...raw.matchAll(BLOB_REF_GLOBAL)].map((match) => match[1]!))];
}

export interface KimiWireStats {
  /** 孤儿 tool.result 丢弃数 */
  orphanToolResults: number;
  /** 悬空 toolCall 补合成结果数 */
  patchedToolCalls: number;
  /** 读不到本体、换成文字说明的图 */
  missingImages: number;
  /** 撤回掉的消息数 */
  undoneMessages: number;
}

export interface KimiWireParse {
  messages: Message[];
  /** 每条 user 消息在 transcript 里的原文（按 messages 里 user 消息的顺序）；null = 不显示 */
  userDisplays: (string | null)[];
  /** 最后一次请求的模型 id */
  model: string | null;
  /** 第一条用户写的话（标题兜底） */
  firstPrompt: string | null;
  /** 第一条与最后一条对话消息的时间 */
  firstAt: number | null;
  lastAt: number | null;
  stats: KimiWireStats;
}

interface WireLine {
  line: number;
  record: Record<string, unknown>;
}

type Entry =
  | { kind: "user"; message: UserMessage; display: string | null; anchor: boolean; id: string | null; owner: string | null }
  | { kind: "assistant"; message: AssistantMessage }
  | { kind: "result"; message: ToolResultMessage };

/** 一个还没 step.end 的 step：块按到达顺序收，结果等 assistant 落定后再放。 */
interface OpenStep {
  uuid: string | null;
  content: AssistantMessage["content"];
  calls: { id: string; name: string }[];
  results: ToolResultMessage[];
  time: number;
}

/**
 * 按 agent.switched 求活动链（没有分支记录时就是全部行）。坏的分支记录（缺字段、指向不存在的
 * 分支、成环）→ 退回整份按行读，撤回由 context.undo 那一行兜底。
 */
function activeChain(lines: readonly WireLine[]): { chain: WireLine[]; pairedUndoLines: Set<number> } {
  const edges: { branch: string; baseBranch: string; baseLine: number; line: number }[] = [];
  const pairedUndoLines = new Set<number>();
  for (const { record, line } of lines) {
    if (record["type"] !== "agent.switched") continue;
    const base = record["base"];
    const branch = record["branch"];
    if (typeof branch !== "string" || !isRecord(base) || typeof base["branch"] !== "string" || typeof base["line"] !== "number") {
      return { chain: [...lines], pairedUndoLines: new Set() };
    }
    edges.push({ branch, baseBranch: base["branch"], baseLine: base["line"], line });
    if (typeof record["legacyUndoLine"] === "number") pairedUndoLines.add(record["legacyUndoLine"]);
  }
  if (edges.length === 0) return { chain: [...lines], pairedUndoLines };

  // 分支是按行连续的段：main 从第 1 行起，每条 switched 之后归新分支，直到下一条 switched
  const segments = new Map<string, { from: number; to: number; edge: (typeof edges)[number] | null }>();
  const lastLine = lines.length === 0 ? 0 : lines[lines.length - 1]!.line;
  segments.set("main", { from: 1, to: (edges[0]?.line ?? lastLine + 1) - 1, edge: null });
  edges.forEach((edge, index) => {
    const next = edges[index + 1];
    if (!segments.has(edge.branch)) segments.set(edge.branch, { from: edge.line + 1, to: (next?.line ?? lastLine + 1) - 1, edge });
  });
  const picked = new Set<number>();
  const visited = new Set<string>();
  const walk = (branch: string, upto: number | null): boolean => {
    if (visited.has(branch)) return false;
    visited.add(branch);
    const segment = segments.get(branch);
    if (segment === undefined) return false;
    if (segment.edge !== null && !walk(segment.edge.baseBranch, segment.edge.baseLine)) return false;
    const ceil = upto ?? segment.to;
    for (const { line } of lines) {
      if (line >= segment.from && line <= ceil) picked.add(line);
    }
    return true;
  };
  if (!walk(edges[edges.length - 1]!.branch, null)) return { chain: [...lines], pairedUndoLines: new Set() };
  return { chain: lines.filter(({ line }) => picked.has(line)), pairedUndoLines };
}

function toUsage(raw: unknown): Usage {
  const source = isRecord(raw) ? raw : {};
  const num = (key: string): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const input = num("inputOther");
  const output = num("output");
  const cacheRead = num("inputCacheRead");
  const cacheWrite = num("inputCacheCreation");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toStopReason(finishReason: unknown, hasCalls: boolean): AssistantMessage["stopReason"] {
  if (finishReason === "tool_use" || finishReason === "tool_calls") return "toolUse";
  if (finishReason === "max_tokens" || finishReason === "length") return "length";
  if (finishReason === "interrupted" || finishReason === "cancelled") return "aborted";
  if (finishReason === "error") return "error";
  return hasCalls ? "toolUse" : "stop";
}

/** 用户写的回合（撤回的锚点）：用户消息，或用户敲的 /技能、/插件命令。回合内插进来的不算。 */
function isUndoAnchor(origin: Record<string, unknown> | null): boolean {
  if (origin !== null && origin["inTurn"] === true) return false;
  const kind = origin?.["kind"];
  if (origin === null || kind === undefined || kind === "user") return true;
  return (kind === "skill_activation" || kind === "plugin_command") && origin["trigger"] === "user-slash";
}

/**
 * 第二段：wire 的原文 → pi Message 序列。providerId 由调用方注入（模型映射的结果）；
 * blobs 是 sha256 → base64（kimiBlobRefs 列出的那些，读不到的缺席即可）。
 */
export function parseKimiWire(raw: string, providerId: string, blobs: ReadonlyMap<string, string>): KimiWireParse {
  const stats: KimiWireStats = { orphanToolResults: 0, patchedToolCalls: 0, missingImages: 0, undoneMessages: 0 };
  const lines: WireLine[] = [];
  let lineNumber = 0;
  for (const text of raw.split("\n")) {
    if (text.trim() === "") continue;
    lineNumber += 1;
    try {
      const record: unknown = JSON.parse(text);
      if (isRecord(record)) lines.push({ line: lineNumber, record });
    } catch {
      // 半行（写到一半崩了）：跳过，行号照数，分支记录里的行号仍对得上
    }
  }
  const { chain, pairedUndoLines } = activeChain(lines);

  const toBlocks = (value: unknown): (TextContent | ImageContent)[] => {
    if (typeof value === "string") return value === "" ? [] : [{ type: "text", text: value }];
    if (!Array.isArray(value)) return [];
    const blocks: (TextContent | ImageContent)[] = [];
    for (const part of value) {
      if (!isRecord(part)) continue;
      if (part["type"] === "text" && typeof part["text"] === "string") {
        if (part["text"] !== "") blocks.push({ type: "text", text: part["text"] });
      } else if (part["type"] === "image_url") {
        const url = isRecord(part["imageUrl"]) ? part["imageUrl"]["url"] : isRecord(part["image_url"]) ? part["image_url"]["url"] : null;
        const ref = typeof url === "string" ? BLOB_REF.exec(url) : null;
        const inline = typeof url === "string" ? /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(url) : null;
        const data = ref !== null ? blobs.get(ref[2]!) : undefined;
        if (ref !== null && data !== undefined) blocks.push({ type: "image", data, mimeType: ref[1]! });
        else if (inline !== null) blocks.push({ type: "image", data: inline[2]!, mimeType: inline[1]! });
        else {
          stats.missingImages += 1;
          blocks.push({ type: "text", text: "[image not available in the imported copy]" });
        }
      }
    }
    return blocks;
  };

  const entries: Entry[] = [];
  /** 撤回的下限：clear / 压缩之前的回合撤不回去 */
  let floor = 0;
  let open: OpenStep | null = null;
  /** step 进行中插进来的用户消息：step 落定、结果放完之后再放（不插在 toolCall 与结果之间） */
  let deferred: Entry[] = [];
  let model: string | null = null;
  let lastTime = 0;

  const closeStep = (finishReason: unknown, usage: unknown): void => {
    if (open === null) return;
    const step = open;
    open = null;
    if (step.content.length > 0) {
      entries.push({
        kind: "assistant",
        message: {
          role: "assistant",
          content: step.content,
          api: "openai-completions",
          provider: providerId,
          model: model ?? "unknown",
          usage: toUsage(usage),
          stopReason: toStopReason(finishReason, step.calls.length > 0),
          timestamp: step.time,
        },
      });
      for (const result of step.results) entries.push({ kind: "result", message: result });
    }
    entries.push(...deferred);
    deferred = [];
  };

  for (const { record, line } of chain) {
    const type = record["type"];
    const time = toTime(record["time"]) ?? lastTime;
    lastTime = time;
    if (type === "llm.request") {
      model = optionalString(record["model"]) ?? model;
    } else if (type === "context.append_message") {
      const message = record["message"];
      if (!isRecord(message) || message["role"] !== "user") continue;
      const origin = isRecord(message["origin"]) ? message["origin"] : null;
      const content = toBlocks(message["content"]);
      if (content.length === 0) continue;
      const kind = origin?.["kind"];
      const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
      let display: string | null = null;
      if (origin === null || kind === undefined || kind === "user") display = text;
      else if ((kind === "skill_activation" || kind === "plugin_command") && origin["trigger"] === "user-slash") {
        const name = optionalString(origin["skillName"]) ?? optionalString(origin["commandName"]);
        const args = optionalString(origin["skillArgs"]) ?? optionalString(origin["args"]);
        display = name === null ? null : args === null ? `/${name}` : `/${name} ${args}`;
      }
      const entry: Entry = {
        kind: "user",
        message: { role: "user", content, timestamp: time },
        display,
        anchor: isUndoAnchor(origin),
        id: optionalString(message["id"]),
        owner: kind === "injection" ? optionalString(origin?.["ownerPromptId"]) : null,
      };
      if (open === null) entries.push(entry);
      else deferred.push(entry);
    } else if (type === "context.append_loop_event") {
      const event = record["event"];
      if (!isRecord(event)) continue;
      const eventType = event["type"];
      if (eventType === "step.begin") {
        closeStep("interrupted", null);
        open = { uuid: optionalString(event["uuid"]), content: [], calls: [], results: [], time };
      } else if (eventType === "content.part" && open !== null) {
        const part = event["part"];
        if (!isRecord(part)) continue;
        if (part["type"] === "think" && typeof part["think"] === "string" && part["think"] !== "") {
          const signature = optionalString(part["reasoningKey"]);
          open.content.push(
            signature === null
              ? { type: "thinking", thinking: part["think"] }
              : { type: "thinking", thinking: part["think"], thinkingSignature: signature },
          );
        } else if (part["type"] === "text" && typeof part["text"] === "string" && part["text"] !== "") {
          open.content.push({ type: "text", text: part["text"] });
        }
      } else if (eventType === "tool.call" && open !== null) {
        const id = optionalString(event["toolCallId"]);
        const name = optionalString(event["name"]);
        if (id === null || name === null) continue;
        const args = isRecord(event["args"]) ? event["args"] : {};
        const call: ToolCall = { type: "toolCall", id, name, arguments: args };
        open.content.push(call);
        open.calls.push({ id, name });
      } else if (eventType === "tool.result") {
        const id = optionalString(event["toolCallId"]);
        const result = isRecord(event["result"]) ? event["result"] : {};
        if (id === null) continue;
        const content = toBlocks(result["output"]);
        // note 是 Kimi 给模型的附注（如「读的是图片、原尺寸多少」），模型当时读到了
        if (typeof result["note"] === "string" && result["note"] !== "") content.push({ type: "text", text: result["note"] });
        const inOpen = open?.calls.find((call) => call.id === id);
        const message: ToolResultMessage = {
          role: "toolResult",
          toolCallId: id,
          toolName: inOpen?.name ?? "unknown",
          content,
          isError: result["isError"] === true,
          timestamp: time,
        };
        if (open !== null && inOpen !== undefined) open.results.push(message);
        else entries.push({ kind: "result", message });
      } else if (eventType === "step.end") {
        closeStep(event["finishReason"], event["usage"]);
      }
    } else if (type === "context.undo" && !pairedUndoLines.has(line)) {
      closeStep("interrupted", null);
      const count = record["count"];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) continue;
      let removed = 0;
      for (let index = entries.length - 1; index >= floor; index -= 1) {
        const entry = entries[index]!;
        if (entry.kind !== "user" || !entry.anchor) continue;
        removed += 1;
        if (removed < count) continue;
        let cut = index;
        while (cut > floor) {
          const before = entries[cut - 1]!;
          if (before.kind !== "user" || before.owner === null || before.owner !== entry.id) break;
          cut -= 1;
        }
        stats.undoneMessages += entries.length - cut;
        entries.length = cut;
        break;
      }
    } else if (type === "context.clear" || type === "context.apply_compaction") {
      closeStep("interrupted", null);
      floor = entries.length;
    }
  }
  closeStep("interrupted", null);

  const audited = auditToolPairs(entries, "kimi-code");
  stats.orphanToolResults = audited.orphanToolResults;
  stats.patchedToolCalls = audited.patchedToolCalls;
  return {
    messages: audited.messages,
    userDisplays: audited.userDisplays,
    model,
    firstPrompt: audited.firstPrompt,
    firstAt: audited.firstAt,
    lastAt: audited.lastAt,
    stats,
  };
}
