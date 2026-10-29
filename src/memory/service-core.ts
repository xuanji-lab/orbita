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

/** memory_search 一次最多回几条、正文总预算多少（给 agent 定位用，比轮前注入宽） */
const AGENT_SEARCH_LIMIT = 8;
const AGENT_SEARCH_MAX_CHARS = 4000;


export class MemoryServiceCore {
  private readonly callModel: MemoryCallModel;
  private readonly now: () => number;
  private readonly idleCloseMs: number;
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
  /** 串行队列（切段 / 提取都走它） */
  private queue: Promise<void> = Promise.resolve();
  /** 条目层文件级的互斥：提取的追加（appendScope）与记忆库的改写（整层重写）
 * 不能交错，否则重写会丢掉刚追加的行；但记忆库写不该排在可能分钟级的提取
   * 队列后面——按 token 粒度互斥，不同作用域互不等待 */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
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
    // 关闭向量始终要取消下载（即便配置本来已是 null）；其余同配置消息是每轮
    // 落定都会重复收到的同步，不应再触发全量对账与 idle 广播。
    if (config === null) this.downloadAbort?.abort();
    if (config !== null && JSON.stringify(this.vectorConfig) === JSON.stringify(config)) return;
    const previous = this.vectorConfig?.model.id ?? null;
    if (previous !== null && config !== null && previous !== config.model.id) {
      this.downloadAbort?.abort();
    }
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
        if (controller.signal.aborted) return;
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
    const layers = trigger === "all" ? await entries.listLayers() : [{ token: trigger, count: 0 }];
    const todo: { token: string; missing: MemoryEntry[] }[] = [];
    let total = 0;
    for (const layer of layers) {
      const list = await entries.listByToken(layer.token).catch(() => []);
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
    // （启动清扫之外的唯一重试触发点；扫两个小目录，代价可忽略）
    const { pending } = await store.listAll();
    for (const leftover of pending) {
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
  private async classify(episode: OpenEpisode, turn: MemoryEpisodeTurn): Promise<"same" | "new"> {
    const last = episode.turns[episode.turns.length - 1];
    if (last === undefined) return "new"; // 空段不该来问；按新事件开段最保守
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
    this.onChanged(); // 闲置收尾：整理中徽标变化（提取完 extractEpisode 还会再报一次）
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
      this.onChanged(); // 整理结束：pending 清空、段归档
      return;
    }
    const episodeText = episode.turns
      .map((turn) => `${turn.userText}\n${turn.assistantText}`)
      .join("\n");
    for (const type of EXTRACT_TYPES) {
      if (episode.extracted[type]) continue;
      const pool = [...(await entries.listScope(episode.scopeId)), ...(await entries.listUser())];
      // agent 在这段里当场改写过的条目进提示词：同一件事别再写一遍
      const recorded = agentRecordedIn(pool, pub);
      let candidates: MemoryEntry[] | undefined;
      if (type === "preference") {
        candidates = preferenceCandidates(pool, episodeText);
      }
      const system =
        type === "fact" ? FACT_SYSTEM_PROMPT : type === "preference" ? PREFERENCE_SYSTEM_PROMPT : INSIGHT_SYSTEM_PROMPT;
      const raw = await this.callModel(
        system,
        buildExtractPrompt({ turns: episode.turns, now: this.now(), candidates, recorded }),
      );
      if (raw === null) {
        this.log(`[memory] 段 ${episodeId} 的 ${type} 提取调用失败（该类记账不动，下次重试）`);
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
