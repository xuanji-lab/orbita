/**
 * 记忆服务核心 —— 命令（init / turnSettled / recall）到存储与模型调用的编排。
 * **纯模块**：不 import electron，模型调用与时间注入，可被 `node --test` 直接测
 * （host-core.ts 的先例同款；真的 fork 与 parentPort 在 runtime.ts 薄壳里）。
 *
 * 失败纪律：记忆是易耗品，任何失败静默跳过 + 日志，不冒错给主进程——turnSettled
 * 本来就没有回执；recall 出问题时回空 hits（开轮不该被记忆拦住）。
 *
 * 串行队列：切段分类与三类提取都要跑模型（秒级到分钟级），全部排进同一条队列，
 * 避免同会话文件竞态、也压住家务活模型的并发量。recall **不进队列**——只读文件，
 * 毫秒级，站在门外等着就行。
 */
import type { MemoryChoreModel, MemoryEpisodeTurn, MemoryHit } from "../shared/memory.ts";
import { memoryTurnSnapshot } from "../shared/memory.ts";
import {
  admissionOf,
  buildSegmentPrompt,
  EpisodeStore,
  openEpisode,
  parseSegmentReply,
  SEGMENT_SYSTEM_PROMPT,
  toMemoryEpisode,
  EPISODE_IDLE_CLOSE_MS,
  type OpenEpisode,
} from "./episodes.ts";
import { MemoryEntryStore, type MemoryDraft } from "./entries.ts";
import {
  buildExtractPrompt,
  FACT_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  parseExtractReply,
  preferenceCandidates,
  PREFERENCE_SYSTEM_PROMPT,
} from "./extract.ts";
import { recallHits } from "./retrieve.ts";
import type { MemoryEntry } from "../shared/memory.ts";

/** 模型调用（runtime 薄壳注入真实现：completeSimple；测试注入桩）。null = 调用失败。 */
export type MemoryCallModel = (system: string, prompt: string) => Promise<string | null>;

export interface MemoryServiceCoreOptions {
  /** 模型调用；没有 chore 时不会调它 */
  callModel: MemoryCallModel;
  now?: () => number;
  /** 闲置收尾时长（测试注入短值；默认 EPISODE_IDLE_CLOSE_MS） */
  idleCloseMs?: number;
  log?: (message: string, ...args: unknown[]) => void;
}

const EXTRACT_TYPES = ["fact", "preference", "insight"] as const;

export class MemoryServiceCore {
  private readonly callModel: MemoryCallModel;
  private readonly now: () => number;
  private readonly idleCloseMs: number;
  private readonly log: (message: string, ...args: unknown[]) => void;
  private entries: MemoryEntryStore | null = null;
  private episodes: EpisodeStore | null = null;
  private chore: MemoryChoreModel | null = null;
  /** 「没配家务活模型」只提醒一次——每轮都刷一条就成了噪音 */
  private choreMissingLogged = false;
  /** 串行队列（切段 / 提取都走它） */
  private queue: Promise<void> = Promise.resolve();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: MemoryServiceCoreOptions) {
    this.callModel = options.callModel;
    this.now = options.now ?? (() => Date.now());
    this.idleCloseMs = options.idleCloseMs ?? EPISODE_IDLE_CLOSE_MS;
    this.log = options.log ?? ((message, ...args) => console.log(message, ...args));
  }

  /**
   * 进程就绪后的第一句：数据目录与当前的家务活模型。之后做启动清扫：
   * - 闲置超时的开段收尾（应用退出收不了尾的追认，见 episodes.ts 头注释）；
   * - 待提取段里没提完的类补提取（上次死在半路）；
   * - 开段与待提取段同 episodeId（搬移半路被杀）：pending 赢，开段文件删掉。
   */
  async init(dir: string, chore?: MemoryChoreModel): Promise<void> {
    this.entries = new MemoryEntryStore(dir);
    this.episodes = new EpisodeStore(dir);
    if (chore !== undefined) this.chore = chore;
    const store = this.episodes;
    const { open, pending } = await store.listAll();
    const pendingIds = new Set(pending.map((episode) => episode.episodeId));
    for (const episode of open) {
      if (pendingIds.has(episode.episodeId)) {
        // 搬移半路被杀：pending 里那份是收尾正主，开段这份是残留
        await store.removeOpen(episode.sessionId).catch(() => undefined);
        continue;
      }
      if (this.now() - episode.lastAt >= this.idleCloseMs) {
        this.enqueue(() => this.closeEpisode(episode));
      } else {
        this.armIdle(episode.sessionId);
      }
    }
    for (const episode of pending) {
      this.enqueue(() => this.extractEpisode(episode.episodeId));
    }
    // 清扫的收尾 / 提取全部入队后，init 等 queue 尾——后续 turnSettled 的活
    // 排在清扫后面，顺序确定（启动提取可能分钟级，主进程不等 init 回执）
    await this.queue;
  }

  /**
   * 主进程每次轮后现送装配好的 chore（设置改了下一轮就生效）；缺席保持上一次的。
   * 返回队列尾：调用方（runtime 薄壳）不等它，测试与排查等它。
   */
  turnSettled(payload: {
    sessionId: string;
    scopeId: string;
    turn: number;
    at: number;
    userText: string;
    assistantText: string;
    chore?: MemoryChoreModel;
  }): Promise<void> {
    if (payload.chore !== undefined) this.chore = payload.chore;
    if (this.chore === null) {
      if (!this.choreMissingLogged) {
        this.choreMissingLogged = true;
        this.log("[memory] 没配家务活模型，记忆不构建（设置 › 模型服务 › 家务活模型）");
      }
      return Promise.resolve();
    }
    this.choreMissingLogged = false;
    const snapshot = memoryTurnSnapshot({
      turn: payload.turn,
      at: payload.at,
      userText: payload.userText,
      assistantText: payload.assistantText,
    });
    const { sessionId, scopeId } = payload;
    return this.enqueue(() => this.integrateTurn(snapshot, sessionId, scopeId));
  }

  /**
   * 每轮开始前的召回：合并 user 层 + 当前工作区层 → 常驻直通 + 词法打分 →
   * 落一条注入记录（含零命中）。任何内部问题都回空 hits——recall 在轮前的同步
   * 路径上，不能出错也不能慢。
   */
  async recall(input: {
    sessionId: string;
    scopeId: string;
    turn: number;
    query: string;
  }): Promise<MemoryHit[]> {
    try {
      if (this.entries === null) return [];
      const [user, scope] = await Promise.all([
        this.entries.listUser(),
        this.entries.listScope(input.scopeId),
      ]);
      const hits = recallHits({ user, scope }, input.query, this.now());
      await this.entries.recordInjection({
        sessionId: input.sessionId,
        turn: input.turn,
        at: this.now(),
        hits: hits.map((hit) => ({ id: hit.entry.id, score: hit.score, ...(hit.pinned ? { pinned: true } : null) })),
      });
      return hits;
    } catch (cause) {
      this.log("[memory] 召回出错（回空命中，不拦开轮）", cause);
      return [];
    }
  }

  /* ---------- 队列里的活 ---------- */

  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job).catch((cause: unknown) => {
      this.log("[memory] 后台任务失败（静默，下次触发自然重试）", cause);
    });
    return this.queue;
  }

  private async integrateTurn(
    turn: MemoryEpisodeTurn,
    sessionId: string,
    scopeId: string,
  ): Promise<void> {
    const store = this.episodes;
    if (store === null) return;
    // 该会话若有提完没收尾干净 / 提取失败的待提取段，趁这轮补一把
    // （启动清扫之外的唯一重试触发点；扫两个小目录，代价可忽略）
    const { pending } = await store.listAll();
    for (const leftover of pending) {
      if (leftover.sessionId === sessionId) {
        await this.extractEpisode(leftover.episodeId);
      }
    }
    const episode = await store.loadOpen(sessionId);
    const admission = admissionOf(episode, turn);
    if (admission.kind === "ignore") return;
    if (admission.kind === "classify" && episode !== null) {
      const verdict = await this.classify(episode, turn);
      if (verdict === "new") {
        // 旧段收尾进 pending，新段立即落盘（进程死在提取里也不丢这一轮），再提旧段
        await store.savePending(episode);
        const next = openEpisode({ sessionId, scopeId, turn, now: this.now() });
        await store.saveOpen(next);
        this.armIdle(sessionId);
        await this.extractEpisode(episode.episodeId);
        return;
      }
    }
    if (admission.kind === "split" && episode !== null) {
      await store.savePending(episode);
      const next = openEpisode({ sessionId, scopeId, turn, now: this.now() });
      await store.saveOpen(next);
      this.armIdle(sessionId);
      await this.extractEpisode(episode.episodeId);
      return;
    }
    const next =
      episode === null
        ? openEpisode({ sessionId, scopeId, turn, now: this.now() })
        : {
            ...episode,
            toTurn: turn.turn,
            lastAt: turn.at,
            turns: [...episode.turns, turn],
          };
    await store.saveOpen(next);
    this.armIdle(sessionId);
  }

  /** 切段二分类：读不懂 / 调用失败按 same（并段比切段保守，判错代价更小）。 */
  private async classify(episode: OpenEpisode, turn: MemoryEpisodeTurn): Promise<"same" | "new"> {
    const last = episode.turns[episode.turns.length - 1];
    const raw = await this.callModel(
      SEGMENT_SYSTEM_PROMPT,
      buildSegmentPrompt({ prevUser: last.userText, nextUser: turn.userText }),
    );
    if (raw === null) {
      this.log("[memory] 切段分类调用失败（按同一件事并入开段）");
      return "same";
    }
    return parseSegmentReply(raw) ?? "same";
  }

  /** 闲置计时器到点：开段还在、还闲置着 → 收尾提取。 */
  private async closeEpisode(episode: OpenEpisode): Promise<void> {
    const store = this.episodes;
    if (store === null) return;
    const current = await store.loadOpen(episode.sessionId);
    if (current === null || current.episodeId !== episode.episodeId) return;
    await store.savePending(current);
    await store.removeOpen(current.sessionId);
    await this.extractEpisode(current.episodeId);
  }

  /**
   * 提取一个已收尾的段：三类逐类调模型，逐类记账（extracted），全提完归档删文件。
   * 某类失败（模型 / 落盘）：该类记账不动，段留在 pending——启动清扫或该会话下一轮
   * 落定时重试，已提成的类不会重提（不重复落条目）。
   */
  private async extractEpisode(episodeId: string): Promise<void> {
    const store = this.episodes;
    const entries = this.entries;
    if (store === null || entries === null) return;
    if (this.chore === null) {
      this.log("[memory] 有待提取的事件段，但没有家务活模型——留在盘上等模型配上");
      return;
    }
    const episode = await store.loadPending(episodeId);
    if (episode === null) return;
    const pub = toMemoryEpisode(episode);
    // 全提完的段再被扫到（归档后、删文件前被杀的窗口）：补归档 + 删文件。
    // 归档可能重复一行（log 只追加）——UI 按 episodeId 读时去重，无害；
    // 危险的是重复提取落条目，那由逐类记账拦住
    if (EXTRACT_TYPES.every((type) => episode.extracted[type])) {
      await store.archive(pub);
      await store.removePending(episodeId);
      return;
    }
    const episodeText = episode.turns
      .map((turn) => `${turn.userText}\n${turn.assistantText}`)
      .join("\n");
    for (const type of EXTRACT_TYPES) {
      if (episode.extracted[type]) continue;
      let candidates: MemoryEntry[] | undefined;
      if (type === "preference") {
        const pool = [...(await entries.listScope(episode.scopeId)), ...(await entries.listUser())];
        candidates = preferenceCandidates(pool, episodeText);
      }
      const system =
        type === "fact" ? FACT_SYSTEM_PROMPT : type === "preference" ? PREFERENCE_SYSTEM_PROMPT : INSIGHT_SYSTEM_PROMPT;
      const raw = await this.callModel(
        system,
        buildExtractPrompt({ turns: episode.turns, now: this.now(), candidates }),
      );
      if (raw === null) {
        this.log(`[memory] 段 ${episodeId} 的 ${type} 提取调用失败（该类记账不动，下次重试）`);
        continue;
      }
      const candidateIds = new Set((candidates ?? []).map((entry) => entry.id));
      const drafts: MemoryDraft[] = parseExtractReply(raw, type, candidateIds);
      const written = await entries.appendScope(episode.scopeId, pub, drafts);
      if (written.length > 0) {
        this.log(
          `[memory] 段 ${episodeId} 提取出 ${written.length} 条${type === "insight" ? "经验" : type === "fact" ? "事实" : "偏好"}`,
        );
      }
      episode.extracted[type] = true;
      await store.savePending(episode);
    }
    if (EXTRACT_TYPES.every((type) => episode.extracted[type])) {
      await store.archive(pub);
      await store.removePending(episodeId);
    }
  }

  /* ---------- 闲置计时器 ---------- */

  private armIdle(sessionId: string): void {
    this.disarmIdle(sessionId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      this.enqueue(async () => {
        const store = this.episodes;
        if (store === null) return;
        const episode = await store.loadOpen(sessionId);
        if (episode === null) return;
        if (this.now() - episode.lastAt < this.idleCloseMs) return;
        await store.savePending(episode);
        await store.removeOpen(sessionId);
        await this.extractEpisode(episode.episodeId);
      });
    }, this.idleCloseMs);
    timer.unref?.();
    this.idleTimers.set(sessionId, timer);
  }

  private disarmIdle(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }
}
