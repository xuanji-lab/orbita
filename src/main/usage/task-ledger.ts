/**
 * 任务账本 —— 价格 · 能力图（以及将来的侧栏用量格）的数据面。
 *
 *   <userData>/usage-tasks.json   一份全局 JSON：全部任务（会话 × 型号 × 档的连续一段，按天分账）
 *
 * ## 为什么要有它（2026-10-24 用户验收后改）
 * 之前打开设置页才现扫全部原生会话：开发版 137 条、334MB，冷启动约 1.6s，而且是在主进程里
 * 解析 JSONL，会和界面抢事件循环（AGENTS.md「架构边界」）；用户的正式数据只会更大。现在改成
 * **落盘时增量记账**：recorder 每写一条 assistant 记录（与日账本 recordUsage 同一处）就把它记进
 * 这里；升级后第一次启动回填一次（backfilled 标记，与日账本同一个机制）。图只读汇总，不扫会话。
 *
 * ## 口径
 * 切段只有一份实现：task-cost.ts 的 appendTaskRecord，回填与增量走的是同一个函数，所以两条路径
 * 算出同一本账（测试守着）。会话之间互不拼接；子会话是独立会话。
 * - 增量：档用记录上盖的章；没有章（进程刚起还没收到 thinking 事件，理论上不发生）记进档为 null 的段。
 * - 回填：跳过导入会话；按 createdAt 正序扫，分支复制的前缀同一条消息 id 只计第一次；没盖章的旧记录
 *   按 pi 时间线补档，时间线对不上的整条会话记 null 档（计 token，不进图），并数进 untrustedSessions。
 *
 * ## 去重
 * 按 message id，与日账本同一套：seen 表 id → 日期，只留最近 SEEN_WINDOW_DAYS 天（重复写入发生在
 * 分钟级窗口里）。回填用一张全量表去重（分支复制的前缀可能隔了很多天）。
 * **seen 只在内存里，不落盘**（与日账本不同）：要防的重复都发生在同一次运行里——流式重放 / 重试
 * 补写、回填扫描期间又落盘的那几条；重启后 recorder 不会重放旧记录。落盘的话，回填完 seen 里是
 * 最近两周的全部消息 id（开发版约 470KB），每条回复都要整份重写一遍，不值。
 *
 * ## 写入纪律
 * 全部变更走一条写入链（读-改-写互不覆盖），落盘用 writeJsonAtomic。坏文件 / 缺文件 → 空账重来：
 * backfilled 也丢了，回填会重建整本。账本是可以从会话 JSONL 重建的派生数据。
 *
 * **纯模块**：不 import electron，可被 `node --test` 直接测。
 */
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";
import { todayKey } from "../../shared/usage.ts";
import { isThinkingLevel, type ThinkingLevel } from "../../shared/thinking.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";
import { stampedThinkingLevel } from "../../shared/session.ts";
import {
  appendTaskRecord,
  emptyTaskBook,
  piThinkingTimeline,
  taskRecordsOf,
  type DayCounts,
  type StoredTask,
  type TaskBook,
  type TaskRecord,
  type TokenCounts,
} from "./task-cost.ts";

const SEEN_WINDOW_DAYS = 14;

/** 回填的数据源（SessionStore 的结构子集 + 读 pi 本子） */
export interface TaskBackfillSource {
  list(): Promise<SessionMeta[]>;
  readRawLog(id: string): Promise<SessionRecord[]>;
  /** 读 pi 本子全文；不存在 / 读不了返回 null */
  readPiFile(path: string): Promise<string | null>;
}

/** 回填的统计（日志用） */
export interface BackfillStats {
  sessions: number;
  untrustedSessions: number;
  ms: number;
}

/**
 * 盘上形状。为了文件小，一天的账压成 9 个数：
 * [input, output, cacheRead, cacheWrite, recordedCost, 零价 input, 零价 output, 零价 cacheRead, 零价 cacheWrite]
 * （见 packDay）。任务按下标存，open 指向下标。
 */
interface LedgerOnDisk {
  version: 1;
  backfilled: boolean;
  untrustedSessions: number;
  tasks: { s: string; p: string; m: string; l: ThinkingLevel | null; d: Record<string, number[]> }[];
  open: Record<string, number>;
}

export class TaskLedger {
  private readonly file: string;
  private readonly timeZone: string | undefined;
  private book: TaskBook = emptyTaskBook();
  private seen = new Map<string, string>();
  private backfilled = false;
  private untrusted = 0;
  private writes: Promise<unknown> = Promise.resolve();
  /** 账面每变一次加一：图的请求按它判断上次算好的结果还能不能直接用 */
  private changes = 0;

  /**
   * 记录时刻 → 本地日期键，与 shared/usage 的 localDateKey 同一个格式（en-CA = YYYY-MM-DD）。
   * 格式化器只建一次：localDateKey 每次调用都新建一个，回填一万多条记录时光这一项就占了约 3 秒。
   */
  private readonly dateFormat: Intl.DateTimeFormat;

  constructor(file: string, options?: { timeZone?: string }) {
    this.file = file;
    this.timeZone = options?.timeZone;
    this.dateFormat = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
    });
  }

  private dateKey = (timestamp: number): string => this.dateFormat.format(new Date(timestamp));

  /** 读盘。坏文件当没有（空账、backfilled=false），回填会重建 */
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
        console.error("[task-ledger] 任务账本解析失败，按空账重建（回填会扫一遍会话）");
        return;
      }
      this.book = parsed.book;
      this.backfilled = parsed.backfilled;
      this.untrusted = parsed.untrusted;
    });
  }

  /**
   * 记一条 assistant 记录（recorder 在落盘的同一条路径上调）。重复的 message id 跳过；
   * 记了才写盘。
   */
  record(sessionId: string, item: TaskRecord): Promise<void> {
    return this.runSerialized(async () => {
      if (this.seen.has(item.id)) return;
      this.seen.set(item.id, this.dateKey(item.timestamp));
      appendTaskRecord(this.book, sessionId, item, this.dateKey);
      this.changes += 1;
      this.pruneSeen();
      await this.persist();
    });
  }

  /**
   * 第一次运行（或账本损坏重建）：扫全部非导入会话，按 createdAt 正序把 assistant 记录喂进账本，
   * 然后落 backfilled 标记——之后启动不再扫。与 record 同一条写入链：扫描期间新落盘的消息排在
   * 扫描后面，seen 表保证同一条只计一次。每扫完一条会话让一次事件循环，不长时间占着主进程。
   */
  backfill(source: TaskBackfillSource): Promise<BackfillStats | null> {
    return this.runSerialized(async () => {
      if (this.backfilled) return null;
      const started = Date.now();
      const all = new Set<string>(this.seen.keys());
      const metas = (await source.list())
        .filter((meta) => meta.importedFrom === undefined)
        .sort((a, b) => a.createdAt - b.createdAt);
      let sessions = 0;
      let untrusted = 0;
      for (const meta of metas) {
        const raw = await source.readRawLog(meta.id);
        const needsTimeline = raw.some(
          (r) => r.role === "assistant" && r.usage !== undefined && stampedThinkingLevel(r) === undefined,
        );
        const piText =
          needsTimeline && meta.piSessionFile !== null ? await source.readPiFile(meta.piSessionFile) : null;
        const records = taskRecordsOf(raw, piText === null ? [] : piThinkingTimeline(piText), meta.thinkingLevel);
        if (records.length > 0) sessions += 1;
        if (records.some((r) => r.level === undefined)) untrusted += 1;
        for (const item of records) {
          if (all.has(item.id)) continue;
          all.add(item.id);
          this.seen.set(item.id, this.dateKey(item.timestamp));
          appendTaskRecord(this.book, meta.id, item, this.dateKey);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.backfilled = true;
      this.untrusted = untrusted;
      this.changes += 1;
      this.pruneSeen();
      await this.persist();
      return { sessions, untrustedSessions: untrusted, ms: Date.now() - started };
    });
  }

  /** 等写入链上已排的任务（含回填）都落定：图的首次请求可能赶上回填在途 */
  settled(): Promise<void> {
    return this.runSerialized(async () => undefined);
  }

  /** 全部任务（只读快照）。不排写入链：变更块是同步的，两次链任务之间内存总是整份一致 */
  tasks(): readonly StoredTask[] {
    return this.book.tasks;
  }

  /** 账面版本：每记一条 / 回填完成加一（load 读盘不算——那之前不会有人来要图） */
  version(): number {
    return this.changes;
  }

  /** 回填时时间线对不上、记成 null 档的会话数（日志与 PR 描述用） */
  untrustedSessions(): number {
    return this.untrusted;
  }

  private pruneSeen(): void {
    const floor = shiftDateKey(todayKey(Date.now(), this.timeZone), -SEEN_WINDOW_DAYS);
    for (const [id, date] of this.seen) {
      if (date < floor) this.seen.delete(id);
    }
  }

  private async persist(): Promise<void> {
    const file: LedgerOnDisk = {
      version: 1,
      backfilled: this.backfilled,
      untrustedSessions: this.untrusted,
      tasks: this.book.tasks.map((task) => ({
        s: task.sessionId,
        p: task.providerId,
        m: task.modelId,
        l: task.level,
        d: Object.fromEntries(Object.entries(task.days).map(([date, day]) => [date, packDay(day)])),
      })),
      open: Object.fromEntries(this.book.open),
    };
    await writeJsonAtomic(this.file, file);
  }

  private runSerialized<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run, run);
    this.writes = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function packTokens(t: TokenCounts): number[] {
  return [t.input, t.output, t.cacheRead, t.cacheWrite];
}

function packDay(day: DayCounts): number[] {
  return [...packTokens(day.tokens), day.recordedCost, ...packTokens(day.unpricedTokens)];
}

function unpackDay(raw: unknown): DayCounts | null {
  if (!Array.isArray(raw) || raw.length !== 9) return null;
  if (!raw.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  const n = raw as number[];
  const tokens = (o: number): TokenCounts => ({
    input: n[o] ?? 0,
    output: n[o + 1] ?? 0,
    cacheRead: n[o + 2] ?? 0,
    cacheWrite: n[o + 3] ?? 0,
  });
  return { tokens: tokens(0), recordedCost: n[4] ?? 0, unpricedTokens: tokens(5) };
}

/** 解析盘上文件；形状不对返回 null（按空账重建）。坏任务逐条跳过会让 open 的下标错位，所以任务坏一条就整本重建 */
function parseLedgerFile(
  raw: string,
): { book: TaskBook; backfilled: boolean; untrusted: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 1 || !Array.isArray(v["tasks"])) return null;
  const tasks: StoredTask[] = [];
  for (const entry of v["tasks"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const t = entry as Record<string, unknown>;
    const level = t["l"];
    if (typeof t["s"] !== "string" || typeof t["p"] !== "string" || typeof t["m"] !== "string") return null;
    if (level !== null && !isThinkingLevel(level)) return null;
    if (typeof t["d"] !== "object" || t["d"] === null) return null;
    const days: Record<string, DayCounts> = {};
    for (const [date, packed] of Object.entries(t["d"] as Record<string, unknown>)) {
      const day = unpackDay(packed);
      if (day === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      days[date] = day;
    }
    tasks.push({ sessionId: t["s"], providerId: t["p"], modelId: t["m"], level, days });
  }
  const open = new Map<string, number>();
  if (typeof v["open"] === "object" && v["open"] !== null) {
    for (const [session, at] of Object.entries(v["open"] as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isInteger(at) && at >= 0 && at < tasks.length) open.set(session, at);
    }
  }
  const untrusted = typeof v["untrustedSessions"] === "number" ? v["untrustedSessions"] : 0;
  return { book: { tasks, open }, backfilled: v["backfilled"] === true, untrusted };
}

/** 日期键平移 n 天（与日账本同一写法） */
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
