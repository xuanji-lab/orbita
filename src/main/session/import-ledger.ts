/**
 * 导入清单 `<userData>/imports.jsonl`：每次导入、每条会话追加一行——什么时候、从哪个来源的
 * 哪个文件、落成了 orbita 的哪条会话、是新导入还是追加（wafo 2026-09-24：再次导入时要有一份
 * 「上次导了什么」的清单可对照）。纯 node 模块，不 import electron。
 *
 * **它只记历史，不判重。** 「这条现在在不在 orbita」仍以会话 meta 的 importedFrom 为准；清单
 * 回答的是 meta 回答不了的那一个问题：**导过、后来在 orbita 删了**的会话（meta 随会话一起删了）。
 * 所以清单写失败只退化成「删过的会话被当成新的列出来」，不会丢数据，也不会重复导入。
 *
 * 只追加、不改写：一次导入一次 appendFile。坏行跳过（与会话日志同一条纪律），一行坏不影响其余。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isImportSourceId, type ImportSourceId } from "../../shared/import.ts";
import { isNotFound } from "../fs-errors.ts";

export interface ImportLedgerLine {
  /** 导入的时刻；null = 清单出现之前导入的会话，第一次写清单时补记（当时的时刻已不可考） */
  at: number | null;
  /** import = 新落盘（含删过后重新导入）；update = 追加新消息；copy = 两边都聊了、另导一份；backfill = 补记 */
  action: "import" | "update" | "copy" | "backfill";
  source: ImportSourceId;
  /** 来源里的会话 id；补记的行不知道（meta 只存了源文件）为 null */
  sourceId: string | null;
  sourceFile: string;
  /** 落成的 orbita 会话 id */
  sessionId: string;
  /** 导入时的标题——清单是给人对照的，只有 id 看不出是哪条 */
  title: string;
}

const ACTIONS: readonly string[] = ["import", "update", "copy", "backfill"] satisfies readonly ImportLedgerLine["action"][];

function parseLine(value: unknown): ImportLedgerLine | null {
  if (typeof value !== "object" || value === null) return null;
  const line = value as Record<string, unknown>;
  const at = line["at"];
  const action = line["action"];
  const sourceId = line["sourceId"];
  const source = line["source"];
  if (at !== null && (typeof at !== "number" || !Number.isFinite(at))) return null;
  if (typeof action !== "string" || !ACTIONS.includes(action)) return null;
  if (!isImportSourceId(source)) return null;
  if (sourceId !== null && typeof sourceId !== "string") return null;
  if (typeof line["sourceFile"] !== "string" || typeof line["sessionId"] !== "string") return null;
  return {
    at,
    action: action as ImportLedgerLine["action"],
    source,
    sourceId,
    sourceFile: line["sourceFile"],
    sessionId: line["sessionId"],
    title: typeof line["title"] === "string" ? line["title"] : "",
  };
}

/** 读清单。文件不存在 = 从没导过；读不了（权限等）照抛——「读不了」不是「没有」。 */
export async function readImportLedger(path: string): Promise<ImportLedgerLine[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const lines: ImportLedgerLine[] = [];
  for (const text of raw.split("\n")) {
    if (text.trim() === "") continue;
    try {
      const line = parseLine(JSON.parse(text));
      if (line !== null) lines.push(line);
    } catch {
      // 断电写了半行：跳过这一行
    }
  }
  return lines;
}

/** 一次导入的全部行一次写入。 */
export async function appendImportLedger(path: string, lines: readonly ImportLedgerLine[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(""), "utf8");
}
