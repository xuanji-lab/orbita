import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import {
  memoryShortId,
  type MemoryAgentCall,
  type MemoryAgentOutcome,
  type MemoryEntry,
} from "../shared/memory.ts";

/**
 * agent 的记忆工具（实验功能 memory-system）：memory_search / memory_revise / memory_retire。
 *
 * 为什么有它（2026-10-29 用户）：「比如有记忆召回是错误的，我一句话，agent 就可以找到错误
 * 东西，标记为过时，换上我新的陈述。一种一直在对齐的状态」「我不想去确认记忆，agent 应该
 * 自己有判断力吧」。所以：
 * - 写不过审批（shared/permission.ts 的 MEMORY_TOOLS 三档放行），每次改动都能在条目卡上撤；
 * - **只给根会话注册**（子会话读不写；主进程另按 meta 再拒一次子会话的写）；
 * - 存储在记忆服务进程（唯一写者），这里只把参数翻成 memoryToolRequest、把回执翻成工具结果
 *   （task-tools.ts 的 requestBroker 范式）。
 *
 * 召回块里每条带短 id（memoryShortId），用户说「刚才那条不对」时模型不用先查就能直接改。
 */
export interface MemoryToolContext {
  scope: { workspaceId: string | null; cwd: string };
  /** 本轮轮号（revise 新条的出处）；runtime 在开轮回显时填 */
  turn: () => number;
}

/** 工具名（权限名单在 shared/permission.ts 的 MEMORY_TOOLS，两处同名） */
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_revise", "memory_retire"] as const;

function formatDate(at: number): string {
  const date = new Date(at);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** 一条记忆给模型看的一行：短 id · 日期 · 类型 · 层，然后正文。 */
export function formatMemoryLine(entry: MemoryEntry): string {
  const layer = entry.layer === "user" ? "all workspaces" : "this workspace";
  return `- [${memoryShortId(entry.id)} · ${formatDate(entry.at)} · ${entry.type} · ${layer}] ${entry.text}`;
}

/** 回执 → 工具结果正文（按 op 讲清楚改了什么）。 */
export function describeMemoryOutcome(call: MemoryAgentCall, entries: readonly MemoryEntry[]): string {
  if (call.op === "search") {
    return entries.length === 0
      ? "No matching memory entries."
      : `${entries.length} memory entries (most relevant first):\n${entries.map(formatMemoryLine).join("\n")}`;
  }
  if (call.op === "revise") {
    const [fresh, old] = entries;
    if (fresh === undefined || old === undefined) return "Revised.";
    return (
      `Revised. ${memoryShortId(old.id)} is now stale (kept in its history, no longer recalled); ` +
      `the new statement is ${memoryShortId(fresh.id)}:\n${formatMemoryLine(fresh)}\n` +
      "The user can undo this from the memory card. Tell the user in one short sentence what you changed."
    );
  }
  const [entry] = entries;
  return entry === undefined
    ? "Retired."
    : `Retired ${memoryShortId(entry.id)}: it will no longer be recalled (the user can restore it). ` +
        "Tell the user in one short sentence.";
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

async function callMemory(
  broker: RequestBroker,
  sessionId: string,
  context: MemoryToolContext,
  call: MemoryAgentCall,
): Promise<{ content: { type: "text"; text: string }[]; details: Record<string, never> }> {
  const result = await broker.request<MemoryAgentOutcome>({
    type: "memoryToolRequest",
    sessionId,
    turn: context.turn(),
    scope: context.scope,
    call,
  });
  if (!result.ok) throw new Error(result.error);
  return { content: [{ type: "text", text: describeMemoryOutcome(call, result.entries) }], details: {} };
}

export function createMemoryTools(
  broker: RequestBroker,
  sessionId: string,
  context: MemoryToolContext,
): ToolDefinition[] {
  const search: ToolDefinition = {
    name: "memory_search",
    label: "memory_search",
    description:
      "Search this agent's long-term memory (entries recorded from earlier conversations in this workspace and " +
      "across all workspaces). Returns each entry's id, date, type, layer and text. Use it to find the entry the " +
      "user is correcting when it is not already in an <orbita-memory> block of this conversation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for, in the words the entry would use." },
      },
      required: ["query"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      return callMemory(broker, sessionId, context, { op: "search", query: requireText(args["query"], "query") });
    },
  };

  const revise: ToolDefinition = {
    name: "memory_revise",
    label: "memory_revise",
    description:
      "Replace a memory entry the user has corrected: the old entry is marked stale (kept in its history, no " +
      "longer recalled) and your new statement is recorded in its place, linked to it. Write the new statement " +
      "the way memory entries are written: self-contained, third person (\"the user\"), absolute dates.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The entry's id as shown in brackets (mem_xxxxxxxx), or the full id.",
        },
        text: { type: "string", description: "The corrected statement that replaces it." },
        reason: { type: "string", description: "Why: what the user said that corrected it." },
      },
      required: ["id", "text", "reason"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      return callMemory(broker, sessionId, context, {
        op: "revise",
        entryId: requireText(args["id"], "id"),
        text: requireText(args["text"], "text"),
        reason: requireText(args["reason"], "reason"),
      });
    },
  };

  const retire: ToolDefinition = {
    name: "memory_retire",
    label: "memory_retire",
    description:
      "Stop using a memory entry that is simply wrong and has no replacement (the user can restore it). " +
      "If the user gave a new statement, use memory_revise instead.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The entry's id as shown in brackets (mem_xxxxxxxx), or the full id.",
        },
        reason: { type: "string", description: "Why: what the user said." },
      },
      required: ["id", "reason"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      return callMemory(broker, sessionId, context, {
        op: "retire",
        entryId: requireText(args["id"], "id"),
        reason: requireText(args["reason"], "reason"),
      });
    },
  };

  return [search, revise, retire];
}

/**
 * 记忆工具的使用说明（拼进 system prompt，describeChannelRole 的同款写法）：**整个会话
 * 不变**——只在根会话、记忆开着时讲，段落本身不随轮变，不断前缀缓存。
 *
 * 讲判断力，不讲流程：什么时候改、什么时候别动。用户 2026-10-29：「一种一直在对齐的
 * 状态，而不是瞎忙活的状态」——所以写明「只在用户纠正或明显矛盾时写」「不要每轮去动」
 * 「不要拿它存新东西」（新东西由对话整理自动记，agent 再存一遍就是重复）。
 */
export const MEMORY_TOOLS_GUIDELINE = `<orbita-memory-tools>
Long-term memory: entries recalled for a message are attached to it in an <orbita-memory> block, each line
starting with [id · date]. Memory is recorded automatically from conversations; your job is only to keep it
aligned with what the user actually says now. Use judgment — do not ask the user to confirm memory changes.
- The user corrects or contradicts a recalled entry ("no, that's wrong", "I changed my mind", "now I want …"):
  call memory_revise with that entry's id and the corrected statement in the same turn, then say in one short
  sentence what you changed. Do not just agree in your reply — an unrevised entry will be recalled again.
- The user says an entry is simply wrong and gives nothing to replace it: memory_retire.
- The entry being corrected is not in any <orbita-memory> block: memory_search for it first. If nothing
  matches, there is nothing to fix — do not create a new entry; the conversation itself will be recorded.
- Otherwise leave memory alone: do not touch it every turn, do not store new facts with these tools, and do
  not revise an entry just because the current task differs from it (memories describe other situations).
</orbita-memory-tools>`;
