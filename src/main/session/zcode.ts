/**
 * ZCode 的会话库 → opencode 同形的行 → opencodeToMessages。读库（只读）+ 取数两段；
 * 两家的库同源同形（session / message / part，part 类型词表一致），转换不做第二份，
 * 这里只吸收差异：
 *
 * ## 源（2026-09-28 本机调研：146 条会话 / 19544 条消息 / 69202 个 part，库 372MB）
 *
 * - 库在 `~/.zcode/cli/db/db.sqlite`。session 表 parent_id 非空的是 ZCode 的 side chat /
 *   task 子 agent（本机 86/146），不列——母会话的工具结果已含它的产出（opencode 同款裁决）。
 * - message / part 都有显式 sequence 列，按它排序（opencode 是按 id）。
 * - **rewind 是白名单**：session.revert = `{keptMessageIDs: string[], …}`（ZCode 的
 *   conversation_rewind），不是 opencode 的截断点。取数时只留白名单里的消息——导用户在
 *   ZCode 里看到的历史，回退掉的不复活（本机 20/146 条带 revert）。
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

/**
 * rewind 白名单：revert JSON 的 keptMessageIDs 是数组（哪怕空）就按它过滤；
 * 缺席 / 坏 JSON / 不是数组 → 不动（坏一条 rewind 记录不该清空整段历史）。
 */
function keptMessageIds(revert: unknown): ReadonlySet<string> | null {
  const point = typeof revert === "string" ? parseJson(revert) : isRecord(revert) ? revert : null;
  const list = isRecord(point) && Array.isArray(point["keptMessageIDs"]) ? point["keptMessageIDs"] : null;
  if (list === null) return null;
  return new Set(list.filter((id): id is string => typeof id === "string"));
}

/**
 * 一条会话的消息行（opencode 同形，喂 opencodeToMessages）。消息按 sequence 排序并过
 * rewind 白名单；part 按 sequence 排序后按 message_id 挂回。
 */
export function readZcodeMessages(db: DatabaseSync, sessionId: string): OpencodeMessageRow[] {
  const revertRow = db.prepare("select revert from session where id = ?").get(sessionId) as Record<string, unknown> | undefined;
  const kept = keptMessageIds(revertRow?.["revert"]);
  const partsByMessage = new Map<string, { id: string; data: string }[]>();
  // part.sequence 是 per-message 从 0 重开的（本机实测跨 message 有撞值）——只按 sequence
  // 排在撞值处没有行序契约（冒烟 0 孤儿是 SQLite 恰按扫描序返回的运气），带上 message_id
  // 才把每条消息内部的 part 顺序钉死。message.sequence 则是会话内严格递增，单独够用。
  for (const part of db
    .prepare("select message_id, id, data from part where session_id = ? order by message_id, sequence")
    .iterate(sessionId)) {
    const messageId = part["message_id"];
    if (typeof messageId !== "string") continue;
    const entry = { id: String(part["id"] ?? ""), data: String(part["data"] ?? "") };
    const list = partsByMessage.get(messageId);
    if (list === undefined) partsByMessage.set(messageId, [entry]);
    else list.push(entry);
  }
  const rows: OpencodeMessageRow[] = [];
  for (const message of db.prepare("select id, data from message where session_id = ? order by sequence").iterate(sessionId)) {
    const id = message["id"];
    if (typeof id !== "string") continue;
    if (kept !== null && !kept.has(id)) continue;
    rows.push({ id, data: String(message["data"] ?? ""), parts: partsByMessage.get(id) ?? [] });
  }
  return rows;
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
