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
 * ## 意图召回
 * 意图召回（实验功能，DeepSeek / Proma 管线）不是对话型号，不进任务；但它花的是用户自己的 token，
 * 侧栏用量格的每日合计算它（与改之前的日账本一致）。所以账本另记一份「日期 → 意图召回的 token」，
 * 与任务同一套去重、同一次回填。
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
import type { SessionWrapup } from "../../shared/wrapup.ts";
import { stampedThinkingLevel } from "../../shared/session.ts";
import { usageCountsOfIntent } from "../../shared/intent-recall.ts";
import {
  appendTaskRecord,
  chartTasks,
  emptyTaskBook,
  storedDonesOf,
  piThinkingTimeline,
  taskRecordsOf,
  type ChartTask,
  type DayCounts,
  type StoredDone,
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
  /**
   * 3：加了 done（收尾确认的做完的事，价格图的主会话任务）。读到 1 / 2 当坏文件——回填重建，
   * 从各会话 meta.wrapups 补上做完的事（2：加了 intent，意图召回按天）
   */
  version: 3;
  backfilled: boolean;
  untrustedSessions: number;
  tasks: { s: string; p: string; m: string; l: ThinkingLevel | null; d: Record<string, number[]> }[];
  open: Record<string, number>;
  intent: Record<string, number[]>;
  /** 做完的事：s 会话、w 收尾记录 id、p / m / l 归属、t 合计（packDay 同一个 9 数格式） */
  done: { s: string; w: string; p: string; m: string; l: ThinkingLevel; t: number[] }[];
}

export class TaskLedger {
  private readonly file: string;
  private readonly timeZone: string | undefined;
  private book: TaskBook = emptyTaskBook();
  private intent = new Map<string, TokenCounts>();
  private dones: StoredDone[] = [];
  private readonly listeners: (() => void)[] = [];
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
      this.intent = parsed.intent;
      this.dones = parsed.dones;
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
      this.emit();
    });
  }

  /** 记一次意图召回的用量（recorder 落 intent-recall 记录的同一处）。去重与 record 同一张表 */
  recordIntent(item: { id: string; timestamp: number; tokens: TokenCounts }): Promise<void> {
    return this.runSerialized(async () => {
      if (this.seen.has(item.id) || tokenSum(item.tokens) === 0) return;
      this.seen.set(item.id, this.dateKey(item.timestamp));
      this.addIntent(item.timestamp, item.tokens);
      this.changes += 1;
      this.pruneSeen();
      await this.persist();
      this.emit();
    });
  }

  /**
   * 记一次收尾确认（session:wrapup-confirm 落定后）：每件做完的事一个价格图任务。同一个收尾
   * 记录 id 只记一次。不动按天的 token 账——那几轮的 token 早在落盘时记过了。
   */
  recordWrapup(sessionId: string, wrapup: SessionWrapup): Promise<void> {
    return this.runSerialized(async () => {
      if (this.dones.some((done) => done.wrapupId === wrapup.id)) return;
      const added = storedDonesOf(sessionId, wrapup);
      if (added.length === 0) return;
      this.dones.push(...added);
      this.changes += 1;
      await this.persist();
      this.emit();
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
        for (const wrapup of meta.wrapups ?? []) {
          if (this.dones.some((done) => done.wrapupId === wrapup.id)) continue;
          this.dones.push(...storedDonesOf(meta.id, wrapup));
        }
        for (const record of raw) {
          if (record.role !== "intent-recall" || record.usage === undefined || all.has(record.id)) continue;
          const tokens = usageCountsOfIntent(record.usage);
          if (tokenSum(tokens) === 0) continue;
          all.add(record.id);
          this.seen.set(record.id, this.dateKey(record.timestamp));
          this.addIntent(record.timestamp, tokens);
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      this.backfilled = true;
      this.untrusted = untrusted;
      this.changes += 1;
      this.pruneSeen();
      await this.persist();
      this.emit();
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

  /** 收尾确认的做完的事（只读快照） */
  doneTasks(): readonly StoredDone[] {
    return this.dones;
  }

  /** 价格图的任务全集：做完的事 + 每个子会话一件（childIds：哪些会话是子会话） */
  chartTasks(childIds: ReadonlySet<string>): ChartTask[] {
    return chartTasks(this.book.tasks, this.dones, childIds);
  }

  /** 意图召回按天（日期 → token） */
  intentByDay(): ReadonlyMap<string, TokenCounts> {
    return this.intent;
  }

  /** 账面变化（记一条 / 回填完成）后的通知。listener 抛错只记日志，不传染 */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("[task-ledger] 账本变更监听器抛错", error);
      }
    }
  }

  private addIntent(timestamp: number, tokens: TokenCounts): void {
    const date = this.dateKey(timestamp);
    const prev = this.intent.get(date);
    this.intent.set(
      date,
      prev === undefined
        ? { ...tokens }
        : {
            input: prev.input + tokens.input,
            output: prev.output + tokens.output,
            cacheRead: prev.cacheRead + tokens.cacheRead,
            cacheWrite: prev.cacheWrite + tokens.cacheWrite,
          },
    );
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
      version: 3,
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
      intent: Object.fromEntries([...this.intent].map(([date, tokens]) => [date, packTokens(tokens)])),
      done: this.dones.map((done) => ({
        s: done.sessionId,
        w: done.wrapupId,
        p: done.providerId,
        m: done.modelId,
        l: done.level,
        t: packDay(done.totals),
      })),
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

function tokenSum(t: TokenCounts): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
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
): { book: TaskBook; intent: Map<string, TokenCounts>; dones: StoredDone[]; backfilled: boolean; untrusted: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v["version"] !== 3 || !Array.isArray(v["tasks"]) || !Array.isArray(v["done"])) return null;
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
  const intent = new Map<string, TokenCounts>();
  if (typeof v["intent"] === "object" && v["intent"] !== null) {
    for (const [date, packed] of Object.entries(v["intent"] as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Array.isArray(packed) || packed.length !== 4) return null;
      if (!packed.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
      const [input = 0, output = 0, cacheRead = 0, cacheWrite = 0] = packed as number[];
      intent.set(date, { input, output, cacheRead, cacheWrite });
    }
  }
  const dones: StoredDone[] = [];
  for (const entry of v["done"] as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const d = entry as Record<string, unknown>;
    const totals = unpackDay(d["t"]);
    if (typeof d["s"] !== "string" || typeof d["w"] !== "string" || typeof d["p"] !== "string" || typeof d["m"] !== "string") return null;
    if (!isThinkingLevel(d["l"]) || totals === null) return null;
    dones.push({ sessionId: d["s"], wrapupId: d["w"], providerId: d["p"], modelId: d["m"], level: d["l"], totals });
  }
  const untrusted = typeof v["untrustedSessions"] === "number" ? v["untrustedSessions"] : 0;
  return { book: { tasks, open }, intent, dones, backfilled: v["backfilled"] === true, untrusted };
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
