/**
 * 手机的「任务清单」——`sessions.list` 的结果、以及变化时推给在看的手机的增量。
 *
 * 规则（规格 4.2 / 4.7）：
 * - 只列根会话（没有母会话、也不是自动化新开的），30 天内动过的，按 updatedAt 倒序，最多 200 条，
 *   超出的 `truncated: true`。**能不能进清单只看一个判据**（`isListableSession`）：`sessions.list` 的全量
 *   构建与 agent 事件触发的增量刷新都调它——手机上四个「点会话」的方法只认这份清单，增量刷新要是
 *   少判一条，子会话出一个事件就混进了准入集合（2026-11-25 审查 M1）。
 * - 每条的 `state` 用契约里的 `deriveMobileSessionState`；`lastLine` 与 `planAwaiting` 要读转录尾部
 *   才知道——**一次清单刷新最多读 40 条会话的尾部**，其余的沿用缓存（按「文件大小 + 修改时间」判
 *   没变，没变不重读），没有缓存的留空。
 * - 变了才推：`sessions.changed` 只带变过的会话与消失了的 id。哪条会话脏了由 agent 事件说了算
 *   （phase / stats / fileTurn / title / compaction），攒 400 毫秒一起重算。
 * - `settledRecently` 只在这次运行里记（重启就丢）：刚从在跑变成空闲、还没人点进这条会话时，把它
 *   显示成「跑完没看」而不是「空闲」；`unread.clear` 时清掉。
 *
 * 纯核 + 依赖注入：不 import electron，`node --test` 直测。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { isRootSession, type SessionMeta, type SessionRecord } from "../../shared/session.ts";
import { planAwaitingIn } from "../../shared/plan.ts";
import { lastAssistantLineOf } from "../../shared/mobile-tail.ts";
import { foldRevertRecords } from "../session/store.ts";
import { deriveMobileSessionState, type SessionSummary } from "../../shared/mobile.ts";

/** 一次清单刷新最多现读几条会话的尾部 */
const TAIL_READS_PER_LIST = 40;
/** 只列最近多少天内动过的根会话 */
const LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** 清单最多多少条 */
const LIST_MAX = 200;
/** 脏会话攒多久一起重算（毫秒） */
const FLUSH_DELAY_MS = 400;

export interface CatalogDeps {
  listMetas(): Promise<SessionMeta[]>;
  /** 工作区 id → 名字（此刻的名字；工作区没了 / 没有工作区回 null） */
  listWorkspaces(): Promise<readonly { id: string; name: string }[]>;
  tailRecords(id: string): Promise<SessionRecord[]>;
  /** 转录文件的（大小, 修改时间）；不存在回 null——尾部缓存靠它判没变 */
  tailStat(id: string): Promise<{ size: number; mtimeMs: number } | null>;
  /** 运行态表里这条会话的档；没在跑回 undefined */
  phaseOf(id: string): string | undefined;
  now(): number;
}

/** 一条会话的「读尾部才知道」的部分，按文件指纹缓存 */
interface TailFacts {
  size: number;
  mtimeMs: number;
  lastLine: string | null;
  planAwaiting: boolean;
}

interface Watch {
  send(changed: SessionSummary[], removed: string[]): void;
  /** 上次发给这个观看者的快照；null = 还没发过，下一次 flush 全量给 */
  last: Map<string, SessionSummary> | null;
}

export class MobileCatalog {
  private readonly deps: CatalogDeps;
  /** 当前清单（200 条的窗口）——`tail.load` / `reply` / `stop` / `unread.clear` 的准入集合也用它（安全审查第 7 条） */
  private snapshot = new Map<string, SessionSummary>();
  private truncated = false;
  private readonly tailCache = new Map<string, TailFacts>();
  private readonly settled = new Set<string>();
  private readonly dirty = new Set<string>();
  private readonly watches = new Set<Watch>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** 构建与 flush 串行化：两路并发重算会让快照对不上 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: CatalogDeps) {
    this.deps = deps;
  }

  /** 完整清单（`sessions.list` 的应答），顺手把快照刷新成这一份 */
  list(): Promise<{ sessions: SessionSummary[]; truncated: boolean }> {
    return this.exclusive(async () => {
      const result = await this.buildList();
      this.snapshot = new Map(result.sessions.map((session) => [session.id, session]));
      this.truncated = result.truncated;
      return result;
    });
  }

  /** 此刻清单里的 id（四个「点会话」的方法只认这个集合） */
  snapshotIds(): ReadonlySet<string> {
    return new Set(this.snapshot.keys());
  }

  /**
   * 开始收增量（`sessions.watch`）。第一次 flush 会把当时的整份快照当增量发（`removed` 为空）——
   * 手机刚 list 过，这份全量它认得出哪些是新的。
   */
  subscribe(send: Watch["send"]): () => void {
    const watch: Watch = { send, last: null };
    this.watches.add(watch);
    return () => {
      this.watches.delete(watch);
    };
  }

  /** agent 事件 → 脏集合 / 运行结束集合。phase 事件到达时运行态表还是旧值（订阅点在泵的入口） */
  onAgentEvent(event: AgentEvent): void {
    if (!("sessionId" in event)) return;
    const sessionId = event.sessionId;
    if (sessionId === null || sessionId === undefined) return;
    if (event.type === "phase") {
      const before = this.deps.phaseOf(sessionId);
      if (event.phase === "idle") {
        // 刚从在跑变成空闲：还没人看之前显示「跑完没看」。before 是 undefined（从没跑过）不算
        if (before !== undefined && before !== "idle") this.settled.add(sessionId);
      } else {
        this.settled.delete(sessionId);
      }
      this.markDirty(sessionId);
      return;
    }
    if (event.type === "stats" || event.type === "fileTurn" || event.type === "title" || event.type === "compaction") {
      this.markDirty(sessionId);
      return;
    }
    // 终态的 user / assistant 一落下就标脏：清单的 updatedAt、最近一句与计划等确认都从这里变
    if (
      event.type === "progress" &&
      ((event.progress.type === "item_finished" && event.progress.item.role === "assistant") ||
        (event.progress.type === "item_started" && event.progress.item.role === "user"))
    ) {
      this.markDirty(sessionId);
    }
  }

  /** 会话被删：标脏后从快照拿掉，并给在看清单的手机推 removed */
  drop(sessionId: string): void {
    this.tailCache.delete(sessionId);
    this.settled.delete(sessionId);
    this.markDirty(sessionId);
  }

  /**
   * `unread.clear`（以及手机打开这条会话）：清掉「跑完没看」，状态可能从 done 变 idle。
   * **无条件标脏**：调用方此刻刚把 meta.unread 清成 null，而「跑完没看」在界面上是
   * settledRecently 与 meta.unread 的并集——重启后 settled 是空的、未读来自落盘的 meta，
   * 只看 settled 删没删到会漏推，别的手机上的清单会一直停在「跑完没看」。
   */
  clearSettled(sessionId: string): void {
    this.settled.delete(sessionId);
    this.markDirty(sessionId);
  }

  /** 有会话脏了，400 毫秒内一起重算。没有观看者时只更新快照，什么都不发 */
  private markDirty(sessionId: string): void {
    this.dirty.add(sessionId);
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.exclusive(() => this.flush());
    }, FLUSH_DELAY_MS);
  }

  /** 重算脏的会话，给每个观看者发它没见过的那部分 */
  private async flush(): Promise<void> {
    const dirty = [...this.dirty];
    this.dirty.clear();
    if (dirty.length === 0 && this.watches.size > 0) {
      // 没有新脏的，但可能有刚 watch 的（first push 全量）
      this.pushDiffs();
      return;
    }
    if (dirty.length === 0) return;

    const metas = await this.deps.listMetas();
    const byId = new Map(metas.map((meta) => [meta.id, meta]));
    const workspaceNames = new Map((await this.deps.listWorkspaces()).map((workspace) => [workspace.id, workspace.name]));
    const now = this.deps.now();
    this.childrenRunning = countRunningChildren(metas, (id) => this.deps.phaseOf(id) !== undefined && this.deps.phaseOf(id) !== "idle");

    for (const id of dirty) {
      const meta = byId.get(id);
      if (meta === undefined || !isListableSession(meta, now)) {
        // 不该在清单里（被删 / 归档 / 过了 30 天窗 / 子会话或自动化会话）：从准入集合请出去；
        // 之前在快照里的才要给在看清单的手机推 removed
        this.snapshot.delete(id);
        continue;
      }
      // 在快照里的更新；不在的（新活动把它顶回了最近）加进来——手机按 upsert 收
      this.snapshot.set(id, await this.summarize(meta, workspaceNames));
    }
    this.pushDiffs();
  }

  /** 给每个观看者发「它上次那一份」与「此刻这一份」的差 */
  private pushDiffs(): void {
    for (const watch of this.watches) {
      const base = watch.last ?? new Map<string, SessionSummary>();
      const changed: SessionSummary[] = [];
      const removed: string[] = [];
      for (const [id, summary] of this.snapshot) {
        const before = base.get(id);
        if (before === undefined || JSON.stringify(before) !== JSON.stringify(summary)) changed.push(summary);
      }
      for (const id of base.keys()) {
        if (!this.snapshot.has(id)) removed.push(id);
      }
      watch.last = new Map(this.snapshot);
      if (changed.length > 0 || removed.length > 0) {
        try {
          watch.send(changed, removed);
        } catch (cause) {
          console.error("[mobile] sessions.changed 没送出去", cause);
        }
      }
    }
  }

  private async buildList(): Promise<{ sessions: SessionSummary[]; truncated: boolean }> {
    const metas = await this.deps.listMetas();
    const now = this.deps.now();
    this.childrenRunning = countRunningChildren(metas, (id) => this.deps.phaseOf(id) !== undefined && this.deps.phaseOf(id) !== "idle");
    const eligible = metas
      .filter((meta) => isListableSession(meta, now))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const truncated = eligible.length > LIST_MAX;
    const listed = eligible.slice(0, LIST_MAX);
    const workspaceNames = new Map((await this.deps.listWorkspaces()).map((workspace) => [workspace.id, workspace.name]));

    // 尾部按指纹缓存；变了才重读，一次最多读 TAIL_READS_PER_LIST 条
    let reads = 0;
    const summaries: SessionSummary[] = [];
    for (const meta of listed) {
      const facts = await this.factsOf(meta.id, reads < TAIL_READS_PER_LIST);
      if (facts.read) reads += 1;
      summaries.push(this.summaryOf(meta, facts.facts, workspaceNames));
    }
    return { sessions: summaries, truncated };
  }

  private async summarize(meta: SessionMeta, workspaceNames: ReadonlyMap<string, string>): Promise<SessionSummary> {
    const facts = await this.factsOf(meta.id, true);
    return this.summaryOf(meta, facts.facts, workspaceNames);
  }

  /** 读尾部才知道的两件事：agent 最近一句、是不是停在计划待确认上。没变就沿用缓存 */
  private async factsOf(id: string, mayRead: boolean): Promise<{ facts: TailFacts; read: boolean }> {
    const stat = await this.deps.tailStat(id);
    const cached = this.tailCache.get(id);
    if (stat !== null && cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return { facts: cached, read: false };
    }
    if (stat === null) {
      this.tailCache.delete(id);
      return { facts: { size: 0, mtimeMs: 0, lastLine: null, planAwaiting: false }, read: false };
    }
    if (!mayRead) {
      // 这轮不让读：沿用旧缓存（哪怕已过期），没有就空着——清单先出，下轮刷新再补
      return { facts: cached ?? { size: 0, mtimeMs: 0, lastLine: null, planAwaiting: false }, read: false };
    }
    const records = foldRevertRecords(await this.deps.tailRecords(id));
    const facts: TailFacts = {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      lastLine: lastAssistantLineOf(records),
      planAwaiting: planAwaitingIn(records),
    };
    this.tailCache.set(id, facts);
    return { facts, read: true };
  }

  private summaryOf(
    meta: SessionMeta,
    facts: TailFacts,
    workspaceNames: ReadonlyMap<string, string>,
  ): SessionSummary {
    const children = this.childRunningCount(meta.id);
    const ownPhase = this.deps.phaseOf(meta.id);
    return {
      id: meta.id,
      title: meta.title,
      workspaceId: meta.workspaceId,
      workspaceName: meta.workspaceId === null ? null : (workspaceNames.get(meta.workspaceId) ?? null),
      state: deriveMobileSessionState({
        // 与桌面侧栏同口径：直接子会话在跑，母会话也显示在跑；个数另列出来
        phase: ownPhase !== undefined && ownPhase !== "idle" ? ownPhase : children > 0 ? "turn" : ownPhase,
        planAwaiting: facts.planAwaiting,
        unread: meta.unread ?? null,
        settledRecently: this.settled.has(meta.id),
      }),
      lastLine: facts.lastLine,
      updatedAt: meta.updatedAt,
      childrenRunning: children,
    };
  }

  /** `parentId` 指向它、且运行态表里不是 idle 的子会话个数（最近一次构建时算的账） */
  private childRunningCount(id: string): number {
    return this.childrenRunning.get(id) ?? 0;
  }

  /** 子会话在跑数的账：全量构建与增量 flush 都重算（每次 flush 都拉了全表，顺手） */
  private childrenRunning = new Map<string, number>();

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

/** 每条根会话有几个子会话此刻在跑 */
function countRunningChildren(metas: readonly SessionMeta[], isRunning: (id: string) => boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const meta of metas) {
    if (meta.parentId === undefined || !isRunning(meta.id)) continue;
    counts.set(meta.parentId, (counts.get(meta.parentId) ?? 0) + 1);
  }
  return counts;
}

/**
 * 这条 meta 进不进清单——同时就是四个「点会话」的方法的准入判据（安全审查第 7 条）：
 * 根会话、没归档、30 天内动过的。`sessions.list` 的全量构建与增量刷新都只调它，别处不再判一遍。
 */
function isListableSession(meta: SessionMeta, now: number): boolean {
  return isRootSession(meta) && !meta.archived && now - meta.updatedAt <= LIST_WINDOW_MS;
}
