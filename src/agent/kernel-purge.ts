/**
 * 删树里的一条会话之后，把它在库文件里的行真的清掉。durable 1.5.2 没有删一条 conversation 的 API（只有 retireDoc），
 * 所以删除分两步：
 * 1. 在 durable 里「摘掉」（kernel.ts 的 KernelPool.forget）：停它的轮、从索引与历史里去掉，再把它用过的会话号记进库旁的
 *    墓碑文件 `<库>.purge.json`（原子写）——从这一刻起没有任何路径还读得到它；
 * 2. 库**没被打开**时（关库之后、下一次打开之前）按墓碑直接在 SQLite 里删行，再 VACUUM（被删的页不留在文件的空闲页里）。
 *
 * 直接动 durable 的表，所以守得很严：只删墓碑里的会话、它们拥有的会话（owner）、它们的条目 / 任务 / 提交 / 文档与修订，
 * 以及这些行在 record_ids 里的登记；**任何留下来的会话还 fork 自要删的会话**（读它的历史）就整次回滚、什么都不删
 * （留着行比删坏一棵树强）。表结构跟着 pi-durable 1.5.2 的 SQLite schema v2（精确锁版本）；升级 durable 时这里要一起看。
 */
import { readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { writeTextAtomic } from "../main/atomic-write.ts";

/** 墓碑文件：库旁边，记着还没清的会话号 */
/** 墓碑文件名的后缀（库文件名 + 它） */
export const PURGE_SUFFIX = ".purge.json";

export function purgeFile(libraryFile: string): string {
  return `${libraryFile}${PURGE_SUFFIX}`;
}

async function readTombstones(libraryFile: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await readFile(purgeFile(libraryFile), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is number => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

/** 追加墓碑（去重） */
export async function addTombstones(libraryFile: string, conversationIds: readonly number[]): Promise<void> {
  const current = await readTombstones(libraryFile);
  await writeTextAtomic(purgeFile(libraryFile), JSON.stringify([...new Set([...current, ...conversationIds])]));
}

/** 从墓碑里摘掉（迁移完成了：那条会话被索引指着，不再是半份） */
export async function removeTombstone(libraryFile: string, conversationId: number): Promise<void> {
  const rest = (await readTombstones(libraryFile)).filter((id) => id !== conversationId);
  if (rest.length === 0) await rm(purgeFile(libraryFile), { force: true });
  else await writeTextAtomic(purgeFile(libraryFile), JSON.stringify(rest));
}

interface PurgeResult {
  conversations: number;
  entries: number;
  tasks: number;
  documents: number;
}

/** 一组 id 拼成 SQL 的 `(?, ?, …)` 与参数 */
function inList(ids: readonly number[]): { sql: string; params: number[] } {
  return { sql: `(${ids.map(() => "?").join(", ")})`, params: [...ids] };
}

function column(db: DatabaseSync, sql: string, params: readonly number[]): number[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => Number((row as Record<string, unknown>)["id"]));
}

/**
 * 按墓碑清行（库必须没被任何 Harness 打开）。没有墓碑 = null（什么都不做）。成功后删墓碑文件。
 * 出错（含「还有会话 fork 自它」的守卫）整次回滚、墓碑留着，抛给调用方记日志——下次再试。
 */
export async function purgeTombstoned(libraryFile: string): Promise<PurgeResult | null> {
  const tombstones = await readTombstones(libraryFile);
  if (tombstones.length === 0) {
    await rm(purgeFile(libraryFile), { force: true });
    return null;
  }
  const db = new DatabaseSync(libraryFile);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      // 要删的会话：墓碑里的 + 它们（或它们的任务）拥有的，直到不再长
      const conversations = new Set(tombstones);
      let tasks: number[] = [];
      for (;;) {
        const ids = [...conversations];
        const c = inList(ids);
        tasks = column(db, `SELECT id FROM tasks WHERE conversation_id IN ${c.sql}`, c.params);
        const owned = column(db, `SELECT id FROM conversations WHERE owner_conversation_id IN ${c.sql}`, c.params);
        const t = inList(tasks);
        const byTask = tasks.length === 0 ? [] : column(db, `SELECT id FROM conversations WHERE owner_task_id IN ${t.sql}`, t.params);
        const before = conversations.size;
        for (const id of [...owned, ...byTask]) conversations.add(id);
        if (conversations.size === before) break;
      }
      // 守卫：留下来的会话还 fork 自要删的（它的历史读得到要删的条目）——不删
      for (const row of db.prepare("SELECT id, record FROM conversations").all()) {
        const id = Number((row as Record<string, unknown>)["id"]);
        if (conversations.has(id)) continue;
        const record = JSON.parse(String((row as Record<string, unknown>)["record"])) as { parent?: { conversationId?: unknown } };
        const parent = Number(record.parent?.conversationId);
        if (conversations.has(parent)) throw new Error(`conversation ${id} is forked from ${parent}, which is being purged`);
      }
      const c = inList([...conversations]);
      const t = inList(tasks);
      const taskDocs = tasks.length === 0 ? "" : ` OR (scope_kind = 'task' AND owner_id IN ${t.sql})`;
      const documents = column(db, `SELECT id FROM documents WHERE (scope_kind = 'conversation' AND owner_id IN ${c.sql})${taskDocs}`, [...c.params, ...(tasks.length === 0 ? [] : t.params)]);
      const entries = column(db, `SELECT id FROM entries WHERE conversation_id IN ${c.sql}`, c.params);
      const submissions = column(db, `SELECT id FROM submissions WHERE conversation_id IN ${c.sql}`, c.params);
      const records = [...conversations, ...entries, ...tasks, ...submissions, ...documents];
      // 分批删（SQLite 的参数个数有上限）
      const remove = (sql: (list: string) => string, ids: readonly number[]): void => {
        for (let at = 0; at < ids.length; at += 500) {
          const chunk = inList(ids.slice(at, at + 500));
          db.prepare(sql(chunk.sql)).run(...chunk.params);
        }
      };
      remove((list) => `DELETE FROM document_revisions WHERE document_id IN ${list}`, documents);
      remove((list) => `DELETE FROM documents WHERE id IN ${list}`, documents);
      remove((list) => `DELETE FROM entries WHERE id IN ${list}`, entries);
      remove((list) => `DELETE FROM submissions WHERE id IN ${list}`, submissions);
      remove((list) => `DELETE FROM tasks WHERE id IN ${list}`, tasks);
      remove((list) => `DELETE FROM conversations WHERE id IN ${list}`, [...conversations]);
      remove((list) => `DELETE FROM record_ids WHERE id IN ${list}`, records);
      db.exec("COMMIT");
      // 被删的页不留在空闲页里（不然文件里还读得到原文）；WAL 一并收回
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await rm(purgeFile(libraryFile), { force: true });
      return { conversations: conversations.size, entries: entries.length, tasks: tasks.length, documents: documents.length };
    } catch (cause) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw cause;
    }
  } finally {
    db.close();
  }
}
