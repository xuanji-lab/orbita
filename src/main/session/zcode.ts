/**
 * ZCode 的会话库 → opencode 同形的行 → opencodeToMessages。读库（只读）+ 取数两段；
 * 两家的库同源同形（session / message / part，part 类型词表一致），转换不做第二份，
 * 这里只吸收差异：
 *
 * ## 源（2026-09-28 本机调研：146 条会话 / 19544 条消息 / 69202 个 part，库 372MB）
 *
 * - 库在 `~/.zcode/cli/db/db.sqlite`。session 表 parent_id 非空的是 ZCode 的 side chat /
 *   task 子 agent（本机 86/146），不列——母会话的工具结果已含它的产出（opencode 同款裁决）。
 * - message / part 的顺序照 ZCode 自己的读法（adapters/.../repositories/messages.ts 的
 *   messages()）：message `sequence is null, sequence, time_created, rowid`，part
 *   `message_id, sequence is null, sequence, time_created, id`。可见分支按下标切，顺序错了切出来就错。
 * - **rewind 照 ZCode 自己的可见规则取**（contracts/src/rewind 的 selectActiveConversationBranch，
 *   界面读历史走 cold-event-merge，revert 四个字段原样喂进去）：保留名单 keptMessageIDs 只是
 *   回退那一刻的快照，**回退之后接着聊的消息不在名单里**，靠 branchCutAfterMessageID 认。只按名单
 *   过滤会把回退之后的整段对话丢掉（本机三条带 revert 的会话丢 13 / 31 / 246 条）。
 * - message.data 键名是小写 d 的 providerId / modelId（opencode 大写 D）——opencodeToMessages
 *   两个拼写都认，模型章与 anthropic 判定不受影响。finish 原因、step-finish.tokens 同形。
 * - part 多一个 `timeline` 类型（宿主的 UI 时间线，模型没见过）——opencode 转换器对不认识的
 *   part 类型本来就不看；compaction 同 opencode 跳过。
 * - title 都是真实标题（title_source: first_input / generated），没有默认标题要滤。
 */
import { DatabaseSync } from "node:sqlite";
import type { OpencodeMessageRow } from "./opencode.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** 一条根会话（子会话不列）。 */
export interface ZcodeSessionRow {
  id: string;
  directory: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 根会话清单（parent_id 为空）。字段缺席按缺省走：坏一行好过抛整库。
 * title 不过滤——ZCode 的标题全是真实的（first_input / generated）。
 */
export function readZcodeSessions(db: DatabaseSync): ZcodeSessionRow[] {
  const rows: ZcodeSessionRow[] = [];
  for (const row of db.prepare("select id, directory, title, time_created, time_updated from session where parent_id is null order by time_created").iterate()) {
    const id = row["id"];
    if (typeof id !== "string" || id === "") continue;
    rows.push({
      id,
      directory: typeof row["directory"] === "string" ? row["directory"] : null,
      title: typeof row["title"] === "string" ? row["title"] : null,
      createdAt: typeof row["time_created"] === "number" ? row["time_created"] : 0,
      updatedAt: typeof row["time_updated"] === "number" ? row["time_updated"] : 0,
    });
  }
  return rows;
}

/** session.revert 里可见分支要用的四个字段（SessionRevert 的子集）。 */
interface ZcodeRevert {
  targetMessageId: string | null;
  keptMessageIds: readonly string[] | null;
  branchCutAfterMessageId: string | null;
  createdMessageId: string | null;
}

/** 解 session.revert。缺席 / 坏 JSON → null（当没有回退：ZCode 同样对全部消息可见）。 */
function parseRevert(raw: unknown): ZcodeRevert | null {
  const value = typeof raw === "string" ? parseJson(raw) : raw;
  if (!isRecord(value)) return null;
  const text = (key: string): string | null => {
    const field = value[key];
    return typeof field === "string" && field !== "" ? field : null;
  };
  const kept = value["keptMessageIDs"];
  return {
    targetMessageId: text("targetMessageID"),
    keptMessageIds: Array.isArray(kept) ? kept.filter((id): id is string => typeof id === "string") : null,
    branchCutAfterMessageId: text("branchCutAfterMessageID"),
    createdMessageId: text("createdMessageID"),
  };
}

/**
 * ZCode 的 selectActiveConversationBranch 逐分支照抄（只换成按 id 操作）。ZCode 的注释：
 * active branch = keptMessageIDs + branchCutAfterMessageID 之后新追加的消息；旧数据没有
 * cut 游标，用 createdMessageID 起算；连名单都没有的最老数据，取 targetMessageID 之前的。
 * 没有 targetMessageID = 没有回退，全部可见。kept 的顺序是名单的顺序（不是库里的顺序）。
 */
export function zcodeActiveBranch(ids: readonly string[], revert: ZcodeRevert | null): string[] {
  if (revert === null || revert.targetMessageId === null) return [...ids];
  const known = new Set(ids);
  const targetIndex = ids.indexOf(revert.targetMessageId);
  const kept =
    revert.keptMessageIds !== null
      ? revert.keptMessageIds.filter((id) => known.has(id))
      : targetIndex >= 0
        ? ids.slice(0, targetIndex)
        : [...ids];
  if (revert.branchCutAfterMessageId !== null) {
    const cutIndex = ids.indexOf(revert.branchCutAfterMessageId);
    return cutIndex >= 0 ? [...kept, ...ids.slice(cutIndex + 1)] : kept;
  }
  if (revert.keptMessageIds !== null) {
    if (revert.createdMessageId === null) return kept;
    const createdIndex = ids.indexOf(revert.createdMessageId);
    return createdIndex >= 0 ? [...kept, ...ids.slice(createdIndex)] : kept;
  }
  if (targetIndex < 0) return [...ids];
  if (revert.createdMessageId === null) return kept;
  const createdIndex = ids.indexOf(revert.createdMessageId);
  return createdIndex >= 0 ? [...kept, ...ids.slice(createdIndex)] : kept;
}

/**
 * 一条会话在 ZCode 里可见的消息行（opencode 同形，喂 opencodeToMessages）：按 ZCode 的顺序
 * 读全部消息，再按它的可见规则取分支；part 按 ZCode 的顺序挂回各自的消息。
 */
export function readZcodeMessages(db: DatabaseSync, sessionId: string): OpencodeMessageRow[] {
  const revertRow = db.prepare("select revert from session where id = ?").get(sessionId) as Record<string, unknown> | undefined;
  const revert = parseRevert(revertRow?.["revert"]);
  const partsByMessage = new Map<string, { id: string; data: string }[]>();
  for (const part of db
    .prepare(
      "select message_id, id, data from part where session_id = ? order by message_id, sequence is null, sequence, time_created, id",
    )
    .iterate(sessionId)) {
    const messageId = part["message_id"];
    if (typeof messageId !== "string") continue;
    const entry = { id: String(part["id"] ?? ""), data: String(part["data"] ?? "") };
    const list = partsByMessage.get(messageId);
    if (list === undefined) partsByMessage.set(messageId, [entry]);
    else list.push(entry);
  }
  const byId = new Map<string, string>();
  const order: string[] = [];
  for (const message of db
    .prepare("select id, data from message where session_id = ? order by sequence is null, sequence, time_created, rowid")
    .iterate(sessionId)) {
    const id = message["id"];
    if (typeof id !== "string") continue;
    byId.set(id, String(message["data"] ?? ""));
    order.push(id);
  }
  return zcodeActiveBranch(order, revert).map((id) => ({ id, data: byId.get(id) ?? "", parts: partsByMessage.get(id) ?? [] }));
}

/** 会话在库里的体量（message + part 的 data 字节和），给计划条目估大小。 */
export function zcodeSessionBytes(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare(
      "select (select coalesce(sum(length(data)), 0) from message where session_id = ?) + (select coalesce(sum(length(data)), 0) from part where session_id = ?) as bytes",
    )
    .get(sessionId, sessionId) as { bytes: number | null } | undefined;
  return row?.bytes ?? 0;
}
