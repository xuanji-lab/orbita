/**
 * 旧会话（pi-coding-agent 的 pi 本子，JSONL v3）→ 新内核（pi-durable）的 entry 序列。
 * **纯模块**：只读一份本子的文本、产出要追加的 entry 草稿，不碰磁盘、不碰库，`node --test` 直接测。
 *
 * 迁移的目标是**「下一轮会发给模型的上下文」不变**，不是把本子逐行搬过去：
 *
 * - 只迁**当前分支**（从最后一条沿 parentId 走到根，branchEntries，与 pi 的 buildSessionPath 同一条规则）。
 *   回退 / 重答留下的废枝不迁——旧内核本来也看不见它们；原件原样留着，要翻还在。
 * - 每条 entry 投影成模型消息的规则照抄 pi 1.5.2 的 `sessionEntryToContextMessages` + `convertToLlm`：
 *   user / assistant / toolResult 原样；custom_message、custom 角色、branch_summary、bashExecution
 *   各自变成一条 user 消息（文案与 pi 逐字相同）；compaction 变成 durable 的 `pi.compaction`，
 *   摘要外层的包装文字两边本来就一样（pi 的 COMPACTION_SUMMARY_PREFIX 与 durable 的 SUMMARY_PREFIX 逐字相同）。
 * - 压缩的「从哪条开始保留」（firstKeptEntryId）换成 durable 的 `head`：指向保留的第一条迁过去的 entry。
 *   **不靠 id + 1 猜**（durable 1.5 的 group commit 只保证 id 单调）：调用方在同一次提交里按顺序追加，
 *   用 appendEntry 返回的真 id 回填（headRef 是本序列里的下标）。
 * - 不进上下文的 entry（model_change / thinking_level_change / custom / label / session_info）不迁；
 *   本子里的 system 消息不迁——新内核每轮自己写 `pi.system`（提示词与工具清单），旧本子里那条是旧内核的。
 * - 认不出的东西（context_edit、未来版本的新 entry 类型、未知角色）**整条会话不迁**，如实报原因：
 *   半份上下文比没迁更糟——模型会在缺了一块的历史上接着干。
 */
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { branchEntries, parsePiBook, type PiBookEntry } from "../main/session/pi-book.ts";

/** pi 的 COMPACTION_SUMMARY_PREFIX / SUFFIX（coding-agent 1.5.2 core/messages.js，durable compaction.js 同文） */
export const COMPACTION_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUFFIX = "\n</summary>";
/** pi 的 BRANCH_SUMMARY_PREFIX / SUFFIX（同上；注意后缀前没有换行，照抄） */
export const BRANCH_PREFIX = "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";
export const BRANCH_SUFFIX = "</summary>";

/** durable 内建 entry 的 kind（pi-durable entries.js），以及旧内核独有的两种投影 */
export const LEGACY_KINDS = {
  user: "pi.user",
  assistant: "pi.assistant",
  toolResult: "pi.tool-result",
  compaction: "pi.compaction",
  /** pi 的 custom_message / custom 角色 / bashExecution：进上下文的扩展消息 */
  custom: "orbita.legacy-custom",
  branchSummary: "orbita.legacy-branch-summary",
} as const;

/** 一条要追加的 entry。`headRef` 只有压缩有：本序列里保留的第一条的下标，"self" = 它自己（保留段为空）。 */
export interface LegacyDraft {
  kind: string;
  model: Message[];
  data?: { reason: "threshold" } | { diagnostics: [] } | { customType: string | null; display: boolean } | { legacyId: string };
  headRef?: number | "self";
}

export interface LegacyPlan {
  /** 本子头里的会话 id：pi 拿它当 provider 的 sessionId（提示缓存亲和），迁过去接着用 */
  providerSessionId: string | null;
  cwd: string;
  drafts: LegacyDraft[];
  /** 当前分支上跳过的 entry 计数（按类型），给报告与排障 */
  skipped: Record<string, number>;
  /** 当前分支之外（废枝）的 entry 数 */
  offBranch: number;
}

export type LegacyPlanResult = { ok: true; plan: LegacyPlan } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timestampOf(entry: PiBookEntry): number {
  const parsed = Date.parse(entry.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function userText(text: string, timestamp: number): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

/** pi 的 bashExecutionToText（coding-agent 1.5.2 core/messages.js），逐字照抄 */
function bashExecutionText(message: Record<string, unknown>): string {
  let text = `Ran \`${String(message["command"])}\`\n`;
  if (typeof message["output"] === "string" && message["output"] !== "") {
    text += `\`\`\`\n${message["output"]}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  const exitCode = message["exitCode"];
  if (message["cancelled"] === true) {
    text += "\n\n(command cancelled)";
  } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
    text += `\n\nCommand exited with code ${String(exitCode)}`;
  }
  if (message["truncated"] === true && typeof message["fullOutputPath"] === "string" && message["fullOutputPath"] !== "") {
    text += `\n\n[Output truncated. Full output: ${message["fullOutputPath"]}]`;
  }
  return text;
}

/** custom 内容：字符串包成一个 text 块，数组原样（pi 的 convertToLlm 同款） */
function customContent(content: unknown): UserMessage["content"] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as UserMessage["content"]) : [];
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * 一条 message entry → 草稿（null = 不进上下文，计入 skipped）。抛错 = 认不出，整条会话不迁。
 * 空 content 补成空数组 / 空串（pi 的 sessionEntryToContextMessages 同款防御）。
 */
function messageDraft(entry: PiBookEntry, skipped: Record<string, number>): LegacyDraft | null {
  const raw = entry.message;
  if (!isRecord(raw)) throw new Error(`entry ${entry.id} has no message`);
  const role = raw["role"];
  const message = raw["content"] == null && (role === "user" || role === "assistant" || role === "toolResult") ? { ...raw, content: [] } : raw;
  // 本子是 pi 写的 Message（JSON 往返过），按 pi-ai 的形状收下——与 pi 自己读本子时同样不做逐字段校验
  if (role === "user") return { kind: LEGACY_KINDS.user, model: [message as unknown as Message] };
  if (role === "assistant") return { kind: LEGACY_KINDS.assistant, model: [message as unknown as Message] };
  if (role === "toolResult") {
    return { kind: LEGACY_KINDS.toolResult, model: [message as unknown as Message], data: { diagnostics: [] } };
  }
  if (role === "system") {
    bump(skipped, "system");
    return null;
  }
  const timestamp = typeof message["timestamp"] === "number" ? message["timestamp"] : timestampOf(entry);
  if (role === "custom") {
    return {
      kind: LEGACY_KINDS.custom,
      model: [{ role: "user", content: customContent(message["content"]), timestamp }],
      data: { customType: typeof message["customType"] === "string" ? message["customType"] : null, display: message["display"] === true },
    };
  }
  if (role === "bashExecution") {
    if (message["excludeFromContext"] === true) {
      bump(skipped, "bashExecution(excluded)");
      return null;
    }
    return { kind: LEGACY_KINDS.custom, model: [userText(bashExecutionText(message), timestamp)], data: { customType: "bashExecution", display: true } };
  }
  if (role === "branchSummary" || role === "compactionSummary") {
    // 只由 entry 派生、不该以 message 形式出现在本子里；出现了就是没见过的写法
    throw new Error(`entry ${entry.id} stores a ${String(role)} message`);
  }
  throw new Error(`entry ${entry.id} has an unknown role ${JSON.stringify(role)}`);
}

/** 不进上下文、可以安全略过的 entry 类型（pi 1.5.2 的 sessionEntryToContextMessages 对它们返回 []） */
const OUT_OF_CONTEXT = new Set(["model_change", "thinking_level_change", "custom", "label", "session_info"]);

/**
 * 解析 + 规划。不抛错：认不出的本子返回 `{ ok: false, reason }`，reason 是给人看的一句话。
 */
export function planLegacyMigration(raw: string): LegacyPlanResult {
  let book;
  try {
    book = parsePiBook(raw);
  } catch (error) {
    return { ok: false, reason: `pi 本子读不出来：${error instanceof Error ? error.message : String(error)}` };
  }
  const path = branchEntries(book.entries);
  const skipped: Record<string, number> = {};
  const drafts: LegacyDraft[] = [];
  /** 本子 entry id → 它之后（含它）第一条迁过去的草稿下标；压缩的保留起点按它查 */
  const firstDraftAtOrAfter = new Map<string, number>();
  let pendingIds: string[] = [];
  const settlePending = (): void => {
    for (const id of pendingIds) firstDraftAtOrAfter.set(id, drafts.length);
    pendingIds = [];
  };
  try {
    for (const entry of path) {
      pendingIds.push(entry.id);
      let draft: LegacyDraft | null = null;
      if (entry.type === "message") {
        draft = messageDraft(entry, skipped);
      } else if (entry.type === "custom_message") {
        draft = {
          kind: LEGACY_KINDS.custom,
          model: [{ role: "user", content: customContent((entry as unknown as Record<string, unknown>)["content"] ?? []), timestamp: timestampOf(entry) }],
          data: {
            customType: typeof (entry as unknown as Record<string, unknown>)["customType"] === "string" ? String((entry as unknown as Record<string, unknown>)["customType"]) : null,
            display: (entry as unknown as Record<string, unknown>)["display"] === true,
          },
        };
      } else if (entry.type === "branch_summary") {
        const summary = (entry as unknown as Record<string, unknown>)["summary"];
        if (typeof summary === "string" && summary !== "") {
          draft = { kind: LEGACY_KINDS.branchSummary, model: [userText(BRANCH_PREFIX + summary + BRANCH_SUFFIX, timestampOf(entry))], data: { legacyId: entry.id } };
        } else {
          bump(skipped, "branch_summary(empty)");
        }
      } else if (entry.type === "compaction") {
        const record = entry as unknown as Record<string, unknown>;
        const summary = typeof record["summary"] === "string" ? record["summary"] : "";
        const firstKept = typeof record["firstKeptEntryId"] === "string" ? record["firstKeptEntryId"] : null;
        // 保留段 = 当前分支上 firstKept 到这条压缩之间的 entry；firstKept 不在这之前的分支上 = 保留段为空（pi 同款）
        const keptIndex = firstKept === null ? undefined : firstDraftAtOrAfter.get(firstKept);
        // 保留段里一条可迁的都没有（只有 model_change 之类）：起点落到压缩自己
        const headRef: number | "self" =
          keptIndex === undefined || keptIndex >= drafts.length || (firstKept !== null && pendingIds.includes(firstKept)) ? "self" : keptIndex;
        draft = {
          kind: LEGACY_KINDS.compaction,
          model: [userText(COMPACTION_PREFIX + summary + COMPACTION_SUFFIX, timestampOf(entry))],
          data: { reason: "threshold" },
          headRef,
        };
        if (record["systemMessage"] !== undefined) bump(skipped, "compaction.systemMessage");
      } else if (entry.type === "context_edit") {
        throw new Error(`entry ${entry.id} is a context_edit (not supported by the migration yet)`);
      } else if (OUT_OF_CONTEXT.has(entry.type)) {
        bump(skipped, entry.type);
      } else {
        throw new Error(`entry ${entry.id} has an unknown type ${JSON.stringify(entry.type)}`);
      }
      if (draft !== null) {
        settlePending();
        drafts.push(draft);
      }
    }
  } catch (error) {
    return { ok: false, reason: `pi 本子里有认不出的内容：${error instanceof Error ? error.message : String(error)}` };
  }
  return {
    ok: true,
    plan: {
      providerSessionId: book.header.id,
      cwd: book.header.cwd,
      drafts,
      skipped,
      offBranch: book.entries.length - path.length,
    },
  };
}
