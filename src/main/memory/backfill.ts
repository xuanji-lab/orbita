/**
 * 补蒸编排（主进程）——「从历史生成记忆」的任务状态机与执行循环。
 *
 * 职责切分（AGENTS.md 的架构边界）：
 * - **主进程**：读会话存储切轮、算预估、管任务状态（start / pause / resume /
 *   cancel / status）、逐轮落盘与冲突自动拍板、推进度事件。不做模型调用。
 * - **agent utility 进程**：蒸馏本身（backfillDistill 命令，src/agent/backfill-distill.ts）。
 *
 * 冲突自动拍板（用户裁决）：补蒸按时间从旧到新跑，历史已经发生——**时间晚的就是
 * 结论**，蒸馏给出 supersedes 且候选有效时一律按「replace」落（旧条目保留、标已被
 * 替代、可撤销），计数进 replaced。不弹冲突卡：那是对着「正在进行的对话」的设计，
 * 对着几百轮历史逐条点拍板是把导入做成苦役。
 *
 * 重试纪律：一轮最多 3 次尝试（首次 + 2 次重试），指数退避（2s → 8s），退避靠
 * 「重排到队尾 + notBefore 门」实现而不是专职定时器——暂停 / 取消在等待间隙立即
 * 生效。3 次仍失败计 failedTurns 跳过（下次补蒸再试）；连续 8 轮蒸不成把整个任务
 * 置为 failed——那说明家务活模型 / 密钥 / 网络整条链路坏了，继续烧调用没有意义。
 *
 * **模块不 import electron**（窗口广播是注入的依赖），可被 `node --test` 直接测。
 */
import { readFile } from "node:fs/promises";
import type {
  ChoreModelPayload,
  MemoryBackfillTurnInput,
  MemoryBackfillTurnResult,
  ProviderSecrets,
} from "../../shared/agent-ipc.ts";
import {
  MEMORY_BACKFILL_RANGES,
  MEMORY_GLOBAL_SCOPE,
  type MemoryBackfillEstimate,
  type MemoryBackfillRange,
  type MemoryBackfillStatus,
  type MemoryDraft,
} from "../../shared/memory.ts";
import type { ChannelKey, ChannelMessage } from "../../shared/channel.ts";
import { isChannelMarkRecord, type SessionMeta, type SessionRecord } from "../../shared/session.ts";
import { dedupeById, isRecallable } from "./requests.ts";
import type { DistilledTurnLedger } from "./backfill-ledger.ts";
import { backfillEstimateOf, collectSessionTurns, rangeStart, type BackfillTurn } from "./backfill-turns.ts";
import { memoryScopeOf, type MemoryStore } from "./store.ts";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isNotFound } from "../fs-errors.ts";

/* ---------- 常量（测试与编排共用同一份真相） ---------- */

/** 一批并发发给 agent 进程的轮数（agent 侧同限 3：再大容易撞家务活模型的限流）。 */
export const BACKFILL_BATCH = 3;
/** 一轮最多尝试几次（首次 + 重试）。 */
export const BACKFILL_MAX_ATTEMPTS = 3;
/** 指数退避的基准（attempt 从 1 起：2s → 8s）。 */
export const BACKFILL_BACKOFF_BASE_MS = 2_000;
/** 连续多少轮蒸不成就把任务置为 failed。 */
export const BACKFILL_CONSECUTIVE_FAIL_LIMIT = 8;
/** 退避等待的轮询片（暂停 / 取消在这间隙立即生效）。 */
const WAIT_SLICE_MS = 1_000;

/** 第 attempt 次失败后的退避毫秒（指数）。 */
export function backoffDelayMs(attempt: number): number {
  return BACKFILL_BACKOFF_BASE_MS * 4 ** Math.max(0, attempt - 1);
}

/** 入参校验：renderer 过来的是不可信数据，范围只认契约四选一。 */
export function parseBackfillRange(raw: unknown): MemoryBackfillRange {
  const range = typeof raw === "object" && raw !== null ? (raw as { range?: unknown }).range : raw;
  if (typeof range === "string" && (MEMORY_BACKFILL_RANGES as readonly string[]).includes(range)) {
    return range as MemoryBackfillRange;
  }
  throw new Error('memory backfill needs a range of "1m" | "3m" | "6m" | "all"');
}

/* ---------- 依赖（全部最小只读 / 最小调用视图，测试给 stub） ---------- */

/** 会话存储的最小只读视图（read-task.ts 的 SessionStoreReader 同一条纪律）。 */
export interface BackfillSessionReader {
  list(): Promise<SessionMeta[]>;
  load(id: string): Promise<{ meta: SessionMeta; transcript: SessionRecord[] } | null>;
}

/** 通道账本的最小只读视图（通道标记轮的正文来源）。 */
export interface BackfillChannelReader {
  load(key: ChannelKey): Promise<ChannelMessage[]>;
}

/** 模型装配（密钥面在主进程解好才发 agent 进程，开轮命令同一条纪律）。 */
export interface BackfillModelSource {
  /** 家务活模型（设置里的 choreModel）；没配 / 装配失败 = undefined */
  readChoreModel(): Promise<{ provider: ProviderSecrets; modelId: string } | undefined>;
  /** 会话自己的模型（choreModel 缺席时的退路）；解析失败抛 */
  resolveProvider(providerId: string): Promise<ProviderSecrets>;
}

/** agent 进程的批量蒸馏问答（AgentHostCore.backfillDistill 的最小视图）。 */
export interface BackfillDistillCaller {
  backfillDistill(
    turns: readonly MemoryBackfillTurnInput[],
    choreModel?: ChoreModelPayload,
  ): Promise<MemoryBackfillTurnResult[]>;
}

export interface MemoryBackfillDeps {
  sessions: BackfillSessionReader;
  channels: BackfillChannelReader;
  memory: MemoryStore;
  ledger: DistilledTurnLedger;
  models: BackfillModelSource;
  distill: BackfillDistillCaller;
  /** 实验开关「会话记忆」开着没有（start / resume 的门）。 */
  isMemoryEnabled(): Promise<boolean>;
  /** 进度推送（memoryBackfillEvent 的载荷，每蒸完一轮一次）。 */
  broadcast(status: MemoryBackfillStatus): void;
  now(): number;
  /** 任务状态的持久化路径（memory/backfill-state.json）。 */
  stateFile: string;
  /** 退避毫秒（attempt → ms）；缺省 backoffDelayMs。测试注 0 关掉等待。 */
  backoffMs?: (attempt: number) => number;
}

/* ---------- 计划收集（estimate 与 start / resume 共用） ---------- */

/**
 * 收集计划：范围内待蒸的轮（全局按时间从旧到新）+ 已蒸跳过数 + 字符量。
 *
 * 子会话（有父的委派会话）不补蒸：它的产出经通道回流进父会话，父侧蒸过。
 * 归档会话、导入会话都包括——「历史」按用户的账算，不按活跃算。
 * 单条会话读不了只跳过那条（记日志），不拦整个预估 / 任务。
 *
 * 会话间小并发读（8 路）：几百条会话的预估要一两秒内给出（契约原话），
 * 串行读盘时还娜娅 2 秒+，瓶颈是逐文件 IO 而不是解析。
 */
export interface BackfillPlan {
  turns: BackfillTurn[];
  skippedTurns: number;
  chars: number;
  /**
   * choreModel 缺席时各会话的退路模型（密钥面已装配），按 sessionId 索引。
   * **解析不出模型的会话（导入会话的占位 provider 等）不进 turns**——它们的轮
   * 每次尝试都必然失败，排在队首会触发连续失败熔断、把整个任务打死；预估与
   * 执行同口径地排除，配好家务活模型后它们自然回来。
   */
  fallbacks: Map<string, { provider: ProviderSecrets; modelId: string }>;
}

export async function collectBackfillPlan(
  deps: Pick<MemoryBackfillDeps, "sessions" | "channels" | "ledger" | "models">,
  range: MemoryBackfillRange,
  now: number,
): Promise<BackfillPlan> {
  const since = rangeStart(range, now);
  const metas = (await deps.sessions.list()).filter((meta) => meta.parentId === undefined);
  const chore = await deps.models.readChoreModel();
  // 退路模型按 providerId 装配一次整批复用；解析失败记 null（该会话被排除）
  const providerCache = new Map<string, ProviderSecrets | null>();
  const resolveFallback = async (providerId: string): Promise<ProviderSecrets | null> => {
    if (!providerCache.has(providerId)) {
      providerCache.set(
        providerId,
        await deps.models.resolveProvider(providerId).catch((cause: unknown) => {
          console.error("[memory:backfill] 会话模型装配失败（没配家务活模型时这类会话不补蒸）", providerId, cause);
          return null;
        }),
      );
    }
    const provider = providerCache.get(providerId);
    return provider === undefined ? null : provider;
  };
  const fallbacks = new Map<string, { provider: ProviderSecrets; modelId: string }>();
  const perSession = await collectWithLimit(metas, 8, async (meta) => {
    const detail = await deps.sessions.load(meta.id).catch((cause: unknown) => {
      console.error("[memory:backfill] 会话账本读不了，跳过这条", meta.id, cause);
      return null;
    });
    if (detail === null) return null;
    const channelTexts = detail.transcript.some(isChannelMarkRecord)
      ? await channelTextsOf(deps.channels, meta.id, detail.transcript)
      : new Map<string, string>();
    const collected = collectSessionTurns({
      sessionId: meta.id,
      meta: { workspaceId: detail.meta.workspaceId, cwd: detail.meta.cwd },
      records: detail.transcript,
      channelTexts,
      distilled: deps.ledger.turnsOf(meta.id),
      since,
      model: { providerId: detail.meta.providerId, modelId: detail.meta.modelId },
    });
    if (collected.pending.length === 0) return collected;
    if (chore === undefined) {
      const provider = await resolveFallback(detail.meta.providerId);
      if (provider === null) return { pending: [], skippedTurns: collected.skippedTurns };
      fallbacks.set(meta.id, { provider, modelId: detail.meta.modelId });
    }
    return collected;
  });
  const turns: BackfillTurn[] = [];
  let skippedTurns = 0;
  for (const collected of perSession) {
    if (collected === null) continue;
    skippedTurns += collected.skippedTurns;
    turns.push(...collected.pending);
  }
  turns.sort((a, b) => a.at - b.at);
  return { turns, skippedTurns, chars: turns.reduce((sum, turn) => sum + turn.chars, 0), fallbacks };
}

/** 小并发池（保序收集）：读盘型任务的通用小工具，不做退避不做重试。 */
async function collectWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 通道标记的正文表：这条会话里出现过的每条通道各读一次（读失败当没有）。 */
async function channelTextsOf(
  channels: BackfillChannelReader,
  sessionId: string,
  records: readonly SessionRecord[],
): Promise<Map<string, string>> {
  const keys = new Map<string, ChannelKey>();
  for (const record of records) {
    if (!isChannelMarkRecord(record)) continue;
    const key: ChannelKey =
      record.from === "child"
        ? { parentId: sessionId, childId: record.peerId }
        : { parentId: record.peerId, childId: sessionId };
    keys.set(`${key.parentId}/${key.childId}`, key);
  }
  const texts = new Map<string, string>();
  await Promise.all(
    [...keys.values()].map(async (key) => {
      try {
        for (const message of await channels.load(key)) texts.set(message.id, message.text);
      } catch (cause) {
        console.error("[memory:backfill] 通道账本读不了，那条标记轮跳过", key, cause);
      }
    }),
  );
  return texts;
}

/* ---------- 任务状态机 ---------- */

const turnKey = (sessionId: string, turn: number): string => `${sessionId}:${turn}`;

interface QueuedTurn {
  turn: BackfillTurn;
  attempts: number;
  /** 这次尝试最早可发的时刻（退避门；0 = 立即）。 */
  notBefore: number;
  /** choreModel 缺席时的退路模型（主进程装配好密钥面）。 */
  fallback?: { provider: ProviderSecrets; modelId: string };
}

const IDLE_STATUS: MemoryBackfillStatus = {
  state: "idle",
  range: null,
  totalSessions: 0,
  doneSessions: 0,
  totalTurns: 0,
  doneTurns: 0,
  newEntries: 0,
  replaced: 0,
  failedTurns: 0,
  startedAt: null,
  updatedAt: null,
};

export class MemoryBackfillService {
  private readonly deps: MemoryBackfillDeps;
  private status: MemoryBackfillStatus = { ...IDLE_STATUS };
  private queue: QueuedTurn[] = [];
  /** 每条会话还剩几轮——清零时 doneSessions +1。 */
  private remaining = new Map<string, number>();
  /** 连续蒸不成的轮数（任一轮成功清零；到上限把任务置 failed）。 */
  private consecutiveFailed = 0;
  /** 本轮任务的 choreModel 载荷（start / resume 时装配一次，整轮复用）。 */
  private chorePayload: ChoreModelPayload | undefined;
  private loopAlive = false;

  constructor(deps: MemoryBackfillDeps) {
    this.deps = deps;
  }

  /** 启动时装载持久化状态；running 恢复成 paused（应用重启 = 没人看着跑了）。 */
  async loadPersisted(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.deps.stateFile, "utf8");
    } catch (cause) {
      if (!isNotFound(cause)) {
        console.error("[memory:backfill] 任务状态读不了，当没有任务", cause);
      }
      return;
    }
    const parsed = parsePersistedStatus(await parseJsonOrnull(raw));
    if (parsed === null) return;
    this.status = parsed;
    if (this.status.state === "running") {
      this.status = { ...this.status, state: "paused", updatedAt: this.deps.now() };
      await this.persist();
    }
  }

  statusSnapshot(): MemoryBackfillStatus {
    return this.status;
  }

  /** 预估（只读不写）：范围内待蒸轮数、已蒸跳过数、粗估 token、家务活模型。 */
  async estimate(range: MemoryBackfillRange): Promise<MemoryBackfillEstimate> {
    const [plan, chore] = await Promise.all([
      collectBackfillPlan(this.deps, range, this.deps.now()),
      this.deps.models.readChoreModel(),
    ]);
    return backfillEstimateOf({
      range,
      sessions: new Set(plan.turns.map((turn) => turn.sessionId)).size,
      turns: plan.turns.length,
      skippedTurns: plan.skippedTurns,
      chars: plan.chars,
      choreModel: chore === undefined ? null : { providerId: chore.provider.id, modelId: chore.modelId },
    });
  }

  /**
   * 开跑。已有任务在跑 / 暂停中不另起（started=false）；实验开关关着同样拒绝，
   * 原因写进回执 status 的 error（不落盘——拒绝不是任务状态）。
   */
  async start(range: MemoryBackfillRange): Promise<{ started: boolean; status: MemoryBackfillStatus }> {
    if (this.status.state === "running" || this.status.state === "paused") {
      return { started: false, status: this.status };
    }
    if (!(await this.deps.isMemoryEnabled())) {
      return {
        started: false,
        status: {
          ...this.status,
          error: "实验开关「会话记忆」没开：打开 设置 › 实验功能 后再从历史生成",
        },
      };
    }
    await this.beginTask(range, {});
    return { started: true, status: this.status };
  }

  pause(): MemoryBackfillStatus {
    if (this.status.state !== "running") return this.status;
    // 状态立即翻 paused（界面即时反馈）；在飞的那一批照常蒸完并落盘——那是已付的钱
    this.status = { ...this.status, state: "paused", updatedAt: this.deps.now() };
    void this.persist();
    this.deps.broadcast(this.status);
    return this.status;
  }

  /** 继续（断点续跑）：重收计划——暂停期间新聊的轮、新会话一并接上。 */
  async resume(): Promise<MemoryBackfillStatus> {
    if (this.status.state !== "paused" || this.status.range === null) return this.status;
    if (!(await this.deps.isMemoryEnabled())) {
      return { ...this.status, error: "实验开关「会话记忆」没开：打开 设置 › 实验功能 后再继续" };
    }
    await this.beginTask(this.status.range, { keepCounters: true });
    return this.status;
  }

  cancel(): MemoryBackfillStatus {
    if (this.status.state !== "running" && this.status.state !== "paused") return this.status;
    this.queue = [];
    this.status = { ...this.status, state: "cancelled", updatedAt: this.deps.now() };
    void this.persist();
    this.deps.broadcast(this.status);
    return this.status;
  }

  /** start / resume 共用的开工：收计划 → 装配模型 → 落状态 → 起循环。 */
  private async beginTask(
    range: MemoryBackfillRange,
    opts: { keepCounters?: boolean },
  ): Promise<void> {
    const now = this.deps.now();
    const plan = await collectBackfillPlan(this.deps, range, now);
    const chore = await this.deps.models.readChoreModel();
    this.chorePayload = chore;
    const queue: QueuedTurn[] = plan.turns.map((turn) => ({
      turn,
      attempts: 0,
      notBefore: 0,
      ...(chore === undefined ? { fallback: plan.fallbacks.get(turn.sessionId) } : {}),
    }));
    this.queue = queue;
    this.remaining = remainingOf(queue);
    this.consecutiveFailed = 0;
    const fresh: MemoryBackfillStatus = {
      state: queue.length === 0 ? "done" : "running",
      range,
      totalSessions: this.remaining.size,
      doneSessions: 0,
      totalTurns: queue.length,
      doneTurns: 0,
      newEntries: 0,
      replaced: 0,
      failedTurns: 0,
      startedAt: now,
      updatedAt: now,
    };
    this.status = opts.keepCounters
      ? {
          ...fresh,
          // 计数保留（接着涨）；总量抬到盖住新收进来的轮（暂停期间新聊的天经地义要蒸）
          doneTurns: this.status.doneTurns,
          newEntries: this.status.newEntries,
          replaced: this.status.replaced,
          failedTurns: this.status.failedTurns,
          doneSessions: this.status.doneSessions,
          totalTurns: Math.max(fresh.totalTurns, this.status.doneTurns + queue.length),
          totalSessions: Math.max(fresh.totalSessions, this.status.doneSessions + this.remaining.size),
          startedAt: this.status.startedAt,
        }
      : fresh;
    await this.persist();
    this.deps.broadcast(this.status);
    if (queue.length > 0) void this.runLoop();
  }

  /* ---------- 执行循环 ---------- */

  private async runLoop(): Promise<void> {
    if (this.loopAlive) return;
    this.loopAlive = true;
    try {
      while (this.status.state === "running" && this.queue.length > 0) {
        const now = this.deps.now();
        const ready: QueuedTurn[] = [];
        for (const item of this.queue) {
          if (item.notBefore > now) continue;
          ready.push(item);
          if (ready.length >= BACKFILL_BATCH) break;
        }
        if (ready.length === 0) {
          // 全在退避：睡一小片再看（暂停 / 取消在这间隙立即生效）
          const next = Math.min(...this.queue.map((item) => item.notBefore));
          await sleep(Math.min(Math.max(next - now, 50), WAIT_SLICE_MS));
          continue;
        }
        this.queue = this.queue.filter((item) => !ready.includes(item));
        let results: MemoryBackfillTurnResult[];
        try {
          results = await this.deps.distill.backfillDistill(
            ready.map((item) => this.toInput(item)),
            this.chorePayload,
          );
        } catch (cause) {
          // agent 进程退出 / 整批超时：这一批当这次尝试失败
          const error = cause instanceof Error ? cause.message : String(cause);
          results = ready.map((item) => ({ sessionId: item.turn.sessionId, turn: item.turn.turn, ok: false as const, error }));
        }
        const byKey = new Map(results.map((result) => [turnKey(result.sessionId, result.turn), result]));
        for (const item of ready) {
          const result = byKey.get(turnKey(item.turn.sessionId, item.turn.turn));
          if (result === undefined) {
            // 回执里缺了这轮（防御）：当失败重试，不悬空
            await this.onTurnFailure(item, "agent 进程没有回这一轮的结果");
            continue;
          }
          if (result.ok) await this.onTurnSuccess(item, result.entries);
          else await this.onTurnFailure(item, result.error);
        }
      }
      // 队列自然走空：置 done（暂停 / 取消的状态已由 pause()/cancel() 写好）
      if (this.status.state === "running" && this.queue.length === 0) {
        this.status = { ...this.status, state: "done", updatedAt: this.deps.now() };
        await this.persist();
        this.deps.broadcast(this.status);
      }
    } finally {
      this.loopAlive = false;
    }
  }

  private toInput(item: QueuedTurn): MemoryBackfillTurnInput {
    return {
      sessionId: item.turn.sessionId,
      turn: item.turn.turn,
      at: item.turn.at,
      userText: item.turn.userText,
      assistantText: item.turn.assistantText,
      scope: item.turn.scope,
      ...(item.fallback !== undefined ? { fallback: item.fallback } : {}),
    };
  }

  /** 一轮蒸成：落盘（backfilled 条目 + 冲突自动 replace）→ 记账 → 推进度。 */
  private async onTurnSuccess(item: QueuedTurn, entries: readonly MemoryDraft[]): Promise<void> {
    let outcome = { newEntries: 0, replaced: 0 };
    try {
      outcome = await applyBackfillEntries(this.deps, item.turn, entries);
    } catch (cause) {
      // 落盘失败不重试（store 是原子写，坏盘上重试也是坏）：这轮记已处理，继续走
      console.error("[memory:backfill] 条目落盘失败（这轮记账跳过）", item.turn.sessionId, item.turn.turn, cause);
    }
    this.consecutiveFailed = 0;
    this.status = {
      ...this.status,
      doneTurns: this.status.doneTurns + 1,
      newEntries: this.status.newEntries + outcome.newEntries,
      replaced: this.status.replaced + outcome.replaced,
      updatedAt: this.deps.now(),
    };
    this.tickSession(item.turn.sessionId);
    await this.persist();
    this.deps.broadcast(this.status);
  }

  private async onTurnFailure(item: QueuedTurn, error: string): Promise<void> {
    item.attempts += 1;
    if (item.attempts < BACKFILL_MAX_ATTEMPTS) {
      // 指数退避：重排到队尾 + notBefore 门（没有专职定时器，暂停间隙立即生效）
      const delay = (this.deps.backoffMs ?? backoffDelayMs)(item.attempts);
      this.queue.push({ ...item, notBefore: this.deps.now() + delay });
      console.error(
        `[memory:backfill] 第 ${item.attempts} 次尝试失败（退避后重试）：${error}`,
        item.turn.sessionId,
        item.turn.turn,
      );
      return;
    }
    console.error(`[memory:backfill] 重试耗尽，跳过这轮（下次补蒸再试）：${error}`, item.turn.sessionId, item.turn.turn);
    this.consecutiveFailed += 1;
    this.status = {
      ...this.status,
      doneTurns: this.status.doneTurns + 1,
      failedTurns: this.status.failedTurns + 1,
      updatedAt: this.deps.now(),
    };
    this.tickSession(item.turn.sessionId);
    if (this.consecutiveFailed >= BACKFILL_CONSECUTIVE_FAIL_LIMIT) {
      this.queue = [];
      this.status = {
        ...this.status,
        state: "failed",
        error: `连续 ${this.consecutiveFailed} 轮蒸馏失败，任务已停止：${error}`,
        updatedAt: this.deps.now(),
      };
    }
    await this.persist();
    this.deps.broadcast(this.status);
  }

  /** 一条会话的待蒸轮清零：doneSessions +1。 */
  private tickSession(sessionId: string): void {
    const left = (this.remaining.get(sessionId) ?? 0) - 1;
    if (left <= 0) {
      this.remaining.delete(sessionId);
      this.status = { ...this.status, doneSessions: this.status.doneSessions + 1 };
      return;
    }
    this.remaining.set(sessionId, left);
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.deps.stateFile, this.status);
    } catch (cause) {
      // 状态是断点续跑的凭据不是账本本身（账本在 distilled-turns 与记忆 JSONL），
      // 写失败只记日志：最坏是重启后进度归零重算，条目不会丢
      console.error("[memory:backfill] 任务状态没落盘", cause);
    }
  }
}

/** 队列 → 每会话剩余轮数。 */
function remainingOf(queue: readonly QueuedTurn[]): Map<string, number> {
  const remaining = new Map<string, number>();
  for (const item of queue) {
    remaining.set(item.turn.sessionId, (remaining.get(item.turn.sessionId) ?? 0) + 1);
  }
  return remaining;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseJsonOrnull(raw: string): Promise<unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 持久化状态的逐字段校验；形状不对返回 null（当没有任务）。 */
export function parsePersistedStatus(raw: unknown): MemoryBackfillStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const suspect = raw as Record<string, unknown>;
  const state = suspect.state;
  if (
    state !== "idle" && state !== "running" && state !== "paused" &&
    state !== "done" && state !== "cancelled" && state !== "failed"
  ) {
    return null;
  }
  const range = suspect.range;
  if (
    range !== null && range !== undefined &&
    !(MEMORY_BACKFILL_RANGES as readonly string[]).includes(range as string)
  ) {
    return null;
  }
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const counters = [suspect.totalSessions, suspect.doneSessions, suspect.totalTurns, suspect.doneTurns, suspect.newEntries, suspect.replaced, suspect.failedTurns].map(num);
  if (counters.some((value) => value === null)) return null;
  const startedAt = num(suspect.startedAt);
  const updatedAt = num(suspect.updatedAt);
  return {
    state,
    range: (range as MemoryBackfillRange | null | undefined) ?? null,
    totalSessions: counters[0] as number,
    doneSessions: counters[1] as number,
    totalTurns: counters[2] as number,
    doneTurns: counters[3] as number,
    newEntries: counters[4] as number,
    replaced: counters[5] as number,
    failedTurns: counters[6] as number,
    ...(typeof suspect.error === "string" && suspect.error !== "" ? { error: suspect.error } : {}),
    startedAt: startedAt === null ? null : startedAt,
    updatedAt: updatedAt === null ? null : updatedAt,
  };
}

/* ---------- 一轮蒸成后的落盘（与实时蒸馏同一套纪律 + 自动拍板） ---------- */

/**
 * 补蒸条目落盘：drafts 补 id / sessionId / turn / backfilled 落进该会话作用域；
 * supersedes 有效（目标还在库里且没被替代，applyMemoryAppend 同款校验）的条目
 * 直接按「replace」拍板。最后记已蒸账——**先落条目再记账**：反过来会让一次
 * 落盘失败被当成已处理，白丢一轮。
 */
export async function applyBackfillEntries(
  deps: Pick<MemoryBackfillDeps, "memory" | "ledger">,
  turn: BackfillTurn,
  drafts: readonly MemoryDraft[],
): Promise<{ newEntries: number; replaced: number }> {
  const scope = memoryScopeOf(turn.scope);
  const token = deps.memory.tokenOf(scope);
  const globalToken = deps.memory.tokenOf(MEMORY_GLOBAL_SCOPE);
  const pool = dedupeById([...(await deps.memory.list(token)), ...(await deps.memory.list(globalToken))]);
  const validated = drafts.map((draft) => {
    if (draft.supersedes === undefined) return draft;
    const target = pool.find((entry) => entry.id === draft.supersedes);
    if (target === undefined || !isRecallable(target)) {
      const { supersedes: _drop, ...rest } = draft;
      return rest;
    }
    return draft;
  });
  const entries = await deps.memory.append(token, turn.sessionId, turn.turn, validated, { backfilled: true });
  let replaced = 0;
  for (const entry of entries) {
    if (entry.supersedes === undefined) continue;
    const resolved = await deps.memory
      .resolveConflict(token, globalToken, { newId: entry.id, oldId: entry.supersedes }, "replace", false)
      .catch((cause: unknown) => {
        console.error("[memory:backfill] 冲突自动拍板失败（这条建议保持待处理）", entry.id, cause);
        return false;
      });
    if (resolved) replaced += 1;
  }
  await deps.ledger.record(turn.sessionId, turn.turn);
  return { newEntries: entries.length, replaced };
}
