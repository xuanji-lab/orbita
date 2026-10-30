/**
 * 面板打开次数的落盘（契约在 shared/panel-usage.ts）。纯 node，不 import electron，
 * `node --test` 直接测。
 *
 * 一个小 JSON（`<userData>/panel-usage.json`），整份原子写（临时文件 + rename）。
 * 记账串行：连着打开两个面板时两次 bump 不会读到同一份旧值互相覆盖。文件坏了 / 不在
 * 就从现在重新数（since 跟着变），下一次记账把坏文件覆盖掉——这是一份「看个大概」的
 * 统计，不值得为一份坏文件拦住记账。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import {
  bumpPanelUsage,
  parsePanelUsage,
  type PanelUsageKey,
  type PanelUsageSnapshot,
} from "../../shared/panel-usage.ts";

export class PanelUsageStore {
  private readonly file: string;
  private readonly now: () => number;
  private loaded: Promise<PanelUsageSnapshot> | null = null;
  /** 记账队列：每次 bump 接在上一次后面 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  get(): Promise<PanelUsageSnapshot> {
    this.loaded ??= readFile(this.file, "utf8")
      .then((text): unknown => JSON.parse(text))
      .catch((): unknown => null)
      .then((raw) => parsePanelUsage(raw, this.now()));
    return this.loaded;
  }

  bump(key: PanelUsageKey): Promise<PanelUsageSnapshot> {
    const next = this.queue.then(async () => {
      const updated = bumpPanelUsage(await this.get(), key);
      await writeJsonAtomic(this.file, updated);
      this.loaded = Promise.resolve(updated);
      return updated;
    });
    // 一次写失败不拖垮后面的记账（磁盘满、权限……）：下一次照样从内存里的那份往上加
    this.queue = next.catch(() => undefined);
    return next;
  }
}
