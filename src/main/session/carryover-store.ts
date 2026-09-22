/**
 * 遗留事项（carryover）落盘 —— 收尾仪式收割的清单，全局一份 JSONL：
 *
 *   carryovers.jsonl   一行一条 Carryover，读全量 → 合并 → 原子写回
 *
 * 为什么不是 per-session 文件：遗留事项的消费者是**跨会话**的——侧栏面板要按来源
 * 分组列全部、角标要按 sourceSessionId 现算。分文件就得 readdir 再逐个读，而它
 * 的量级（每条会话几条）撑不起那份复杂度。
 *
 * 会话侧只存 `completion` 状态、不内嵌 carryover 正文（避免两处真源）；reopen
 * （回 open）不删不改这些记录——遗留事项是收尾时收割的事实，不随会话状态回滚。
 *
 * 写入链：append / setStatus 都是「读全量 → 改 → 原子写」，与 SessionStore 的
 * meta 写入同一条竞态血脉（原子写只保证单次不撕裂，不保证两次读-改-写不互相
 * 覆盖），所以同样排一条链。全局一份文件 → 一条链，不按会话分。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测（recorder.ts 同款先例）。
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeTextAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import {
  parseCarryover,
  type Carryover,
  type CarryoverDraft,
  type CarryoverStatus,
} from "../../shared/session.ts";

export class CarryoverStore {
  private readonly file: string;
  /** 写入链（见文件头）：append / setStatus 串行化，防读-改-写互相覆盖。 */
  private writes: Promise<unknown> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  /** 全部遗留事项，落盘顺序。文件不存在 = 一条都没有；**读不了 ≠ 没有**（权限等照抛）。坏行跳过。 */
  async list(): Promise<Carryover[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const items: Carryover[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseCarryover(JSON.parse(line));
        if (parsed !== null) items.push(parsed);
      } catch {
        // 半截行：跳过它，前面读到的好行照常返回
      }
    }
    return items;
  }

  /**
   * 批量落盘（收尾仪式确认的那一拨）。读全量 → 追加 → 原子写（临时文件 + rename）。
   * 返回铸好的完整记录（id / status / createdAt / doneAt 由这里定，renderer 不猜）。
   */
  async append(sessionId: string, drafts: readonly CarryoverDraft[]): Promise<Carryover[]> {
    const now = Date.now();
    const created: Carryover[] = drafts.map((draft) => ({
      id: randomUUID(),
      title: draft.title,
      detail: draft.detail,
      sourceSessionId: sessionId,
      sourceMessageRange: draft.sourceMessageRange,
      status: "open",
      createdAt: now,
      doneAt: null,
    }));
    if (created.length === 0) return created;
    return this.runSerialized(async () => {
      const merged = [...(await this.list()), ...created];
      await writeTextAtomic(this.file, `${merged.map((item) => JSON.stringify(item)).join("\n")}\n`);
      return created;
    });
  }

  /**
   * 翻转一条的状态：done 记 doneAt（翻的那一刻），回 open 清掉——doneAt 与
   * status 同进退，不留「open 却带着完成时刻」的半态。id 不存在返回 null（会话
   * 被删时它的 carryover 还在盘上，翻一条已不存在的记录不值得报错）。
   */
  async setStatus(id: string, status: CarryoverStatus): Promise<Carryover | null> {
    return this.runSerialized(async () => {
      const items = await this.list();
      const target = items.find((item) => item.id === id);
      if (target === undefined) return null;
      target.status = status;
      target.doneAt = status === "done" ? Date.now() : null;
      await writeTextAtomic(this.file, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
      return target;
    });
  }

  /** 排进写入链；链上某一环失败不卡死后续写入（吃掉异常的那一支存回去，调用方拿真实结果）。 */
  private runSerialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
