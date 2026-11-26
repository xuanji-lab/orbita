/**
 * 发件箱的落盘（shared/outbox.ts 是契约）：`<userData>/outbox.json`，原子写（临时文件 + rename）。
 * 写入串行（一条链）：连发几句时不会互相覆盖。读失败当空——它是兜底，不该拖垮发送。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTBOX_MAX, parseOutbox, type OutboxEntry } from "../../shared/outbox.ts";
import { writeJsonAtomic } from "../atomic-write.ts";

export class OutboxStore {
  private readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = join(dir, "outbox.json");
  }

  async list(): Promise<OutboxEntry[]> {
    try {
      return parseOutbox(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return [];
    }
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  put(entry: OutboxEntry): Promise<void> {
    return this.queue(async () => {
      const entries = (await this.list()).filter((each) => each.id !== entry.id);
      entries.push(entry);
      await writeJsonAtomic(this.file, { entries: entries.slice(-OUTBOX_MAX) });
    });
  }

  remove(id: string): Promise<void> {
    return this.queue(async () => {
      const entries = await this.list();
      const left = entries.filter((each) => each.id !== id);
      if (left.length !== entries.length) await writeJsonAtomic(this.file, { entries: left });
    });
  }
}

