/**
 * 记忆服务核心 —— 命令（init / turnSettled / recall）到存储与模型调用的编排。
 * **纯模块**：不
import electron，模型调用与时间注入，可被 `node --test` 直接测
 * （host-core.ts 的先例同款；真的 fork 与 parentPort 在 runtime.ts 薄壳里）。
 *
 * 失败纪律：记忆是易耗品，任何失败静默跳过 + 日志，不冒错给主进程——turnSettled
 * 本来就没有回执；recall 出问题时回空 hits（开轮不该被记忆拦住）。
 *
 * 串行队列：切段分类与三类提取都要跑模型（秒级到分钟级），全部排进同一条队列，
 * 避免同会话文件竞态、也压住家务活模型的并发量。recall **不进队列**——只读文件，
 * 毫秒级，站在门外等着就行。
 */
import { join } from "node:path";
import type {
  MemoryAgentCall,
  MemoryAgentOutcome,
  MemoryBackfillProgress,
  MemoryChoreModel,
  MemoryDownloadProgress,
  MemoryEntry,
  MemoryEpisodeTurn,
  MemoryHistoryStepOutcome,
  MemoryHit,
  MemoryMutation,
  MemoryMutationOutcome,
  MemoryVectorServiceConfig,
} from "../shared/memory.ts";
import { MEMORY_USER_TOKEN, memoryShortId, memoryTurnSnapshot } from "../shared/memory.ts";
import {
  admissionOf,
  buildSegmentPrompt,
  EpisodeStore,
  openEpisode,
  parseSegmentReply,
  SEGMENT_SYSTEM_PROMPT,
  toMemoryEpisode,
  truncateEpisode,
  EPISODE_IDLE_CLOSE_MS,
  type OpenEpisode,
} from "./episodes.ts";
import { MemoryEntryStore, normalizeText, type MemoryDraft } from "./entries.ts";
import {
  agentRecordedIn,
  buildExtractPrompt,
  FACT_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  parseExtractReply,
  preferenceCandidates,
  PREFERENCE_SYSTEM_PROMPT,
} from "./extract.ts";
import {
  dedupeById,
  isRecallable,
  RECALL_LIMIT,
  RECALL_MAX_CHARS,
  recallHits,
  searchMemories,
  selectHits,
} from "./retrieve.ts";
import { EmbedServerCore, type EmbedServerOptions } from "./embed-server.ts";
import { VectorStore, dotProductRank } from "./vector-store.ts";
import { downloadWithFallback, type DownloadFetch } from "./downloader.ts";
import { fuseRanked } from "./vector-fuse.ts";

/** 模型调用（runtime 薄壳注入真实现：completeSimple；测试注入桩）。null = 调用失败。 */
export type MemoryCallModel = (system: string, prompt: string) => Promise<string | null>;

export interface MemoryServiceCoreOptions {
  /** 模型调用；没有 chore 时不会调它 */
  callModel: MemoryCallModel;
  now?: () => number;
  /** 闲置收尾时长（测试注入短值；默认 EPISODE_IDLE_CLOSE_MS） */
  idleCloseMs?: number;
  log?: (message: string, ...args: unknown[]) => void;
  /** 任何写盘后回调一次（runtime 转发 changed 消息给主进程广播） */
  onChanged?: () => void;
  /** 模型下载进度（runtime 转发 downloadProgress） */
  onDownloadProgress?: (progress: MemoryDownloadProgress) => void;
  /** 补算进度（runtime 转发 backfillProgress） */
  onBackfillProgress?: (progress: MemoryBackfillProgress) => void;
  /** llama-server pid 变了（runtime 转发 embedServerPid，主进程退出时补杀用） */
  onEmbedServerPid?: (pid: number | null) => void;
  /** 从历史生成：相邻两轮（按历史时间）间隔多久收尾事件段（默认 = 实时的闲置收尾时长） */
  historyGapMs?: number;
  /** 从历史生成：家务活调用失败后的退避重试间隔（毫秒；默认 5s / 20s / 60s，共重试 3 次） */
  historyRetryDelaysMs?: readonly number[];
  /** 退避的等待（测试注入立即返回） */
  sleep?: (ms: number) => Promise<void>;
  /** 向量引擎的原语（spawn / HTTP / 端口 / 下载 fetch），注入可测 */
  vectorDeps?: {
    spawn: EmbedServerOptions["spawn"];
    probe: EmbedServerOptions["probe"];
    post: EmbedServerOptions["post"];
    freePort: EmbedServerOptions["freePort"];
    fetchImpl: DownloadFetch;
  };
}

const EXTRACT_TYPES = ["fact", "preference", "insight"] as const;

/** 从历史生成失败退避：智谱等家务活模型有并发 / 限额，429 后立刻重试只会再撞 */
const HISTORY_RETRY_DELAYS_MS = [5_000, 20_000, 60_000] as const;

/** 一次提取的上下文：用哪个调用（实时直调；从历史生成带计数与退避重试）、往哪记账。 */
interface ExtractContext {
  call: MemoryCallModel;
  stats: MemoryHistoryStepOutcome | null;
}

function emptyStepOutcome(): MemoryHistoryStepOutcome {
  return { closed: 0, written: { fact: 0, preference: 0, insight: 0 }, calls: 0, failed: 0 };
}

/** memory_search 一次最多回几条、正文总预算多少（给 agent 定位用，比轮前注入宽） */
const AGENT_SEARCH_LIMIT = 8;
const AGENT_SEARCH_MAX_CHARS = 4000;


export class MemoryServiceCore {
  private readonly callModel: MemoryCallModel;
  private readonly now: () => number;
  private readonly idleCloseMs: number;
  private readonly historyGapMs: number;
  private readonly historyRetryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (message: string, ...args: unknown[]) => void;
  private readonly onChanged: () => void;
  private readonly onDownloadProgress: (progress: MemoryDownloadProgress) => void;
  private readonly onBackfillProgress: (progress: MemoryBackfillProgress) => void;
  private readonly onEmbedServerPid: (pid: number | null) => void;
  private readonly vectorDeps: NonNullable<MemoryServiceCoreOptions["vectorDeps"]> | null;
  private embedServer: EmbedServerCore | null = null;
  private vectors: VectorStore | null = null;
  private vectorConfig: MemoryVectorServiceConfig | null = null;
  private onBattery = false;
  /** 后台补算的状态（null = 没在算也不欠账）；inFlight 防重入 */
  private backfill: { state: "running" | "deferred-battery"; done: number; total: number } | null = null;
  private backfillInFlight: Promise<void> | null = null;
  /** 当前轮跑着时又收到排程：结束后必须再全量对账一轮 */
  private backfillRerunRequested = false;
  /** 模型下载（同一时刻最多一个；幂等回执由调用方处理） */
  private downloadInFlight: Promise<void> | null = null;
  private downloadAbort: AbortController | null = null;
  private entries: MemoryEntryStore | null = null;
  private episodes: EpisodeStore | null = null;
  private chore: MemoryChoreModel | null = null;
  /** 「没配家务活模型」只提醒一次——每轮都刷一条就成了噪音 */
  private choreMissingLogged = false;
  /** 从历史生成的按会话串行链（不进实时队列；见 historyTurn） */
  private readonly historyChains = new Map<string, Promise<MemoryHistoryStepOutcome>>();
  /** 正在提取的段：实时队列（启动清扫 / 同会话补提）与历史步可能同时摸到同一个待提取段，
   * 后到的直接让开——两边各提一遍就是重复条目 */
  private readonly extracting = new Set<string>();
  /** 串行队列（切段 / 提取都走它） */
  private queue: Promise<void> = Promise.resolve();
  /** 条目层文件级的互斥：提取的追加（appendScope）与记忆库的改写（整层重写）
 * 不能交错，否则重写会丢掉刚追加的行；但记忆库写不该排在可能分钟级的提取
   * 队列后面——按 token 粒度互斥，不同作用域互不等待 */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  /**
   * 每个会话「提取落过几批条目」的计数（只增不减，进程内）。回退的第二遍停用靠它判
   * 「第一遍之后这个会话有没有新条目落盘」——没有就不再扫一遍全库。
   */
  private readonly entryWrites = new Map<string, number>();
  /**
   * 已通知、还没在队列里截段的回退点（会话 → 回退点列表，每次 sessionReverted 推一个、
   * 它自己的截段跑完摘掉自己那一个）。队列里正跑的提取拿的是回退前读出的段，靠它在每次
   * 调模型前后看见回退：被撤回的轮不进提示词、调用中途到达的回退让那次输出作废重来。
   *
   * 存列表不存「最小值」：两次回退之间重说的轮会复用轮号，排在第一次截段之后的提取
   * 只该受第二次回退约束——第一次的截段一跑完，它的回退点就得从这里消失，留下第二次的。
   */
  private readonly pendingReverts = new Map<string, number[]>();
  /**
   * init 的闸：init 一进来（同步）就立起，数据目录挂好、启动清扫入队后打开。
   * 服务刚拉起时主进程紧跟 init 就发 turnSettled（开关中途打开 / 崩溃后重拉的
   * 第一轮），那时 init 还在读盘、episodes 还是 null——不等这道闸，那一轮就被
   * integrateTurn 的空 store 分支静默丢掉。null = 还没收到过 init。
   */
  private initGate: Promise<void> | null = null;

  constructor(options: MemoryServiceCoreOptions) {
    this.callModel = options.callModel;
    this.now = options.now ?? (() => Date.now());
    this.idleCloseMs = options.idleCloseMs ?? EPISODE_IDLE_CLOSE_MS;
    this.historyGapMs = options.historyGapMs ?? EPISODE_IDLE_CLOSE_MS;
    this.historyRetryDelaysMs = options.historyRetryDelaysMs ?? HISTORY_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.log = options.log ?? ((message, ...args) => console.log(message, ...args));
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onDownloadProgress = options.onDownloadProgress ?? (() => undefined);
    this.onBackfillProgress = options.onBackfillProgress ?? (() => undefined);
    this.onEmbedServerPid = options.onEmbedServerPid ?? (() => undefined);
    this.vectorDeps = options.vectorDeps ?? null;
  }

  /**
   * 进程就绪后的第一句：数据目录与当前的家务活模型。之后做启动清扫：
   * - 闲置超时的开段收尾（应用退出收不了尾的追认，见 episodes.ts 头注释）；
   * - 待提取段里没提完的类补提取（上次死在半路）；
   * - 开段与待提取段同 episodeId（搬移半路被杀）：pending 赢，开段文件删掉。
   */
  async init(dir: string, chore?: MemoryChoreModel): Promise<void> {
    let openGate: () => void = () => undefined;
    this.initGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    try {
      await this.initStores(dir, chore);
    } finally {
      // 失败也开闸：等着的轮看到 store 仍是 null，记一行丢弃日志后走掉，不把队列卡死
      openGate();
    }
    // 清扫的收尾 / 提取全部入队后，init 等 queue 尾——后续 turnSettled 的活
    // 排在清扫后面，顺序确定（启动提取可能分钟级，主进程不等 init 回执）。
    // 开闸之前就到了的轮排在清扫前面：它自己处理开段（admissionOf 判间隔），
    // 清扫的 closeEpisode 按 episodeId 核对、提取按类记账，先后都不出错
    await this.queue;
  }

  private async initStores(dir: string, chore?: MemoryChoreModel): Promise<void> {
    const entries = new MemoryEntryStore(dir);
    // 旧「待你确认」数据按新规则落定一次（只跑一次，见 settleLegacyDecisions）。
    // 在 entries 挂上之前做：记忆库写操作此时回「还没初始化」，不与这次整层改写交错
    try {
      const settled = await entries.settleLegacyDecisions();
      if (settled.promoted + settled.staled > 0) {
        this.log(`[memory] 旧的待确认已按新规则落定：升到所有工作区 ${settled.promoted} 条，旧说法标过时 ${settled.staled} 条`);
      }
    } catch (cause) {
      this.log("[memory] 旧待确认数据落定失败（不拦启动，下次启动再试）", cause);
    }
    this.entries = entries;
    this.episodes = new EpisodeStore(dir);
    this.vectors = new VectorStore(join(dir, "vector"));
    if (this.vectorDeps !== null) {
      this.embedServer = new EmbedServerCore({
        resolve: () => {
          const config = this.vectorConfig;
          if (config === null) return null;
          return {
            binaryPath: config.binaryPath,
            model: {
              id: config.model.id,
              modelPath: config.ggufPath,
              pooling: config.model.pooling,
              ctx: config.model.ctx,
              queryPrefix: config.model.queryPrefix,
              docPrefix: config.model.docPrefix,
              dims: config.model.dims,
            },
          };
        },
        spawn: this.vectorDeps.spawn,
        probe: this.vectorDeps.probe,
        post: this.vectorDeps.post,
        freePort: this.vectorDeps.freePort,
        idleUnloadMs: this.vectorConfig?.idleUnloadMs,
        log: this.log,
        onPid: this.onEmbedServerPid,
      });
    }
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
      // 只提醒一次（每轮都刷就成了噪音）；配上模型后再缺会重新提醒
      if (!this.choreMissingLogged) {
        this.choreMissingLogged = true;
        this.log(
          `[memory] 没配家务活模型，记忆不构建（设置 › 模型服务 › 家务活模型）；会话 ${payload.sessionId} 第 ${payload.turn} 轮起的轮都不进事件段，直到配上`,
        );
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
    return this.enqueue(async () => {
      try {
        await this.integrateTurn(snapshot, sessionId, scopeId);
      } catch (cause) {
        // 队列兜底的那行日志不带是哪一轮；这里补上会话与轮号再记
        this.log(`[memory] 会话 ${sessionId} 第 ${snapshot.turn} 轮并入事件段时出错（这一轮可能没进事件段）`, cause);
      }
    });
  }

  /**
   * 会话「回到这里」：第 fromTurn 轮及之后被撤回（契约见 MemoryServiceCommand 的 sessionReverted）。
   *
   * 两步，分在队列内外：
   * 1. **立即**（不排队，按层上锁）停用来源轮全被撤回的条目、恢复它们顶掉的旧条——队列里
   *    可能正跑着分钟级的提取，用户重说的那一轮开轮召回不该还注入被撤回的话；
   * 2. **排队**（与切段 / 提取串行，排在这之前投递的轮后面、重说的那一轮前面）截段：开段与
   *    待提取段里轮号 ≥ fromTurn 的轮截掉，截空的段丢掉。开段水位回落后 admissionOf 不再
   *    ignore 重说的轮；已归档的段不参与 admission，不必改写。
   *
   * 排在截段前面、正在跑的同会话提取拿的是回退前读出的段：回退点同步登记进 pendingReverts，
   * 提取每类调模型前按它截段（被撤回的轮不进提示词），调用中途到达的回退让那次输出作废重提。
   * 剩下的窗口（调用回来之后、落盘之前到达）由兜底处理：第 1 步之后若这个会话又有提取落盘，
   * 截段后再停用一遍；没有就不重扫。
   * 返回队列尾（runtime 不等，测试等）。失败只记日志——记忆的问题不倒灌回退。
   */
  sessionReverted(payload: { sessionId: string; fromTurn: number }): Promise<void> {
    const { sessionId, fromTurn } = payload;
    if (!Number.isInteger(fromTurn) || fromTurn < 1) {
      this.log(`[memory] 会话 ${sessionId} 的回退通知轮号不合法（${fromTurn}），忽略`);
      return Promise.resolve();
    }
    const writesBefore = this.entryWrites.get(sessionId) ?? 0;
    // 同步登记：队列里正跑的提取下一次调模型前（或这次调用回来时）就能看见
    this.pendingReverts.set(sessionId, [...(this.pendingReverts.get(sessionId) ?? []), fromTurn]);
    const immediate = this.revertEntries(sessionId, fromTurn);
    return this.enqueue(async () => {
      await immediate;
      try {
        await this.truncateEpisodes(sessionId, fromTurn);
      } catch (cause) {
        this.log(`[memory] 会话 ${sessionId} 回退到第 ${fromTurn} 轮时截段出错`, cause);
      } finally {
        this.settleRevert(sessionId, fromTurn);
      }
      if ((this.entryWrites.get(sessionId) ?? 0) !== writesBefore) {
        await this.revertEntries(sessionId, fromTurn);
      }
    });
  }

  /* ---------- 从历史生成 ---------- */

  /**
   * 一条历史轮（主进程按会话内的历史时间正序逐条喂，等回执再喂这条会话的下一条）。走与实时
   * 同一套切段二分类与三类提取，只是：
   * - 段放在**历史开段**（episodes/history/），不碰该会话的实时开段；
   * - 收尾按历史时间判：本会话上一轮与这一轮间隔 ≥ historyGapMs 直接收尾（不问模型），
   *   closeAfter（该会话在计划里的最后一轮）并入后立即收尾——实时路径的闲置计时器换成历史时钟；
   * - 调用带计数与失败退避重试。
   * **不进实时队列**：按会话串行（historyChains），不同会话可以并行（并发数由主进程控制）。
   * 实时轮因此一步都不用等；跨会话的先后不影响正确性——冲突新旧按条目的 at 定向
   * （appendScope），晚提取的旧说法照样落成过时。
   * 返回这一步的账（收尾几段 / 写了几条 / 调了几次 / 失败几类），不抛。
   */
  historyTurn(payload: {
    sessionId: string;
    scopeId: string;
    turn: MemoryEpisodeTurn;
    closeAfter: boolean;
    chore?: MemoryChoreModel;
  }): Promise<MemoryHistoryStepOutcome> {
    if (payload.chore !== undefined) this.chore = payload.chore;
    return this.historyStep(payload.sessionId, "历史轮", (stats) => this.ingestHistoryTurn(payload, stats));
  }

  /** 从历史生成停止 / 跑完：全部历史开段按段尾时间先后收尾提取。 */
  historyFlush(payload: { chore?: MemoryChoreModel } = {}): Promise<MemoryHistoryStepOutcome> {
    if (payload.chore !== undefined) this.chore = payload.chore;
    return this.historyStep("\u0000flush", "历史收尾", async (stats) => {
      if (this.initGate !== null) await this.initGate;
      const store = this.episodes;
      if (store === null) {
        stats.error = "记忆服务还没初始化";
        return;
      }
      const context: ExtractContext = { call: this.historyCall(stats), stats };
      const open = (await store.listHistoryOpen()).sort((a, b) => a.lastAt - b.lastAt);
      for (const episode of open) await this.closeHistoryEpisode(episode, context);
      if (open.length > 0) this.onChanged();
    });
  }

  /** 历史步按 key（会话）串行，跑完把这一步的账交回去（抛错记进 error，不外抛）。 */
  private historyStep(
    key: string,
    label: string,
    job: (stats: MemoryHistoryStepOutcome) => Promise<void>,
  ): Promise<MemoryHistoryStepOutcome> {
    const stats = emptyStepOutcome();
    const previous = this.historyChains.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      try {
        await job(stats);
      } catch (cause) {
        this.log(`[memory] 从历史生成：${label}处理出错`, cause);
        stats.error = cause instanceof Error ? cause.message : String(cause);
      }
      return stats;
    });
    this.historyChains.set(key, run);
    void run.finally(() => {
      if (this.historyChains.get(key) === run) this.historyChains.delete(key);
    });
    return run;
  }

  /** 从历史生成的模型调用：每次（含重试）计数，失败按 historyRetryDelaysMs 退避重试。 */
  private historyCall(stats: MemoryHistoryStepOutcome): MemoryCallModel {
    return async (system, prompt) => {
      for (let attempt = 0; ; attempt += 1) {
        stats.calls += 1;
        const raw = await this.callModel(system, prompt);
        if (raw !== null) return raw;
        const delay = this.historyRetryDelaysMs[attempt];
        if (delay === undefined) return null;
        this.log(`[memory] 从历史生成：家务活模型调用失败，${Math.round(delay / 1000)} 秒后重试（第 ${attempt + 1} 次）`);
        await this.sleep(delay);
      }
    };
  }

  private async ingestHistoryTurn(
    payload: { sessionId: string; scopeId: string; turn: MemoryEpisodeTurn; closeAfter: boolean },
    stats: MemoryHistoryStepOutcome,
  ): Promise<void> {
    if (this.initGate !== null) await this.initGate;
    const store = this.episodes;
    if (store === null || this.entries === null) {
      stats.error = "记忆服务还没初始化";
      return;
    }
    if (this.chore === null) {
      stats.error = "没配家务活模型（设置 › 模型服务 › 家务活模型）";
      return;
    }
    const { sessionId, scopeId } = payload;
    // 发送侧已截过；这里再过一遍同一个口径，不信任跨进程的载荷长度
    const turn = memoryTurnSnapshot(payload.turn);
    const context: ExtractContext = { call: this.historyCall(stats), stats };
    let episode = await store.loadHistoryOpen(sessionId);
    if (episode !== null && (await store.loadPending(episode.episodeId)) !== null) {
      // 搬进待提取后、删历史开段前被杀：pending 那份是正主（实时启动清扫同款）
      await store.removeHistoryOpen(sessionId);
      episode = null;
    }
    if (episode !== null && turn.turn <= episode.toTurn) {
      this.log(`[memory] 从历史生成：会话 ${sessionId} 第 ${turn.turn} 轮不大于历史开段已收的第 ${episode.toTurn} 轮，跳过`);
      return;
    }
    let closing: OpenEpisode | null = null;
    let next: OpenEpisode;
    if (episode === null) {
      next = openEpisode({ sessionId, scopeId, turn, now: turn.at });
    } else if (
      turn.at - episode.lastAt >= this.historyGapMs ||
      (await this.classify(episode, turn, context.call)) === "new"
    ) {
      closing = episode;
      next = openEpisode({ sessionId, scopeId, turn, now: turn.at });
    } else {
      next = { ...episode, toTurn: turn.turn, lastAt: turn.at, turns: [...episode.turns, turn] };
    }
    // 旧段先进待提取、新段再落盘（同一个历史开段文件，覆盖即搬移），最后才提取——死在提取里两段都不丢
    if (closing !== null) await store.savePending(closing);
    await store.saveHistoryOpen(next);
    if (closing !== null) {
      stats.closed += 1;
      await this.extractEpisode(closing.episodeId, context);
    }
    if (payload.closeAfter) await this.closeHistoryEpisode(next, context);
    this.onChanged();
  }

  /** 历史开段收尾：搬进待提取（已在就不覆盖——那份有提取记账），删历史开段，提取。 */
  private async closeHistoryEpisode(episode: OpenEpisode, context: ExtractContext): Promise<void> {
    const store = this.episodes;
    if (store === null) return;
    if ((await store.loadPending(episode.episodeId)) === null) await store.savePending(episode);
    await store.removeHistoryOpen(episode.sessionId);
    if (context.stats !== null) context.stats.closed += 1;
    await this.extractEpisode(episode.episodeId, context);
  }

  /** 回退的条目那一半：全库读一遍出计划，只改动到的层各自上锁重读、重写一次。不抛。 */
  private async revertEntries(sessionId: string, fromTurn: number): Promise<void> {
    try {
      if (this.initGate !== null) await this.initGate;
      const entries = this.entries;
      if (entries === null) {
        this.log(`[memory] 会话 ${sessionId} 回退到第 ${fromTurn} 轮：记忆服务还没初始化，条目没停用`);
        return;
      }
      const started = this.now();
      const plan = await entries.planRevert(sessionId, fromTurn);
      let muted = 0;
      let restored = 0;
      for (const token of new Set([...plan.mute.keys(), ...plan.restore.keys()])) {
        const outcome = await this.withLock(token, () =>
          entries.applyRevert(token, {
            sessionId,
            fromTurn,
            mute: plan.mute.get(token) ?? new Set(),
            restore: plan.restore.get(token) ?? new Set(),
          }),
        );
        muted += outcome.muted;
        restored += outcome.restored;
      }
      if (muted + restored > 0) {
        this.log(
          `[memory] 会话 ${sessionId} 回退到第 ${fromTurn} 轮：停用 ${muted} 条、恢复旧说法 ${restored} 条` +
            `（扫 ${plan.scanned} 条，${this.now() - started} ms）`,
        );
        this.onChanged();
        // 恢复的旧条回到 active：补算按对账补上缺的向量（停用的不必删行——融合只认 active）
        if (restored > 0) this.scheduleVectorize("all");
      }
    } catch (cause) {
      this.log(`[memory] 会话 ${sessionId} 回退到第 ${fromTurn} 轮时停用条目出错`, cause);
    }
  }

  /** 这次回退的截段跑完了：摘掉它登记的回退点（同轮号的另一次回退各摘各的）。 */
  private settleRevert(sessionId: string, fromTurn: number): void {
    const list = this.pendingReverts.get(sessionId);
    if (list === undefined) return;
    const at = list.indexOf(fromTurn);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) this.pendingReverts.delete(sessionId);
  }

  /** 按还没截段的回退截一份内存里的段（truncateEpisode 的三态：原对象 / null / 截剩的新对象）。
   * 多个回退点取最早的：列表里每次回退的截段都还排在当前任务后面，重说的轮排得更后、进不了
   * 这份段，所以段里 ≥ 最早回退点的轮都已撤回。 */
  private cutByPendingRevert(episode: OpenEpisode): OpenEpisode | null {
    const list = this.pendingReverts.get(episode.sessionId);
    if (list === undefined || list.length === 0) return episode;
    return truncateEpisode(episode, Math.min(...list));
  }

  /** 回退的事件段那一半（队列里跑）：开段读一个文件，待提取段扫 pending/。 */
  private async truncateEpisodes(sessionId: string, fromTurn: number): Promise<void> {
    const store = this.episodes;
    if (store === null) return;
    let cut = 0;
    let dropped = 0;
    const open = await store.loadOpen(sessionId);
    if (open !== null) {
      const next = truncateEpisode(open, fromTurn);
      if (next === null) {
        await store.removeOpen(sessionId);
        this.disarmIdle(sessionId);
        dropped += 1;
      } else if (next !== open) {
        await store.saveOpen(next);
        cut += 1;
      }
    }
    // 从历史生成的开段同样截（生成中途用户回退了这条会话）
    const history = await store.loadHistoryOpen(sessionId);
    if (history !== null) {
      const next = truncateEpisode(history, fromTurn);
      if (next === null) {
        await store.removeHistoryOpen(sessionId);
        dropped += 1;
      } else if (next !== history) {
        await store.saveHistoryOpen(next);
        cut += 1;
      }
    }
    for (const episode of await store.listPending()) {
      if (episode.sessionId !== sessionId) continue;
      const next = truncateEpisode(episode, fromTurn);
      if (next === null) {
        await store.removePending(episode.episodeId);
        dropped += 1;
      } else if (next !== episode) {
        await store.savePending(next);
        cut += 1;
      }
    }
    if (cut + dropped > 0) {
      this.log(`[memory] 会话 ${sessionId} 回退到第 ${fromTurn} 轮：事件段截短 ${cut} 段、整段丢弃 ${dropped} 段`);
      this.onChanged();
    }
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
      const lexical = recallHits({ user, scope }, input.query, this.now());
      const fused = await this.fuseWithVector(lexical, { user, scope }, input.scopeId, input.query);
      const hits = fused;
      await this.entries.recordInjection({
        sessionId: input.sessionId,
        turn: input.turn,
        at: this.now(),
        // text：注入时刻的正文快照（契约）——条目后来被编辑 / 删除，面板上仍要
        // 能看到当时注入了什么
        hits: hits.map((hit) => ({
          id: hit.entry.id,
          text: hit.entry.text,
          score: hit.score,
          ...(hit.pinned ? { pinned: true } : null),
        })),
      });
      return hits;
    } catch (cause) {
      this.log("[memory] 召回出错（回空命中，不拦开轮）", cause);
      return [];
    }
  }

  /**
   * 记忆库的写操作（六种，见 MemoryMutation）。**不走提取队列**：按 token 粒度
   * 互斥（withLock）——提取在跑时不该让用户点个删除等一分钟；同 token 的追加 /
   * 改写仍串行。目标不在 / 入参不合法回 ok:false；任何落盘后 onChanged 一次。
   */
  async mutate(mutation: MemoryMutation): Promise<MemoryMutationOutcome> {
    try {
      const entries = this.entries;
      if (entries === null) return { ok: false, error: "记忆服务还没初始化" };
      const outcome = await this.applyMutation(entries, mutation);
      if (outcome.ok) {
        this.onChanged();
        if ((mutation.op === "edit" || mutation.op === "remove") && outcome.entry !== null) {
          // 正文变了 / 条目删了：行删掉（edit 由补算重算，remove 就此消失）
          await this.vectors?.remove(mutation.token, [mutation.entryId]).catch(() => undefined);
          if (mutation.op === "edit") this.scheduleVectorize(mutation.token);
        }
        if (mutation.op === "addManual" && outcome.entry !== null) {
          this.scheduleVectorize(mutation.token);
        }
        // 撤销类会让条目回到 active / 换了层：补算按对账补上缺的向量
        if (mutation.op === "restorePrevious" || mutation.op === "returnToWorkspace") {
          this.scheduleVectorize("all");
        }
      }
      return outcome;
    } catch (cause) {
      this.log("[memory] 记忆库写操作出错", mutation.op, cause);
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  private async applyMutation(
    entries: MemoryEntryStore,
    mutation: MemoryMutation,
  ): Promise<MemoryMutationOutcome> {
    const now = this.now();
    switch (mutation.op) {
      case "edit": {
        const text = mutation.text.trim();
        if (text === "") return { ok: false, error: "正文不能为空" };
        const entry = await this.withLock(mutation.token, () =>
          entries.updateEntry(mutation.token, mutation.entryId, (current) => ({
            ...current,
            text,
            editedAt: now,
          })),
        );
        return entry === null ? { ok: false, error: "条目不在这一层" } : { ok: true, entry };
      }
      case "remove": {
        const entry = await this.withLock(mutation.token, () =>
          entries.removeEntry(mutation.token, mutation.entryId),
        );
        return { ok: true, entry };
      }
      case "setStatus": {
        const entry = await this.withLock(mutation.token, () =>
          entries.updateEntry(mutation.token, mutation.entryId, (current) => {
            // 恢复使用：agent 停用时记的理由随之失效
            const { mutedReason: _dropped, ...rest } = current;
            return mutation.status === "active" ? { ...rest, status: "active" } : { ...current, status: "muted" };
          }),
        );
        return entry === null ? { ok: false, error: "条目不在这一层" } : { ok: true, entry };
      }
      case "addManual": {
        const entry = await this.withLock(mutation.token, () =>
          entries.addManual(mutation.token, {
            type: mutation.type,
            text: mutation.text,
            reason: mutation.reason,
            scopeId: mutation.scopeId,
            now,
          }),
        );
        return entry === null
          ? { ok: false, error: "正文为空，或偏好 / 经验没带理由" }
          : { ok: true, entry };
      }
      case "restorePrevious":
        return this.restorePrevious(entries, mutation.token, mutation.entryId);
      case "returnToWorkspace": {
        const current = await entries.listByToken(mutation.token).then((list) =>
          list.find((entry) => entry.id === mutation.entryId),
        );
        if (current === undefined) return { ok: false, error: "条目不在这一层" };
        const origin = current.promotedFrom;
        if (current.layer !== "user" || origin === undefined) {
          return { ok: false, error: "这条不是自动升到所有工作区的，没有原工作区可回" };
        }
        // 双 token 按字典序上锁，避免与提取的「本作用域 + user」两把锁死锁
        const entry = await this.withLockPair(mutation.token, origin, () =>
          entries.moveEntry(mutation.token, origin, mutation.entryId, (target) => {
            const { promotedFrom: _dropped, ...rest } = target;
            return { ...rest, layer: "workspace" };
          }),
        );
        return entry === null ? { ok: false, error: "条目不在这一层" } : { ok: true, entry };
      }
    }
  }

  /**
   * 恢复旧说法（restorePrevious）：entryId 是顶掉旧条的新条（提取判冲突或 agent 修订），
   * 它 conflictWith 指的旧条回 active，新条标 muted——不删，演变链照常可见。旧条已删的
   * 回 ok:false，不动新条。
   */
  private async restorePrevious(
    entries: MemoryEntryStore,
    token: string,
    entryId: string,
  ): Promise<MemoryMutationOutcome> {
    const fresh = await entries.listByToken(token).then((list) => list.find((entry) => entry.id === entryId));
    if (fresh === undefined) return { ok: false, error: "条目不在这一层" };
    const oldId = fresh.conflictWith;
    if (oldId === undefined) return { ok: false, error: "这条没有顶掉别的条目" };
    // 旧条可能在：同层、user 层，或（新条自动升层了）新条原来的作用域层
    const candidates = new Set([token, MEMORY_USER_TOKEN]);
    if (fresh.promotedFrom !== undefined) candidates.add(fresh.promotedFrom);
    if (fresh.scopeId !== undefined) candidates.add(entries.tokenOf(fresh.scopeId));
    let oldToken: string | null = null;
    for (const candidate of candidates) {
      const list = await entries.listByToken(candidate);
      if (list.some((entry) => entry.id === oldId)) {
        oldToken = candidate;
        break;
      }
    }
    if (oldToken === null) return { ok: false, error: "旧说法已经删了，没有可恢复的" };
    const restoreToken = oldToken;
    return this.withLockPair(token, restoreToken, async () => {
      await entries.updateEntry(restoreToken, oldId, (target) => ({ ...target, status: "active" }));
      const entry = await entries.updateEntry(token, entryId, (target) => ({ ...target, status: "muted" }));
      return entry === null ? { ok: false, error: "条目不在这一层" } : { ok: true, entry };
    });
  }

  /* ---------- agent 的记忆工具 ---------- */

  /**
   * memory_search / memory_revise / memory_retire（主进程已判根会话、已解好 scopeId）。
   * 可见范围恒为「user 层 + 本作用域层」——别的工作区的记忆不可查也不可改。写走与
   * 记忆库同一套按 token 互斥；写盘后 onChanged 一次。任何内部错误回 ok:false + 人话。
   */
  async agentTool(input: {
    sessionId: string;
    scopeId: string;
    turn: number;
    call: MemoryAgentCall;
  }): Promise<MemoryAgentOutcome> {
    try {
      const entries = this.entries;
      if (entries === null) return { ok: false, error: "记忆服务还没初始化" };
      const { call } = input;
      if (call.op === "search") return { ok: true, entries: await this.agentSearch(entries, input.scopeId, call.query) };
      const located = await this.locate(entries, input.scopeId, call.entryId);
      if ("error" in located) return { ok: false, error: located.error };
      const { token, entry: target } = located;
      if (call.op === "retire") {
        const reason = call.reason.trim();
        const entry = await this.withLock(token, () =>
          entries.updateEntry(token, target.id, (current) => ({
            ...current,
            status: "muted",
            ...(reason !== "" ? { mutedReason: reason } : null),
          })),
        );
        if (entry === null) return { ok: false, error: "条目不在了" };
        this.onChanged();
        return { ok: true, entries: [entry] };
      }
      // revise
      const text = call.text.trim();
      if (text === "") return { ok: false, error: "新说法不能为空" };
      if (call.reason.trim() === "") return { ok: false, error: "要写理由：用户哪句话纠正了它" };
      if (target.status === "stale") {
        const newer = await this.newerOf(entries, input.scopeId, target.id);
        return {
          ok: false,
          error:
            newer === null
              ? `${memoryShortId(target.id)} 已经过时了；要改请先 memory_search 找到现行的那条`
              : `${memoryShortId(target.id)} 已经被 ${memoryShortId(newer.id)} 顶掉了；要改请修订 ${memoryShortId(newer.id)}`,
        };
      }
      if (normalizeText(text) === normalizeText(target.text)) {
        return { ok: false, error: "新说法和旧条一字不差，不用修订" };
      }
      const pair = await this.withLock(token, () =>
        entries.appendRevision(token, target.id, {
          text,
          reason: call.reason,
          sessionId: input.sessionId,
          turn: input.turn,
          now: this.now(),
        }),
      );
      if (pair === null) return { ok: false, error: "条目不在了" };
      this.onChanged();
      this.scheduleVectorize(token);
      return { ok: true, entries: pair };
    } catch (cause) {
      this.log("[memory] 记忆工具出错", input.call.op, cause);
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * memory_search：可见范围里的 active 条目，按 searchMemories 排序（逐字 + IDF，与轮前
   * 召回的门控词法分开——理由见 retrieve.ts），向量可用时再融合。
   */
  private async agentSearch(entries: MemoryEntryStore, scopeId: string, query: string): Promise<MemoryEntry[]> {
    const [user, scope] = await Promise.all([entries.listUser(), entries.listScope(scopeId)]);
    const active = dedupeById([...user, ...scope]).filter(isRecallable);
    const ranked = searchMemories(active, query, { limit: AGENT_SEARCH_LIMIT, now: this.now() });
    const fused = await this.fuseWithVector(ranked, { user, scope }, scopeId, query, {
      limit: AGENT_SEARCH_LIMIT,
      maxChars: AGENT_SEARCH_MAX_CHARS,
    });
    return fused.map((hit) => hit.entry);
  }

  /**
   * 按全 id 或短 id（前缀，至少 memoryShortId 那么长）在可见范围里定位一条。全 id 先认；
   * 前缀撞了两条以上报歧义、列出候选——不猜。
   */
  private async locate(
    entries: MemoryEntryStore,
    scopeId: string,
    entryId: string,
  ): Promise<{ token: string; entry: MemoryEntry } | { error: string }> {
    const wanted = entryId.trim();
    const minPrefix = memoryShortId("mem_00000000-").length;
    const pools: { token: string; list: MemoryEntry[] }[] = [
      { token: MEMORY_USER_TOKEN, list: await entries.listUser() },
      { token: entries.tokenOf(scopeId), list: await entries.listScope(scopeId) },
    ];
    for (const pool of pools) {
      const exact = pool.list.find((entry) => entry.id === wanted);
      if (exact !== undefined) return { token: pool.token, entry: exact };
    }
    if (wanted.length < minPrefix) {
      return { error: `找不到 ${wanted}：id 至少要给到 ${minPrefix} 位（召回块里方括号中的那一段）` };
    }
    const matches = pools.flatMap((pool) =>
      pool.list.filter((entry) => entry.id.startsWith(wanted)).map((entry) => ({ token: pool.token, entry })),
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) {
      return { error: `找不到 ${wanted}（只能改本工作区与所有工作区层的记忆）；先用 memory_search 查` };
    }
    return { error: `${wanted} 对上了多条：${matches.map((match) => match.entry.id).join("、")}；请给全 id` };
  }

  /** 顶掉某条的新条（沿 conflictWith 反查，可见范围内；没有回 null）。 */
  private async newerOf(entries: MemoryEntryStore, scopeId: string, oldId: string): Promise<MemoryEntry | null> {
    const pool = [...(await entries.listUser()), ...(await entries.listScope(scopeId))];
    return pool.find((entry) => entry.conflictWith === oldId && isRecallable(entry)) ?? pool.find((entry) => entry.conflictWith === oldId) ?? null;
  }

  /* ---------- 向量召回 ---------- */

  /**
   * 召回融合：向量可用时「加权 RRF（向量 3 : 字面 1，k=60）」——选型报告实测
   * 等权 RRF 会把强向量模型拖下来（gemma 0.43→0.36），对强向量要按臂强弱加权；
   * 真实记忆条目上的小评测数字见融合 commit 正文。向量冷启动（llama-server
   * 没在跑）不等待：本轮照词法，后台拉起，下一轮生效——轮前路径的延迟预算
   * （主进程 4 秒转发超时）不陪模型加载。
   */
  private async fuseWithVector(
    lexical: MemoryHit[],
    layers: { user: readonly MemoryEntry[]; scope: readonly MemoryEntry[] },
    scopeId: string,
    query: string,
    budget: { limit: number; maxChars: number } = { limit: RECALL_LIMIT, maxChars: RECALL_MAX_CHARS },
  ): Promise<MemoryHit[]> {
    const config = this.vectorConfig;
    const server = this.embedServer;
    const vectors = this.vectors;
    if (config === null || server === null || vectors === null || this.entries === null) return lexical;
    if (!server.isRunning()) {
      void server.ready(); // 后台热身，下一轮用得上
      return lexical;
    }
    try {
      const embedded = await server.embed([config.model.queryPrefix + query]);
      const queryVector = embedded === null ? null : (embedded[0] ?? null);
      if (queryVector === null || queryVector.length !== config.model.dims) return lexical;
      const manifest = await vectors.manifest();
      if (manifest === null || manifest.model !== config.model.id) return lexical;
      const scopeToken = this.entries.tokenOf(scopeId);
      const [userVectors, scopeVectors] = await Promise.all([
        vectors.load(MEMORY_USER_TOKEN, config.model.dims).catch(() => null),
        vectors.load(scopeToken, config.model.dims).catch(() => null),
      ]);
      const vectorRanked: { id: string; score: number }[] = [];
      if (userVectors !== null) vectorRanked.push(...dotProductRank(queryVector, userVectors, 50));
      if (scopeVectors !== null) vectorRanked.push(...dotProductRank(queryVector, scopeVectors, 50));
      // 余弦下限：低于它的不算「相关」，不进融合——否则 RRF 只看名次，无关问句也会
      // 把 top-5 当命中注满（下限按模型给，见 MemoryVectorModel.minCosine）
      const relevant = vectorRanked.filter((hit) => hit.score >= config.model.minCosine);
      if (relevant.length === 0) return lexical;
      // 两层各自打分后必须按余弦全局重排：不能直接 user 前 50 + scope 前 50，
      // 否则 RRF 的名次与相似度无关，user 层够大时 scope 甚至整层进不了融合。
      relevant.sort((a, b) => b.score - a.score);
      const pinned = lexical.filter((hit) => hit.pinned === true);
      const pinnedIds = new Set(pinned.map((hit) => hit.entry.id));
      // 与词法同一准入门：muted / stale 不能借向量复活；user 层常驻偏好只走
      // pinned 通道，既保留标志也避免向量 / 词法两份分把它算成普通命中。
      const byId = new Map(
        dedupeById([...layers.user, ...layers.scope])
          .filter((entry) => isRecallable(entry) && !pinnedIds.has(entry.id))
          .map((entry) => [entry.id, entry]),
      );
      const fused = fuseRanked(
        relevant,
        lexical.filter((hit) => hit.pinned !== true),
        byId,
      );
      // 与词法召回同预算与同一套装车规则（含同源复述只留一条）：融合只是重排，
      // 不能把候选量放大成几十条跨 IPC 与注入账
      return [
        ...pinned,
        ...selectHits(fused, { limit: budget.limit, maxChars: budget.maxChars, taken: pinned.map((hit) => hit.entry) }),
      ];
    } catch (cause) {
      this.log("[memory] 向量融合失败（本轮退词法）", cause);
      return lexical;
    }
  }

  /** 设置变了：null = 关（停 llama-server、挂起补算）；换模型 = 清库重算 + 补算。 */
  setVectorConfig(config: MemoryVectorServiceConfig | null): void {
    // **这里不取消下载**：模型还没下完时主进程每轮同步的配置就是 null（文件不在），
    // 以前把 null 当「向量关了」取消下载，下载中只要一轮对话落定就被掐断（2026-10-30
    // 打包版卡在 22%）。取消只走 cancelModelDownload（主进程在用户关向量 / 换模型时发）。
    // 同配置消息是每轮落定都会重复收到的同步，不应再触发全量对账与 idle 广播。
    if (config !== null && JSON.stringify(this.vectorConfig) === JSON.stringify(config)) return;
    const previous = this.vectorConfig?.model.id ?? null;
    this.vectorConfig = config;
    if (config === null) {
      this.embedServer?.stop();
      this.backfill = null;
      return;
    }
    this.embedServer?.setIdleUnloadMs(config.idleUnloadMs);
    // 只有「运行中真的换了模型」才在这里清库。previous === null 是服务刚拉起（应用
    // 启动 / 服务重启 / 开关刚打开）——那时盘上的向量库可能就是这个模型算的，清掉
    // 等于每次开应用都整库重算一遍（审查 2026-10-29 发现）。盘上 manifest 与配置的
    // 模型对不对得上，交给 runBackfill 的 manifest 对账判：对不上它照样整库重置
    if (previous !== null && previous !== config.model.id) {
      // 换模型：旧维度对不上新模型，整库清掉重算（向量只是缓存）
      void this.vectors
        ?.reset(config.model.id, config.model.dims, this.now())
        .then(() => this.scheduleVectorize("all"))
        .catch((cause: unknown) => this.log("[memory] 向量库重置失败", cause));
      return;
    }
    this.scheduleVectorize("all");
  }

  /** 取消在途的模型下载（用户关向量 / 换模型；契约见 cancelModelDownload）。没在下载 = 空操作。 */
  cancelModelDownload(): void {
    this.downloadAbort?.abort();
  }

  /**
   * 停机（runtime 在 shutdown 命令 / SIGTERM / 进程 exit 时调）：取消在途下载、
   * 同步 kill llama-server。幂等；只做同步动作——exit 事件里不能再等 promise。
   */
  shutdown(): void {
    this.downloadAbort?.abort();
    this.embedServer?.stop();
  }

  /** 电池状态（主进程 powerMonitor 转发）：用电池时挂起批量补算，回电源续跑。 */
  setPower(onBattery: boolean): void {
    const wasDeferred = this.backfill?.state === "deferred-battery";
    this.onBattery = onBattery;
    if (!onBattery && wasDeferred) this.scheduleVectorize("all");
  }

  /** 服务运行态（设置页 vectorState 用）。 */
  async vectorState(): Promise<{
    llamaRunning: boolean;
    backfill: { state: "running" | "deferred-battery"; done: number; total: number } | null;
    vectors: { model: string; dims: number; entries: number } | null;
  }> {
    const manifest = (await this.vectors?.manifest()) ?? null;
    let counted = 0;
    if (this.vectors !== null && this.entries !== null) {
      for (const layer of await this.entries.listLayers()) {
        counted += await this.vectors.count(layer.token).catch(() => 0);
      }
    }
    return {
      llamaRunning: this.embedServer?.isRunning() ?? false,
      backfill: this.backfill,
      vectors: manifest === null ? null : { model: manifest.model, dims: manifest.dims, entries: counted },
    };
  }

  /** 下载模型文件（同一时刻一个；进度经 onDownloadProgress 推）。 */
  startModelDownload(input: {
    requestId: string;
    sources: readonly string[];
    targetPath: string;
    sha256: string;
    sizeBytes: number;
  }): void {
    if (this.downloadInFlight !== null || this.vectorDeps === null) return;
    const controller = new AbortController();
    this.downloadAbort = controller;
    this.downloadInFlight = downloadWithFallback({
      sources: input.sources,
      targetPath: input.targetPath,
      sha256: input.sha256,
      sizeBytes: input.sizeBytes,
      fetchImpl: this.vectorDeps.fetchImpl,
      signal: controller.signal,
      onProgress: (event) => {
        // 取消之后的残余进度不报；取消本身的终态要报（界面据此收起进度条）
        if (controller.signal.aborted && event.phase !== "cancelled") return;
        this.onDownloadProgress({
          requestId: input.requestId,
          phase: event.phase,
          source: event.source,
          received: event.received,
          total: event.total,
          ...(event.error !== undefined ? { error: event.error } : null),
        });
      },
    })
      .then(() => undefined)
      .catch((cause: unknown) => this.log("[memory] 模型下载抛错", cause))
      .finally(() => {
        this.downloadInFlight = null;
        if (this.downloadAbort === controller) this.downloadAbort = null;
      });
  }

  /**
   * 补算排程：token = 某层或 "all"。当前轮在跑时只记补跑标记，结束后
   * 再全量对账一轮，迟到的新条目不会等下一次任意触发。
   * 用电池且设置了推迟 → 记 deferred-battery 挂起，setPower(false) 续跑。
   */
  private scheduleVectorize(token: string): void {
    if (this.vectorConfig === null || this.vectors === null) return;
    if (this.onBattery && this.vectorConfig.deferOnBattery) {
      // 已在跑的让它在下一批检查点自行挂起
      if (this.backfill === null) {
        this.backfill = { state: "deferred-battery", done: 0, total: 0 };
      }
      return;
    }
    if (this.backfillInFlight !== null) {
      this.backfillRerunRequested = true;
      return;
    }
    this.backfillInFlight = this.runBackfill(token)
      .catch((cause: unknown) => {
        this.backfill = null;
        this.log("[memory] 向量补算失败（已接住，下次排程重试）", cause);
      })
      .finally(() => {
        this.backfillInFlight = null;
        if (this.backfillRerunRequested) {
          this.backfillRerunRequested = false;
          this.scheduleVectorize("all");
        }
      });
  }

  /** 批量补算主体：对账缺失 → 分批嵌入（bs=32）→ upsert，批间查电池与配置。 */
  private async runBackfill(trigger: string): Promise<void> {
    const config = this.vectorConfig;
    const entries = this.entries;
    const vectors = this.vectors;
    const server = this.embedServer;
    if (config === null || entries === null || vectors === null || server === null) return;
    // manifest 对账：没算过（首次启用）先写清单
    const manifest = await vectors.manifest();
    if (manifest === null) {
      await vectors.reset(config.model.id, config.model.dims, this.now());
    } else if (manifest.model !== config.model.id) {
      await vectors.reset(config.model.id, config.model.dims, this.now());
    }
    // "all" 一次读全部层连同条目（每个层文件读一遍）；单层只读那一层
    const layers =
      trigger === "all"
        ? await entries.readAllLayers()
        : [{ token: trigger, entries: await entries.listByToken(trigger).catch((): MemoryEntry[] => []) }];
    const todo: { token: string; missing: MemoryEntry[] }[] = [];
    let total = 0;
    for (const layer of layers) {
      const list = layer.entries;
      const known = new Set((await vectors.load(layer.token, config.model.dims).catch(() => null))?.ids ?? []);
      const missing = list.filter((entry) => !known.has(entry.id) && isRecallable(entry));
      if (missing.length > 0) {
        todo.push({ token: layer.token, missing });
        total += missing.length;
      }
    }
    if (total === 0) {
      this.backfill = null;
      this.onBackfillProgress({ state: "idle", done: 0, total: 0 });
      return;
    }
    let done = 0;
    this.backfill = { state: "running", done: 0, total };
    this.onBackfillProgress({ state: "running", done: 0, total });
    for (const { token, missing } of todo) {
      for (let at = 0; at < missing.length; at += 32) {
        // 检查点：配置被关 / 换了模型 → 本轮作废（下一轮排程重新对账）
        if (this.vectorConfig === null || this.vectorConfig.model.id !== config.model.id) return;
        // 检查点：电池 + 推迟 → 挂起
        if (this.onBattery && config.deferOnBattery) {
          this.backfill = { state: "deferred-battery", done, total };
          this.onBackfillProgress({ state: "deferred-battery", done, total });
          return;
        }
        const batch = missing.slice(at, at + 32);
        const texts = batch.map((entry) => (config.model.docPrefix ?? "") + entry.text);
        const embedded = await server.embed(texts);
        if (embedded === null) {
          this.log("[memory] 补算的嵌入调用失败（挂起，下次触发续跑）");
          this.backfill = { state: "deferred-battery", done, total };
          return;
        }
        for (let index = 0; index < batch.length; index += 1) {
          const vector = embedded[index];
          if (vector === undefined) continue;
          await vectors.upsert(token, batch[index]!.id, vector, config.model.dims);
        }
        done += batch.length;
        this.backfill = { state: "running", done, total };
        this.onBackfillProgress({ state: "running", done, total });
      }
    }
    this.backfill = null;
    this.onBackfillProgress({ state: "idle", done: total, total });
    this.onChanged();
  }

  /* ---------- 锁 ---------- */

  /** 单 token 互斥：同层操作串行，不同层并行。 */
  private async withLock<T>(token: string, job: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(token) ?? Promise.resolve();
    const run = previous.then(job, job);
    const done = run.catch(() => undefined);
    this.locks.set(token, done);
    return run;
  }

  /** 双 token 互斥（提取落定、恢复旧说法、搬回原工作区）：按字典序上锁，避免死锁。
   * 两个 token 相同时只上一把（同一把锁重入会自己等自己）。 */
  private async withLockPair<T>(a: string, b: string, job: () => Promise<T>): Promise<T> {
    if (a === b) return this.withLock(a, job);
    const ordered = [a, b].sort();
    return this.withLock(ordered[0]!, () => this.withLock(ordered[1]!, job));
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
    if (this.initGate !== null) await this.initGate;
    const store = this.episodes;
    if (store === null) {
      this.log(
        `[memory] 会话 ${sessionId} 第 ${turn.turn} 轮不进事件段——记忆服务还没初始化（${this.initGate === null ? "没收到 init" : "init 失败"}）`,
      );
      return;
    }
    // 该会话若有提完没收尾干净 / 提取失败的待提取段，趁这轮补一把
    // （启动清扫之外的唯一重试触发点；只扫 pending/——各会话的开段文件不必每轮都读）
    for (const leftover of await store.listPending()) {
      if (leftover.sessionId === sessionId) {
        await this.extractEpisode(leftover.episodeId);
      }
    }
    const episode = await store.loadOpen(sessionId);
    const admission = admissionOf(episode, turn);
    if (admission.kind === "ignore") {
      this.log(
        `[memory] 会话 ${sessionId} 第 ${turn.turn} 轮不进事件段——轮号不大于开段已收到的第 ${episode?.toTurn ?? "?"} 轮` +
          "（重复投递，或会话回退后轮号回落）",
      );
      return;
    }
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
    this.onChanged(); // 事件段状态变了（整理中徽标 / 记住的轮）
  }

  /** 切段二分类：读不懂 / 调用失败按 same（并段比切段保守，判错代价更小）。 */
  private async classify(
    episode: OpenEpisode,
    turn: MemoryEpisodeTurn,
    call: MemoryCallModel = this.callModel,
  ): Promise<"same" | "new"> {
    const last = episode.turns[episode.turns.length - 1];
    if (last === undefined) return "new"; // 空段不该来问；按新事件开段最保守
    const raw = await call(
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
    this.onChanged(); // 闲置收尾：整理中徽标变化（提取完 extractEpisode 还会再报一次）
    await this.extractEpisode(current.episodeId);
  }

  /**
   * 提取一个已收尾的段：三类逐类调模型，逐类记账（extracted），全提完归档删文件。
   * 某类失败（模型 / 落盘）：该类记账不动，段留在 pending——启动清扫或该会话下一轮
   * 落定时重试，已提成的类不会重提（不重复落条目）。
   */
  private async extractEpisode(
    episodeId: string,
    context: ExtractContext = { call: this.callModel, stats: null },
  ): Promise<void> {
    if (this.extracting.has(episodeId)) return;
    this.extracting.add(episodeId);
    try {
      await this.extractEpisodeOnce(episodeId, context);
    } finally {
      this.extracting.delete(episodeId);
    }
  }

  private async extractEpisodeOnce(episodeId: string, context: ExtractContext): Promise<void> {
    const store = this.episodes;
    const entries = this.entries;
    if (store === null || entries === null) return;
    if (this.chore === null) {
      this.log("[memory] 有待提取的事件段，但没有家务活模型——留在盘上等模型配上");
      return;
    }
    const loaded = await store.loadPending(episodeId);
    if (loaded === null) return;
    // 回退可能在提取途中把它换成截短的那份（见下面的 cutByPendingRevert）
    let episode: OpenEpisode = loaded;
    let pub = toMemoryEpisode(episode);
    // 全提完的段再被扫到（归档后、删文件前被杀的窗口）：补归档 + 删文件。
    // 归档可能重复一行（log 只追加）——UI 按 episodeId 读时去重，无害；
    // 危险的是重复提取落条目，那由逐类记账拦住
    if (EXTRACT_TYPES.every((type) => episode.extracted[type])) {
      await store.archive(pub);
      await store.removePending(episodeId);
      this.onChanged(); // 整理结束：pending 清空、段归档
      return;
    }
    for (const type of EXTRACT_TYPES) {
      if (episode.extracted[type]) continue;
      // 一类一次调用；调用中途到达回退 = 这次输出作废，按截后的轮重来（每次重来段都严格变短，有界）
      let raw: string | null = null;
      let candidates: MemoryEntry[] | undefined;
      for (;;) {
        // 回退在这份段读出之后到达（截段还排在队列后面）：先按回退截掉，被撤回的轮不进提示词
        const cut = this.cutByPendingRevert(episode);
        if (cut === null) {
          // 整段都被撤回：不提了，丢掉（排队的截段再扫 pending/ 时它已经不在）
          await store.removePending(episodeId);
          this.log(`[memory] 段 ${episodeId} 的轮全部随会话回退撤回，不再提取`);
          this.onChanged();
          return;
        }
        if (cut !== episode) {
          episode = cut;
          pub = toMemoryEpisode(episode);
          await store.savePending(episode);
        }
        // 冲突候选不按段的时间筛：比这段晚的新说法也要给模型看（带日期），判出矛盾时
        // 由落盘侧按 at 定向——这段里的旧说法落成过时，不会顶掉后来的新说法（appendScope）
        const pool = [...(await entries.listScope(episode.scopeId)), ...(await entries.listUser())];
        // agent 在这段里当场改写过的条目进提示词：同一件事别再写一遍
        const recorded = agentRecordedIn(pool, pub);
        candidates = undefined;
        if (type === "preference") {
          const episodeText = episode.turns.map((turn) => `${turn.userText}\n${turn.assistantText}`).join("\n");
          candidates = preferenceCandidates(pool, episodeText);
        }
        const system =
          type === "fact" ? FACT_SYSTEM_PROMPT : type === "preference" ? PREFERENCE_SYSTEM_PROMPT : INSIGHT_SYSTEM_PROMPT;
        // 「当前日期」取段尾那一轮的时间：相对时间（明天 / 上周）要按对话发生那天换算——
        // 从历史生成的段是几周前的；实时段在启动清扫里补提时也可能隔了几天
        raw = await context.call(
          system,
          buildExtractPrompt({ turns: episode.turns, now: episode.lastAt, candidates, recorded }),
        );
        if (raw === null || this.cutByPendingRevert(episode) === episode) break;
        // 不按草稿的支撑轮过滤留用：模型读过被撤回的话，只引前面轮号的草稿也可能带着它的内容
        this.log(`[memory] 段 ${episodeId} 的 ${type} 提取调用期间会话回退了，这次输出作废，按截后的轮重提`);
      }
      if (raw === null) {
        this.log(`[memory] 段 ${episodeId} 的 ${type} 提取调用失败（该类记账不动，下次重试）`);
        if (context.stats !== null) context.stats.failed += 1;
        continue;
      }
      const candidateIds = new Set((candidates ?? []).map((entry) => entry.id));
      const drafts: MemoryDraft[] = parseExtractReply(raw, type, candidateIds);
      const scopeToken = entries.tokenOf(episode.scopeId);
      // 两把锁：跨工作区偏好直接落 user 层、冲突的旧条可能在 user 层被标 stale
      const written = await this.withLockPair(scopeToken, MEMORY_USER_TOKEN, () =>
        entries.appendScope(episode.scopeId, pub, drafts),
      );
      this.onChanged();
      this.scheduleVectorize(written.some((entry) => entry.layer === "user") ? "all" : scopeToken);
      if (context.stats !== null) {
        for (const entry of written) context.stats.written[entry.type] += 1;
      }
      if (written.length > 0) {
        this.entryWrites.set(episode.sessionId, (this.entryWrites.get(episode.sessionId) ?? 0) + 1);
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
      this.onChanged(); // 整理结束：pending 清空、段归档
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
