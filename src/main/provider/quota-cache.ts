/**
 * 额度快照的落盘缓存 —— `<userData>/quota-cache.json`，形状
 * `{ [providerId]: { snapshot: QuotaSnapshot } }`。
 *
 * 为什么落盘而不是只放内存：额度是账号级的事实，重启应用之后「上次看到的是多少」
 * 仍然有意义（环菜单要能立刻显示，不做后台轮询）。缓存 key 是 provider id——
 * 同一家的多个会话共享一份（decisions 13）。
 *
 * 读的一侧**永不抛**：文件缺失是首次启动，JSON 坏 / 结构不认是被人手改过或版本回退，
 * 两种都当成空表——一个缓存文件坏掉不该让设置页的额度块整块打不开。
 * 写的一侧走 `writeJsonAtomic`（临时文件 + rename），禁裸 `writeFileSync`。
 *
 * `userData` 由调用方传入（不在模块顶层 `app.getPath`）：这样它能被 `node --test`
 * 直接加载，用临时目录跑真文件系统。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import type { QuotaSnapshot } from "../../shared/quota.ts";

export type QuotaCacheTable = Record<string, QuotaSnapshot>;

function isSnapshot(value: unknown): value is QuotaSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record["fetchedAt"] !== "number" || !Number.isFinite(record["fetchedAt"])) return false;
  if (!Array.isArray(record["windows"])) return false;
  return record["windows"].every((window) => {
    if (typeof window !== "object" || window === null) return false;
    const w = window as Record<string, unknown>;
    return typeof w["id"] === "string" && typeof w["label"] === "string" && typeof w["usedPercent"] === "number";
  });
}

export class QuotaCache {
  private readonly filePath: string;
  /**
   * 一条写入链：每次写都接在上一次之后（读全表 → 合并 → 原子写）。
   *
   * 没有这条链的话，两个 provider 同时刷新会各自读到旧表、各自写回，后落盘的那个
   * 把另一个刚写进去的快照抹掉——症状是「刷新了两家，只有一家记住了」。
   * 链上某次写失败不影响后续（`this.chain` 接的是吞掉错误的版本，调用方拿到的
   * `run` 仍是会 reject 的那个）。
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.filePath = join(dir, "quota-cache.json");
  }

  /** 读全表。文件缺失 / JSON 坏 / 结构不认都当空表，不抛。 */
  async read(): Promise<QuotaCacheTable> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const table: QuotaCacheTable = {};
    for (const [providerId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null) continue;
      const snapshot = (entry as Record<string, unknown>)["snapshot"];
      if (isSnapshot(snapshot)) table[providerId] = snapshot;
    }
    return table;
  }

  /** 写入单个 provider 的最新快照（读-合并-写全程串行）。 */
  write(providerId: string, snapshot: QuotaSnapshot): Promise<void> {
    const run = this.chain.then(async () => {
      const table = await this.read();
      table[providerId] = snapshot;
      await writeJsonAtomic(this.filePath, toFileShape(table));
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** 盘上的形状带一层 `snapshot` 包装：以后要加 `lastFailure` 之类的字段时不用换文件格式 */
function toFileShape(table: QuotaCacheTable): Record<string, { snapshot: QuotaSnapshot }> {
  const out: Record<string, { snapshot: QuotaSnapshot }> = {};
  for (const [providerId, snapshot] of Object.entries(table)) out[providerId] = { snapshot };
  return out;
}
