/**
 * 注入记录账本（memory v2）——`<userData>/memory/injections.jsonl`，一行一条
 * MemoryInjectionRecord，只追加。
 *
 * 它是「按轮」的地基：审查面板的记忆页签要按轮倒序说清「这轮注入了什么、蒸出了
 * 什么」，库里的「用过几次 · 最近一次」也从这里数——所以**每轮都落一条（含零命中）**，
 * 没有记录的轮等于不存在，而零命中的轮要说得出「这轮没有注入」。
 *
 * 条数规模：一轮 ≤ 5 条命中 + 常驻摘抄，一行几十字节；一条重度会话几百轮也就
 * 几十 KB，线性扫描对管理面够用（与记忆库本体同一条纪律：语料小，先不做索引）。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryInjectionRecord, MemoryUsage } from "../../shared/memory.ts";
import { isNotFound } from "../fs-errors.ts";

const FILE = "injections.jsonl";

/** 单会话的注入记录上限（防御：账本疯长时旧轮让路，不无限堆）。 */
const PER_SESSION_LIMIT = 500;

/**
 * 一行的宽松校验：id / turn / at 不齐的行跳过（SessionStore 坏行纪律）——
 * 注入记录是推导材料，缺一条的代价是那轮的「注入」显示不出来，不值得炸整页。
 */
export function parseInjectionRecord(value: unknown): MemoryInjectionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const suspect = value as { sessionId?: unknown; turn?: unknown; at?: unknown; hits?: unknown };
  if (typeof suspect.sessionId !== "string" || suspect.sessionId === "") return null;
  if (typeof suspect.turn !== "number" || !Number.isInteger(suspect.turn) || suspect.turn < 1) return null;
  if (typeof suspect.at !== "number" || !Number.isFinite(suspect.at)) return null;
  if (!Array.isArray(suspect.hits)) return null;
  const hits: { id: string; score: number }[] = [];
  for (const hit of suspect.hits) {
    if (typeof hit !== "object" || hit === null) continue;
    const item = hit as { id?: unknown; score?: unknown };
    if (typeof item.id !== "string" || item.id === "") continue;
    if (typeof item.score !== "number" || !Number.isFinite(item.score)) continue;
    hits.push({ id: item.id, score: item.score });
  }
  return { sessionId: suspect.sessionId, turn: suspect.turn, at: suspect.at, hits };
}

export class MemoryUsageStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private get path(): string {
    return join(this.dir, FILE);
  }

  /** 落一条（每轮一条，含零命中）。失败照抛——调用方（轮前召回）自己静默。 */
  async record(entry: MemoryInjectionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /**
   * 全部记录，落盘顺序（旧在前）。文件不存在 = 一条都没有；坏行跳过。
   * **读不了 ≠ 没有**：权限等照抛（同 MemoryStore.list 的纪律）。
   */
  async list(): Promise<MemoryInjectionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (cause) {
      if (isNotFound(cause)) return [];
      throw cause;
    }
    const records: MemoryInjectionRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = parseInjectionRecord(JSON.parse(line));
        if (parsed !== null) records.push(parsed);
      } catch {
        // 半截行：跳过
      }
    }
    return records;
  }

  /** 一个会话的记录，旧在前，只留最近 PER_SESSION_LIMIT 条。 */
  async bySession(sessionId: string): Promise<MemoryInjectionRecord[]> {
    const mine = (await this.list()).filter((record) => record.sessionId === sessionId);
    return mine.length > PER_SESSION_LIMIT ? mine.slice(mine.length - PER_SESSION_LIMIT) : mine;
  }

  /**
   * 每个条目的使用统计：注入次数与最近一次时刻。同一轮里同一条只算一次
   * （防御重复行）；轮号不比大小，直接数。
   */
  async usageOf(): Promise<Map<string, MemoryUsage>> {
    const usage = new Map<string, MemoryUsage>();
    for (const record of await this.list()) {
      for (const hit of record.hits) {
        const current = usage.get(hit.id) ?? { count: 0, lastAt: null };
        usage.set(hit.id, { count: current.count + 1, lastAt: Math.max(current.lastAt ?? 0, record.at) });
      }
    }
    return usage;
  }
}
