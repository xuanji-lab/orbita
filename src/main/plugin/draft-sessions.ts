/**
 * 「草稿路径 → 最近在哪条会话里做它」的小账本：preview_plugin 成功时记一笔，「正在做」列表据此给出
 * 「回到对话」。只是个**提示**，不是真源——草稿本身就是磁盘上的文件夹；账本丢了 / 会话删了，
 * 列表照样列草稿，只是没有「回到对话」。
 *
 * 一个路径只留最近一次（再 preview 覆盖）；总量封顶（超了丢最旧的），文件不会无限长。
 * 落盘走原子写（临时文件 + rename）；写入串行，并发 preview 不互相覆盖。读不出来（不存在 / 坏 JSON）当空。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";

/** 账本里最多留几条（每个草稿路径一条） */
export const DRAFT_SESSIONS_MAX = 200;

interface Entry {
  sessionId: string;
  at: number;
}

interface DraftSessionsFile {
  version: 1;
  drafts: Record<string, Entry>;
}

export class DraftSessionBook {
  private readonly filePath: string;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(filePath: string, now: () => number = Date.now) {
    this.filePath = filePath;
    this.now = now;
  }

  /** 记「这个草稿最近是这条会话在做」。落盘失败往上抛，调用方决定要不要吞（preview 不该因此失败）。 */
  remember(path: string, sessionId: string): Promise<void> {
    const run = this.queue.then(async () => {
      const book = await this.read();
      book[path] = { sessionId, at: this.now() };
      const keep = Object.entries(book)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, DRAFT_SESSIONS_MAX);
      const file: DraftSessionsFile = { version: 1, drafts: Object.fromEntries(keep) };
      await writeJsonAtomic(this.filePath, file);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** 这个草稿最近一次是哪条会话；没记过为 null。 */
  async sessionOf(path: string): Promise<string | null> {
    await this.queue;
    return (await this.read())[path]?.sessionId ?? null;
  }

  private async read(): Promise<Record<string, Entry>> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) return {};
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return {};
      const drafts = (parsed as Record<string, unknown>)["drafts"];
      if (typeof drafts !== "object" || drafts === null || Array.isArray(drafts)) return {};
      const result: Record<string, Entry> = {};
      for (const [path, value] of Object.entries(drafts)) {
        if (typeof value !== "object" || value === null) continue;
        const { sessionId, at } = value as Record<string, unknown>;
        if (typeof sessionId === "string" && sessionId !== "" && typeof at === "number" && Number.isFinite(at)) result[path] = { sessionId, at };
      }
      return result;
    } catch {
      // 坏 JSON：只是提示账本，当空（下一次 remember 会写出干净的）
      return {};
    }
  }
}
