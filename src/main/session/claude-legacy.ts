/**
 * Claude Code legacy 渲染 JSONL → pi Message 序列的转换器 —— 纯模块。
 *
 * 源格式（Proma 的 `agent-sessions/<id>.jsonl`，索引里 legacyTranscript.sourceRuntime === "claude"）
 * 本来就是 Anthropic Messages 风格（调研 2026-09-21 §六），所以这里的分层是三段：
 * **清洗（parseClaudeRows）→ pi Message 构造（claudeRowsToMessages）→ 灌入（importer.ts 侧
 * SessionManager.create + appendMessage）**。第二个平台（zcode/reasonix）进场时把前两段
 * 抽成「平台 adapter → 中间层」的共享模块；现在只留形不留壳。
 *
 * ## 源格式的真实形态（2026-09-22 全量 257 文件调研）
 *
 * - 行类型：`user` / `assistant` / `result`（turn 汇总，不进消息流）/ `system`（compact_boundary，
 *   无摘要文本）/ 旧扁平行（无 type 字段、带 events[]——PR-3 范围，跳过）。
 * - **流式碎片**：同一 assistant 消息的每个 content_block 完成事件落一行（一行恰好一个块），
 *   行序即流序。去重规则 = 相邻行按 `message.id` 分组、组内按行序收块——不是 delta 拼接
 *   （实测 text 行之间是独立段落而非增量续写）。
 * - **子代理行**：`parent_tool_use_id` 非空的 user/assistant 行是 Agent 工具内部的子对话，
 *   主对话的 tool_result 已含子代理最终输出，跳过（约 1/6 的行）。
 * - `server_tool_use` 块：兼容渠道的服务端工具（268 个），pi 无对应概念，跳过。
 * - thinking 块带 Anthropic signature → 保留为 pi 的 thinkingSignature（续聊发回原渠道时有效，
 *   其他渠道无害）。
 * - 图片在 tool_result 的 content 数组里（`source.type === "base64"`）；url 形态拿不到数据，跳过。
 *   Claude Code 自己的会话文件（claude-code.ts 清洗后也走这里）的用户行还有用户粘贴的图，同样收。
 * - usage：消息级（每行都带该消息的 usage）。result 行是 turn 级聚合——与消息级重复计
 *   cache，不用它（pi 语义是消息级，meta.stats 从派生 records 聚合，与 PR-1 同源）。
 *
 * ## 配对审计
 *
 * Anthropic Messages API 要求 tool_use 与 tool_result 严格配对，孤儿任意一侧续聊时都会被
 * 拒。清洗后的消息流做两件事：孤儿 tool_result（前文没有对应 toolCall）丢弃；dangling
 * toolCall（被用户打断、结果行没写出来）在下一个用户插话 / 下一条 assistant / 文件结束处
 * 补一条合成 toolResult，内容说明这是导入时补的。
 */
import type {
  Message,
  Usage,
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";

/** 清洗后的主对话行（已剔除旧扁平 / system / result / 子代理行）。 */
export interface ClaudeMainRow {
  type: "user" | "assistant";
  /** assistant 行的消息分组键（message.id；缺席用行号——每个缺席行独立成组） */
  groupId: string;
  /** 行内 message.content 的原样块数组（防御：可能是任意形状） */
  blocks: unknown;
  /** 该行的 stop_reason（assistant）或 undefined（user 行没有） */
  stopReason: unknown;
  /** 行级 usage 原样（assistant 组内换算） */
  usage: unknown;
  /** 行上是否有 error 载荷（Proma 的 _errorCode / Claude 的 error 字段） */
  hasError: boolean;
  /** 模型 id（assistant 行 message.model） */
  model: string | null;
  /** 毫秒时间戳：行 timestamp(ISO) 优先，退 _createdAt */
  timestamp: number;
}

/** 清洗阶段的全部产物：主对话行 + 跳过统计（报告与快照测试的原料）。 */
export interface ClaudeRowStats {
  badLines: number;
  oldFlatRows: number;
  subagentRows: number;
  systemRows: number;
  resultRows: number;
  otherTypedRows: number;
}

export interface ClaudeRowParse {
  rows: ClaudeMainRow[];
  stats: ClaudeRowStats;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function rowTimestamp(obj: Record<string, unknown>): number {
  const iso = optionalString(obj["timestamp"]);
  if (iso !== null) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const created = obj["_createdAt"];
  if (typeof created === "number" && Number.isFinite(created)) return created;
  return 0;
}

/**
 * 第一段：清洗。逐行容错（坏行跳过不炸），剔除不属于主对话的行。
 * 只做形状防御与过滤，不做块翻译——模型提取与 Message 构造在后续两段。
 */
export function parseClaudeRows(raw: string): ClaudeRowParse {
  const rows: ClaudeMainRow[] = [];
  const stats: ClaudeRowStats = {
    badLines: 0,
    oldFlatRows: 0,
    subagentRows: 0,
    systemRows: 0,
    resultRows: 0,
    otherTypedRows: 0,
  };
  let index = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    index += 1;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      stats.badLines += 1;
      continue;
    }
    if (!isRecord(obj)) {
      stats.badLines += 1;
      continue;
    }
    // 旧扁平格式（PR-3 范围）：没有 type 字段、按 events[] 组织
    if (obj["type"] === undefined) {
      stats.oldFlatRows += 1;
      continue;
    }
    if (obj["type"] === "result") {
      stats.resultRows += 1;
      continue;
    }
    if (obj["type"] === "system") {
      stats.systemRows += 1;
      continue;
    }
    if (obj["type"] !== "user" && obj["type"] !== "assistant") {
      stats.otherTypedRows += 1;
      continue;
    }
    // 子代理内部对话（Agent 工具执行期间的行）：主对话 tool_result 已含其最终输出
    if (obj["parent_tool_use_id"] !== null && obj["parent_tool_use_id"] !== undefined) {
      stats.subagentRows += 1;
      continue;
    }
    const message = isRecord(obj["message"]) ? obj["message"] : null;
    rows.push({
      type: obj["type"] as "user" | "assistant",
      groupId: optionalString(message?.["id"]) ?? `#line-${index}`,
      blocks: message?.["content"],
      stopReason: message?.["stop_reason"],
      usage: message?.["usage"],
      hasError: isRecord(obj["error"]) || optionalString(obj["_errorCode"]) !== null,
      model: optionalString(message?.["model"]),
      timestamp: rowTimestamp(obj),
    });
  }
  return { rows, stats };
}

/** 扫描期的模型提取：最后一个 assistant 组的 model（索引缺 modelId 时的兜底，同 PR-1 语义）。 */
export function lastModelFromRows(rows: readonly ClaudeMainRow[]): string | null {
  let last: string | null = null;
  for (const row of rows) {
    if (row.type === "assistant" && row.model !== null) last = row.model;
  }
  return last;
}

/** 主对话里有没有 assistant 行（pi 只在有 assistant 消息时落盘文件——没有就不可续聊）。 */
export function hasAssistantRow(rows: readonly ClaudeMainRow[]): boolean {
  return rows.some((row) => row.type === "assistant");
}

// ---------------------------------------------------------------------------
// 第二段：pi Message 构造
// ---------------------------------------------------------------------------

interface AssistantGroup {
  /** 组内全部行（同 groupId 且相邻） */
  rows: ClaudeMainRow[];
}

/** usage 换算：input_tokens→input、cache_read→cacheRead、cache_creation→cacheWrite。
 *  缺席字段落 0；cost 无源数据，全 0（诚实优于编造）。 */
function toUsage(raw: unknown): Usage {
  const source = isRecord(raw) ? raw : {};
  const num = (key: string): number => {
    const value = source[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const input = num("input_tokens");
  const output = num("output_tokens");
  const cacheRead = num("cache_read_input_tokens");
  const cacheWrite = num("cache_creation_input_tokens");
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 组级 stopReason：error > toolUse > length > stop。源值 end_turn / null / undefined 都落 stop。 */
function groupStopReason(group: readonly ClaudeMainRow[]): AssistantMessage["stopReason"] {
  let sawToolUse = false;
  let sawMaxTokens = false;
  for (const row of group) {
    if (row.hasError) return "error";
    if (row.stopReason === "tool_use") sawToolUse = true;
    if (row.stopReason === "max_tokens") sawMaxTokens = true;
  }
  if (sawToolUse) return "toolUse";
  if (sawMaxTokens) return "length";
  return "stop";
}

interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
}

/** 构造产物的旁路统计（快照测试与排障用）。 */
export interface ClaudeMessageStats {
  /** 被丢弃的未知块（server_tool_use / 未来的新块类型）计数 */
  droppedBlocks: number;
  /** 孤儿 tool_result（前文没有对应 toolCall）丢弃计数 */
  orphanToolResults: number;
  /** dangling toolCall 补合成结果计数 */
  patchedToolCalls: number;
  /** 空消息跳过计数（块全被丢弃 / 空文本的行） */
  emptyMessages: number;
}

export interface ClaudeMessageParse {
  messages: Message[];
  stats: ClaudeMessageStats;
  /**
   * 每条 user 消息来自 rows 里的哪一行（按 messages 里 user 消息的顺序）。调用方按它把行上的
   * 导入侧信息（显示文本、是否隐藏）配到灌出来的 entry 上——哪些行产出消息由这里决定，
   * 不让调用方再写一遍会漂的判定
   */
  userRowIndexes: number[];
}

/**
 * 第二段：清洗后的行 → pi Message 序列。
 *
 * providerId 由调用方注入（importer 侧模型映射的结果）——源格式没有可靠的 provider 字段
 * （_channelProvider 是渠道名，anthropic 渠道跑过 glm），模型 id 保留源文件原值。
 */
export function claudeRowsToMessages(rows: readonly ClaudeMainRow[], providerId: string): ClaudeMessageParse {
  const stats: ClaudeMessageStats = {
    droppedBlocks: 0,
    orphanToolResults: 0,
    patchedToolCalls: 0,
    emptyMessages: 0,
  };
  const messages: Message[] = [];
  const userRowIndexes: number[] = [];

  // 组切分：assistant 行按相邻同 groupId 归组（流序保证相邻）；user 行天然一行一组
  const groups: (AssistantGroup | { row: ClaudeMainRow; index: number })[] = [];
  rows.forEach((row, index) => {
    if (row.type === "assistant") {
      const last = groups[groups.length - 1];
      if (last !== undefined && "rows" in last && last.rows[0]!.groupId === row.groupId) {
        last.rows.push(row);
      } else {
        groups.push({ rows: [row] });
      }
    } else {
      groups.push({ row, index });
    }
  });

  // 配对审计状态：还没等到结果的 toolCall（按 toolCallId → 工具名）
  const pending = new Map<string, string>();
  let lastTimestamp = 0;
  const patchPending = (): void => {
    for (const [toolCallId, toolName] of pending) {
      stats.patchedToolCalls += 1;
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: "[claude-legacy import] 原会话在此处被打断，工具结果缺失，导入时补此占位。" }],
        isError: true,
        timestamp: lastTimestamp,
      });
    }
    pending.clear();
  };

  for (const group of groups) {
    if ("rows" in group) {
      // —— assistant 组：合并为一个 AssistantMessage ——
      const content: AssistantMessage["content"] = [];
      const toolCalls: ToolCallInfo[] = [];
      let model = "unknown";
      let usage: Usage | null = null;
      for (const row of group.rows) {
        if (row.model !== null) model = row.model;
        // 组内各行 usage 相同（流式行都带消息级 usage）；取最后出现的非空值，缺席行不覆盖
        if (isRecord(row.usage)) usage = toUsage(row.usage);
        if (!Array.isArray(row.blocks)) continue;
        for (const block of row.blocks) {
          if (!isRecord(block)) continue;
          if (block["type"] === "text" && typeof block["text"] === "string") {
            if (block["text"] !== "") content.push({ type: "text", text: block["text"] });
          } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
            const signature = optionalString(block["signature"]);
            content.push(
              signature === null
                ? { type: "thinking", thinking: block["thinking"] }
                : { type: "thinking", thinking: block["thinking"], thinkingSignature: signature },
            );
          } else if (
            block["type"] === "tool_use" &&
            typeof block["id"] === "string" &&
            typeof block["name"] === "string" &&
            isRecord(block["input"])
          ) {
            const toolCall: ToolCall = {
              type: "toolCall",
              id: block["id"],
              name: block["name"],
              arguments: block["input"] as ToolCall["arguments"],
            };
            content.push(toolCall);
            toolCalls.push({ toolCallId: block["id"], toolName: block["name"] });
          } else {
            // server_tool_use（服务端工具，pi 无对应）与未知块：跳过——坏一块好过错一块
            stats.droppedBlocks += 1;
          }
        }
      }
      if (content.length === 0) {
        // 组内块全被丢弃（如只剩 server_tool_use）：不产出空 assistant 消息
        stats.emptyMessages += 1;
        continue;
      }
      patchPending();
      const timestamp = group.rows[0]!.timestamp || lastTimestamp;
      lastTimestamp = timestamp;
      messages.push({
        role: "assistant",
        content,
        // claude legacy 的内容形状就是 Anthropic Messages API——api 字段记它的出身
        api: "anthropic-messages",
        provider: providerId,
        model,
        usage: usage ?? toUsage(null),
        stopReason: groupStopReason(group.rows),
        timestamp,
      });
      for (const call of toolCalls) pending.set(call.toolCallId, call.toolName);
      continue;
    }

    // —— user 行：text 块与 tool_result 块分道 ——
    const row = group.row;
    if (!Array.isArray(row.blocks)) {
      stats.emptyMessages += 1;
      continue;
    }
    // 文字与图片按原顺序收（用户粘贴的图在文字前还是后，模型当时就是这么读的）
    const parts: UserMessage["content"] = [];
    const toolResults: { toolUseId: string; isError: boolean; content: ToolResultMessage["content"] }[] = [];
    for (const block of row.blocks) {
      if (!isRecord(block)) continue;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        if (block["text"] !== "") parts.push({ type: "text", text: block["text"] });
      } else if (block["type"] === "image") {
        // 用户粘贴的图（Claude Code 的用户行里有；Proma 界面日志里没有）
        const image = toImageBlock(block);
        if (image === null) stats.droppedBlocks += 1;
        else parts.push(image);
      } else if (block["type"] === "tool_result" && typeof block["tool_use_id"] === "string") {
        toolResults.push({
          toolUseId: block["tool_use_id"],
          isError: block["is_error"] === true,
          content: toToolResultContent(block["content"], stats),
        });
      } else {
        stats.droppedBlocks += 1;
      }
    }
    // tool_result 先落（它是上一轮 assistant 的应答），user text 后落（新一轮提问）
    for (const result of toolResults) {
      if (!pending.has(result.toolUseId)) {
        // 孤儿：对应的 toolCall 不在主对话（可能在被跳过的子代理行里）——发给 API 会被拒，丢弃
        stats.orphanToolResults += 1;
        continue;
      }
      const toolName = pending.get(result.toolUseId) ?? "unknown";
      pending.delete(result.toolUseId);
      const timestamp = row.timestamp || lastTimestamp;
      lastTimestamp = timestamp;
      messages.push({
        role: "toolResult",
        toolCallId: result.toolUseId,
        toolName,
        content: result.content,
        isError: result.isError,
        timestamp,
      });
    }
    if (parts.length > 0) {
      patchPending();
      const timestamp = row.timestamp || lastTimestamp;
      lastTimestamp = timestamp;
      messages.push({ role: "user", content: parts, timestamp });
      userRowIndexes.push(group.index);
    } else if (toolResults.length === 0) {
      // 空行（无有效块）
      stats.emptyMessages += 1;
    }
  }
  patchPending();
  return { messages, stats, userRowIndexes };
}

/** Anthropic 的 base64 图片块 → pi 图片块；url 形态拿不到数据本体，返回 null。 */
function toImageBlock(block: Record<string, unknown>): { type: "image"; data: string; mimeType: string } | null {
  const source = isRecord(block["source"]) ? block["source"] : null;
  if (
    source !== null &&
    source["type"] === "base64" &&
    typeof source["data"] === "string" &&
    typeof source["media_type"] === "string"
  ) {
    return { type: "image", data: source["data"], mimeType: source["media_type"] };
  }
  return null;
}

/** tool_result 的 content：string → 单 text 块；数组 → text/image 块翻译（url 图像跳过）。 */
function toToolResultContent(raw: unknown, stats: ClaudeMessageStats): ToolResultMessage["content"] {
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ type: "text", text: raw }];
  }
  if (!Array.isArray(raw)) return [];
  const content: ToolResultMessage["content"] = [];
  for (const element of raw) {
    if (!isRecord(element)) continue;
    if (element["type"] === "text" && typeof element["text"] === "string") {
      if (element["text"] !== "") content.push({ type: "text", text: element["text"] });
    } else if (element["type"] === "image") {
      const image = toImageBlock(element);
      // url 形态的图像拿不到数据本体
      if (image === null) stats.droppedBlocks += 1;
      else content.push(image);
    } else {
      stats.droppedBlocks += 1;
    }
  }
  return content;
}
