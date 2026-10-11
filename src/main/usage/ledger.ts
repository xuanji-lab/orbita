/**
 * 每日 token 用量账本 —— 主进程侧的数据面（IPC 四层的第 2 层身后）。
 *
 *   <userData>/usage-daily.json   一份全局 JSON：日期 → 当日 token，外加去重表
 *
 * ## 口径（与 shared/usage.ts 的契约一致）
 * - 「总 token」= input + output + cacheRead + cacheWrite（usageTotalOf）。
 * - **按 assistant 记录落账**：只有真正写进会话 transcript 的模型调用才计数。
 *   标题生成、导入问候分类、连接探测、上下文压缩都是真实的 LLM 调用，但它们
 *   不产生 transcript 里的 assistant 记录——天然不计（这是产品口径：界面上
 *   看得见的对话才算「在 orbita 发生的用量」；压缩的 token 仍由 pi 的会话
 *   统计计）。
 * - **导入会话不算**：meta.importedFrom 有值的会话，历史 token 花在别的应用；
 *   在 orbita 里续跑产生的新记录照常计（它们走 record 落盘路径，不在回填里）。
 * - **回退（revert）不扣减**：撤回一轮不退钱，账本保留已花的量。被否决的方案：
 *   回退时按 targetMessageId 反查扣回——复杂度高，且「钱花了」与「对话还在」
 *   本来就是两本账。
 * - 子会话是普通会话，照常计。
 *
 * ## 去重
 * 同一条消息可能不止一次经过落盘路径（流式重放、重试补写、分支复制的历史），
 * 按 **message id** 去重：`seen` 表 id → 计入的日期。分支（branch）复制出的
 * 前缀带着同样的 message id，回填扫描时因此只计一次。seen 只留最近
 * SEEN_WINDOW_DAYS 天——重复写入总发生在分钟级窗口里，常驻全量 id 表只是
 * 让文件无限长。
 *
 * ## 写入纪律
 * - 全部变更走**一条写入链**（读-改-原子写互相覆盖的问题，SessionStore 的
 *   queueMeta 同源），落盘用 writeJsonAtomic（临时文件 + rename，禁裸写）。
 * - 坏文件 / 缺文件 → 空账本重来：backfilled 标记也丢了，回填会重建整本账。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测（recorder.ts 同款先例）。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import {
  dateKeysBack,
  localDateKey,
  todayKey,
  usageTotalOf,
  type UsageCounts,
  type UsageDayTotal,
} from "../../shared/usage.ts";
import { isEmptyErrorAssistant } from "../session/store.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";

/** 侧栏显示的天数（含今天） */
export const USAGE_WEEK_DAYS = 7;

/** 去重表保留窗口（天）：重复写入发生在分钟级，两周绰绰有余，文件不再无限长 */
const SEEN_WINDOW_DAYS = 14;

/** days 保留窗口（天）：界面只看 7 天，多留些是给将来的更长视图留的余地 */
const DAYS_WINDOW_DAYS = 90;

/** 回填的数据源（SessionStore 的结构子集——不硬耦合类，测试可自备夹具） */
export interface UsageBackfillSource {
  list(): Promise<SessionMeta[]>;
  readRawLog(id: string): Promise<SessionRecord[]>;
}

/** 一条要落账的消息：assistant 记录里与用量有关的三个字段 */
export interface UsageSource {
  id: string;
  timestamp: number;
  usage: UsageCounts;
}

/** 盘上文件的形状（version 1；days / seen 在内存里是 Map，只在序列化瞬间是普通对象） */
interface LedgerOnDisk {
  version: 1;
  backfilled: boolean;
  days: Record<string, number>;
  seen: Record<string, string>;
}

/** 解析后的内存形状 */
interface LedgerState {
  backfilled: boolean;
  days: Map<string, number>;
  seen: Map<string, string>;
}

export class UsageLedger {
  private readonly file: string;
  /** 计算日期键用的时区；缺省系统时区。注入只为测试复现跨午夜 */
  private readonly timeZone: string | undefined;
  private days = new Map<string, number>();
  private seen = new Map<string, string>();
  private backfilled = false;
  /** 写入链：load / recordUsage / backfill 串行化，防读-改-写互相覆盖 */
  private writes: Promise<unknown> = Promise.resolve();
  private readonly listeners: ((days: UsageDayTotal[]) => void)[] = [];

  constructor(file: string, options?: { timeZone?: string }) {
    this.file = file;
    this.timeZone = options?.timeZone;
  }

  /**
   * 读盘。**坏文件当没有**（空账本、backfilled=false）：账本是可以从会话 JSONL
   * 重建的派生数据，坏一半时与其挑着信一半，不如让回填重建整本。
   * 调用一次即可（主进程启动时）；文件不存在 = 第一次运行，同样走回填。
   */
  load(): Promise<void> {
    return this.runSerialized(async () => {
      let raw: string;
      try {
        raw = await readFile(this.file, "utf8");
      } catch (cause) {
        if (isNotFound(cause)) return;
        throw cause;
      }
      const parsed = parseLedgerFile(raw);
      if (parsed === null) {
        console.error("[usage] 日账本文件解析失败，按空账本重建（回填会扫一遍会话）");
        return;
      }
      this.days = parsed.days;
      this.seen = parsed.seen;
      this.backfilled = parsed.backfilled;
    });
  }

  /**
   * 记一条模型调用的用量（recorder 在 assistant 记录落盘的同一条路径上调）。
   * 重复 id 直接跳过；四项全 0 的记录（provider 没报 usage）也跳过——
   * 计 0 不改变账面，不值得为此写一次盘。
   */
  recordUsage(item: UsageSource): Promise<void> {
    return this.runSerialized(async () => {
      if (!this.absorb(item)) return;
      this.prune();
      await this.persist();
      this.emit();
    });
  }

  /**
   * 首次运行（或账本损坏重建）：扫全部**非导入**会话的原始 JSONL，把带用量的
   * assistant 记录灌进账本，然后落 backfilled 标记——标记在文件里，之后启动
   * 不再扫。与 recordUsage 同一条写入链：扫描期间新落账的消息排在扫描后面，
   * seen 表保证同一条只计一次（扫描读到它就由扫描计，没读到就由落账计）。
   *
   * 回退轮次**照计**（readRawLog 是原始全量，不折叠 revert 界碑）——钱花了。
   */
  backfill(sessions: UsageBackfillSource): Promise<void> {
    return this.runSerialized(async () => {
      if (this.backfilled) return;
      for (const meta of await sessions.list()) {
        // 导入会话：那些 token 花在别的应用，不进 orbita 的账
        if (meta.importedFrom !== undefined) continue;
        const records = await sessions.readRawLog(meta.id);
        for (const record of records) {
          const item = usageSourceOf(record);
          if (item !== null) this.absorb(item);
        }
      }
      this.backfilled = true;
      this.prune();
      await this.persist();
      this.emit();
    });
  }

  /**
   * 最近 7 天（含今天，旧的在前，缺的天补 0）。**不排写入链**：内存快照在两次
   * 链任务之间总是整份一致的（变更块是同步的），排队反而会被在途的回填卡住——
   * 启动时回填可能扫几百个会话，初始拉取不该等它（界面先画空格，回填完由
   * usage:event 推真值）。
   */
  week(): UsageDayTotal[] {
    const keys = dateKeysBack(USAGE_WEEK_DAYS, Date.now(), this.timeZone);
    return keys.map((date) => ({ date, tokens: this.days.get(date) ?? 0 }));
  }

  /** 账本变化（落账 / 回填完成）后的推送注册。listener 抛错只记日志，不传染 */
  onChange(listener: (days: UsageDayTotal[]) => void): void {
    this.listeners.push(listener);
  }

  /** 计入一条（去重），返回是否真的改了账面 */
  private absorb(item: UsageSource): boolean {
    if (this.seen.has(item.id)) return false;
    const total = usageTotalOf(item.usage);
    if (total <= 0) return false;
    const date = localDateKey(item.timestamp, this.timeZone);
    this.seen.set(item.id, date);
    this.days.set(date, (this.days.get(date) ?? 0) + total);
    return true;
  }

  /** 按今天的键修剪两个窗口：seen 14 天、days 90 天（YYYY-MM-DD 字典序即日期序） */
  private prune(): void {
    const today = todayKey(Date.now(), this.timeZone);
    const seenFloor = shiftDateKey(today, -SEEN_WINDOW_DAYS);
    const daysFloor = shiftDateKey(today, -DAYS_WINDOW_DAYS);
    for (const [id, date] of this.seen) {
      if (date < seenFloor) this.seen.delete(id);
    }
    for (const date of this.days.keys()) {
      if (date < daysFloor) this.days.delete(date);
    }
  }

  private async persist(): Promise<void> {
    const file: LedgerOnDisk = {
      version: 1,
      backfilled: this.backfilled,
      days: Object.fromEntries(this.days),
      seen: Object.fromEntries(this.seen),
    };
    await writeJsonAtomic(this.file, file);
  }

  private emit(): void {
    const days = this.week();
    for (const listener of this.listeners) {
      try {
        listener(days);
      } catch (error) {
        console.error("[usage] 账本变更监听器抛错", error);
      }
    }
  }

  /** 排进写入链；链上某一环失败不卡死后续写入（吃掉异常的那一支存回去，调用方拿真实结果） */
  private runSerialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** 日期键平移 n 天（YYYY-MM-DD 走 UTC 锚点，n 可为负；溢出交给 Date 进位） */
function shiftDateKey(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return key;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d + days)));
}

/**
 * 一条 transcript 记录里拿出可落账的用量：assistant、带 usage、且不是
 * 「空 error 回答」（auto_retry 的失败尝试——正常不带 usage，谓词收敛在
 * store.ts，落盘侧不收它，这里同样跳过，两侧一个标准）。
 */
function usageSourceOf(record: SessionRecord): UsageSource | null {
  if (record.role !== "assistant" || record.usage === undefined) return null;
  if (isEmptyErrorAssistant(record)) return null;
  return { id: record.id, timestamp: record.timestamp, usage: record.usage };
}

/** 解析盘上文件；形状不对返回 null（调用方按空账本处理）。坏键 / 坏值逐个跳过，不连带丢整本 */
function parseLedgerFile(raw: string): LedgerState | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1 || typeof v["days"] !== "object" || typeof v["seen"] !== "object") return null;
  if (v["days"] === null || v["seen"] === null) return null;
  const days = new Map<string, number>();
  for (const [key, tokens] of Object.entries(v["days"] as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) continue;
    days.set(key, tokens);
  }
  const seen = new Map<string, string>();
  for (const [id, date] of Object.entries(v["seen"] as Record<string, unknown>)) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    seen.set(id, date);
  }
  return { backfilled: v["backfilled"] === true, days, seen };
}
