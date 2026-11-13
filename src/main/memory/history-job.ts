/**
 * 「从历史生成」的任务编排（主进程侧，纯模块：不 import electron，转录 / 段账本 / 服务 /
 * 落盘全部注入，可被 `node --test` 直接测）。
 *
 * 为什么要它：记忆只从开关打开之后的新对话里提取；开关打开之前的聊天记录要能补进来
 * （2026-10-30 用户：「得做！必须做」）。它**不另写一套提取**——只把历史轮按实时路径的
 * 口径切出来（history-turns.ts），每条会话内按**历史时间正序**逐条交给记忆服务的
 * historyTurn：切段、收尾、三类提取都是服务里实时路径那一套。会话之间并行（老会话先
 * 开始）——新旧不靠提取先后判：冲突按条目的原始问答时间定向（entries.ts appendScope），
 * 晚提取的旧说法照样落成过时、不会顶掉后来的新说法。
 *
 * 去重与续跑：「这一轮处理过没有」只问段文件（EpisodeStore.processedTurns：归档 / 待提取 /
 * 实时开段 / 历史开段），不另记账——实时整理过的、上次生成到一半的、停止时收尾的都在那里，
 * 段文件就是单一真相。所以每次开始 / 继续都重算计划，停在哪里不需要游标。
 * 本文件落盘的只是任务快照（选了哪些范围、计数、状态），用来在界面上显示进度、
 * 应用重启后恢复成「已暂停」。
 *
 * 节流：同时最多 concurrency 条会话在跑，每条会话一次只在服务里放一步（等回执再喂
 * 下一条）。历史步不进服务的实时队列，实时轮与召回都不等它。家务活调用的失败退避在服务里
 * （historyCall）；这里只看「连续几步都有提取失败」——模型 / 密钥坏了就暂停任务，
 * 不把几百次调用都撞一遍。
 */
import type {
  MemoryEpisodeTurn,
  MemoryHistoryEstimate,
  MemoryHistoryScope,
  MemoryHistoryStatus,
  MemoryHistoryStepOutcome,
} from "../../shared/memory.ts";
import { memoryScopeOf } from "../../shared/memory.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { estimateCalls, historyTurnsOf } from "./history-turns.ts";
import { tokenOfScope } from "../../memory/entries.ts";
import { scopeLabels } from "./scope-names.ts";

/** 连续多少步都有提取失败（重试用尽）就暂停任务。 */
const FAILURE_STREAK_LIMIT = 3;
/**
 * 同时在跑的会话数（每条会话同一时刻只有一步在服务里，所以也是家务活调用的并发上限）。
 * 2026-10-30 实测 glm-5.3-flash 一次提取 60–90 秒，串行跑意图系统 373 轮要十小时以上；
 * 用户拍板先用 4（并发 2 稳但慢、6–8 可能撞 coding plan 限额）。
 */
export const HISTORY_CONCURRENCY = 4;
/** 读转录的并发（几百条会话的预估不能一条条串着读，也不能一口气全开）。 */
const LOAD_CONCURRENCY = 4;

export interface HistorySessionMeta {
  id: string;
  parentId?: string;
  workspaceId: string | null;
  cwd: string;
}

export type HistoryStepInput =
  | { kind: "turn"; sessionId: string; scopeId: string; turn: MemoryEpisodeTurn; closeAfter: boolean }
  | { kind: "flush" };

export interface MemoryHistoryDeps {
  listSessions: () => Promise<readonly HistorySessionMeta[]>;
  workspaces: () => Promise<readonly { id: string; name: string }[]>;
  /** 生效视图的全量转录（回退已折叠）；null = 会话没了 */
  load: (sessionId: string) => Promise<{ transcript: readonly SessionRecord[] } | null>;
  /** 已进过事件段的轮（EpisodeStore.processedTurns） */
  processedTurns: () => Promise<Map<string, Set<number>>>;
  /** 当前家务活模型（只给界面显示）；null = 没配 */
  chore: () => Promise<{ providerId: string; modelId: string } | null>;
  /** 开工前：开关开着、服务拉起来、家务活模型装配好；不行回一句人话 */
  prepare: () => Promise<string | null>;
  /** 交给服务一步（host.historyStep）；null = 服务不在 / 中途退出 */
  step: (input: HistoryStepInput) => Promise<MemoryHistoryStepOutcome | null>;
  readState: () => Promise<MemoryHistoryStatus | null>;
  writeState: (status: MemoryHistoryStatus) => Promise<void>;
  emit: (status: MemoryHistoryStatus) => void;
  /** 段的闲置收尾阈值（预估切段用，与服务的 historyGapMs 同值） */
  gapMs: number;
  /** 同时在跑的会话数（默认 HISTORY_CONCURRENCY） */
  concurrency?: number;
  now?: () => number;
  log?: (message: string, ...args: unknown[]) => void;
}

/** 计划里的一条：哪条会话的哪一轮，是不是该会话在计划里的最后一轮。 */
interface PlannedTurn {
  sessionId: string;
  scopeId: string;
  turn: MemoryEpisodeTurn;
  closeAfter: boolean;
}

export function idleHistoryStatus(): MemoryHistoryStatus {
  return {
    state: "idle",
    scopeIds: [],
    totalTurns: 0,
    doneTurns: 0,
    episodes: 0,
    written: { fact: 0, preference: 0, insight: 0 },
    calls: 0,
    failed: 0,
    startedAt: null,
    updatedAt: null,
  };
}

/** 盘上的任务快照 → 状态（字段不齐 / 坏文件当没有任务；续跑靠段文件，丢了快照只丢计数）。 */
export function parseHistoryStatus(raw: unknown): MemoryHistoryStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const states = ["idle", "running", "paused", "stopping", "stopped", "done", "failed"];
  const num = (key: string): number => (typeof value[key] === "number" ? (value[key] as number) : 0);
  if (typeof value["state"] !== "string" || !states.includes(value["state"])) return null;
  if (!Array.isArray(value["scopeIds"]) || !value["scopeIds"].every((id) => typeof id === "string")) return null;
  const written = (typeof value["written"] === "object" && value["written"] !== null ? value["written"] : {}) as Record<
    string,
    unknown
  >;
  const count = (key: string): number => (typeof written[key] === "number" ? (written[key] as number) : 0);
  return {
    state: value["state"] as MemoryHistoryStatus["state"],
    scopeIds: value["scopeIds"] as string[],
    totalTurns: num("totalTurns"),
    doneTurns: num("doneTurns"),
    episodes: num("episodes"),
    written: { fact: count("fact"), preference: count("preference"), insight: count("insight") },
    calls: num("calls"),
    failed: num("failed"),
    ...(typeof value["error"] === "string" ? { error: value["error"] } : null),
    startedAt: typeof value["startedAt"] === "number" ? value["startedAt"] : null,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : null,
  };
}

/** 应用重启后读回的快照：跑着的 / 停到一半的一律当暂停（不自己开跑烧调用，等用户点继续）。 */
export function restoredHistoryStatus(saved: MemoryHistoryStatus | null): MemoryHistoryStatus {
  if (saved === null) return idleHistoryStatus();
  if (saved.state === "running" || saved.state === "stopping") return { ...saved, state: "paused" };
  return saved;
}

/** 有限并发的 map（顺序保持）。 */
async function mapLimited<T, R>(items: readonly T[], limit: number, job: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await job(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class MemoryHistoryJob {
  private readonly deps: MemoryHistoryDeps;
  private readonly now: () => number;
  private readonly log: (message: string, ...args: unknown[]) => void;
  private status: MemoryHistoryStatus = idleHistoryStatus();
  private loaded: Promise<void> | null = null;
  /** 正在跑的循环（暂停后再继续要等上一个循环把手上那一步做完） */
  private loop: Promise<void> | null = null;
  private readonly concurrency: number;

  constructor(deps: MemoryHistoryDeps) {
    this.deps = deps;
    this.concurrency = Math.max(1, deps.concurrency ?? HISTORY_CONCURRENCY);
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((message, ...args) => console.log(message, ...args));
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.deps
      .readState()
      .then((saved) => {
        this.status = restoredHistoryStatus(saved);
      })
      .catch((cause: unknown) => {
        this.log("[memory] 从历史生成：任务快照读不了，按没有任务处理", cause);
      });
    return this.loaded;
  }

  async current(): Promise<MemoryHistoryStatus> {
    await this.ensureLoaded();
    return this.snapshot();
  }

  /**
   * 预估：全部作用域按 meta 列出（只数根会话，不读转录）；scopeIds 里点名的作用域
   * 才读转录算轮数与调用数——全量读一遍转录（用户本机 3.5 GB）太贵。
   */
  async estimate(scopeIds: readonly string[]): Promise<MemoryHistoryEstimate> {
    await this.ensureLoaded();
    const [sessions, workspaces, chore] = await Promise.all([
      this.deps.listSessions(),
      this.deps.workspaces(),
      this.deps.chore(),
    ]);
    const roots = sessions.filter((meta) => meta.parentId === undefined);
    const labels = scopeLabels(roots, workspaces);
    const rows = new Map<string, MemoryHistoryScope>();
    for (const meta of roots) {
      const scopeId = memoryScopeOf(meta);
      const label = labels.get(scopeId) ?? { kind: "cwd" as const, name: meta.cwd, path: meta.cwd };
      const row = rows.get(scopeId) ?? {
        scopeId,
        token: tokenOfScope(scopeId),
        kind: label.kind,
        name: label.name,
        ...(label.path !== undefined ? { path: label.path } : null),
        sessions: 0,
        stats: null,
      };
      row.sessions += 1;
      rows.set(scopeId, row);
    }
    const wanted = new Set(scopeIds.filter((id) => rows.has(id)));
    if (wanted.size > 0) {
      const plan = await this.collect(sessions, wanted);
      for (const scopeId of wanted) {
        rows.get(scopeId)!.stats = plan.stats.get(scopeId) ?? { turns: 0, processed: 0, calls: 0 };
      }
    }
    const list = [...rows.values()];
    const workspaceRows = list.filter((row) => row.kind === "workspace").sort((a, b) => a.name.localeCompare(b.name));
    const cwdRows = list.filter((row) => row.kind === "cwd").sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name));
    const missingRows = list.filter((row) => row.kind === "missing").sort((a, b) => a.name.localeCompare(b.name));
    return { scopes: [...workspaceRows, ...cwdRows, ...missingRows], chore, status: this.snapshot() };
  }

  /** 开始一个新任务（已有任务在跑 / 暂停中时不另起，回当前快照）。 */
  async start(scopeIds: readonly string[]): Promise<MemoryHistoryStatus> {
    await this.ensureLoaded();
    if (this.isActive()) return this.snapshot();
    const unique = [...new Set(scopeIds)];
    if (unique.length === 0) return this.snapshot();
    const problem = await this.deps.prepare();
    const at = this.now();
    this.status = { ...idleHistoryStatus(), state: "running", scopeIds: unique, startedAt: at, updatedAt: at };
    if (problem !== null) {
      await this.fail(problem);
      return this.snapshot();
    }
    await this.publish();
    this.launch();
    return this.snapshot();
  }

  async control(action: "pause" | "resume" | "stop"): Promise<MemoryHistoryStatus> {
    await this.ensureLoaded();
    const state = this.status.state;
    if (action === "pause" && state === "running") {
      this.status.state = "paused";
      await this.publish();
    } else if (action === "resume" && (state === "paused" || state === "failed")) {
      const problem = await this.deps.prepare();
      if (problem !== null) {
        await this.fail(problem);
        return this.snapshot();
      }
      this.status.state = "running";
      delete this.status.error;
      await this.publish();
      this.launch();
    } else if (action === "stop" && (state === "running" || state === "paused" || state === "failed")) {
      this.status.state = "stopping";
      await this.publish();
      // 跑着的循环看到 stopping 会自己收尾；暂停 / 失败的没有循环，这里起一个只做收尾的
      this.launch();
    }
    return this.snapshot();
  }

  /** 测试与退出用：等手上的循环跑完。 */
  async settled(): Promise<void> {
    while (this.loop !== null) await this.loop;
  }

  private isActive(): boolean {
    const state = this.status.state;
    return state === "running" || state === "paused" || state === "stopping" || state === "failed";
  }

  private launch(): void {
    const previous = this.loop ?? Promise.resolve();
    const run: Promise<void> = previous
      .then(() => this.run())
      .catch((cause: unknown) => this.fail(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => {
        if (this.loop === run) this.loop = null;
      });
    this.loop = run;
  }

  private async run(): Promise<void> {
    if (this.status.state === "running") {
      const sessions = await this.deps.listSessions();
      const plan = await this.collect(sessions, new Set(this.status.scopeIds));
      if (this.status.state === "running") {
        this.status.totalTurns = this.status.doneTurns + plan.turns.length;
        await this.publish();
      }
      // 按会话分组；会话按第一轮的时间排（老会话先开始），组内保持时间正序
      const groups = new Map<string, PlannedTurn[]>();
      for (const item of plan.turns) {
        const group = groups.get(item.sessionId) ?? [];
        group.push(item);
        groups.set(item.sessionId, group);
      }
      const queue = [...groups.values()];
      let streak = 0;
      let halted: string | null = null;
      const worker = async (): Promise<void> => {
        for (;;) {
          const group = queue.shift();
          if (group === undefined) return;
          for (const item of group) {
            if (this.status.state !== "running" || halted !== null) return;
            const outcome = await this.deps.step({ kind: "turn", ...item });
            if (outcome === null) {
              halted ??= "记忆服务中途停了（开关被关或进程退出），已暂停；点继续从断点接着生成";
              return;
            }
            if (outcome.error !== undefined) {
              halted ??= outcome.error;
              return;
            }
            this.absorb(outcome);
            this.status.doneTurns += 1;
            if (outcome.failed > 0) streak += 1;
            else if (outcome.closed > 0) streak = 0;
            if (streak >= FAILURE_STREAK_LIMIT) {
              halted ??= "家务活模型连续几段提取都失败了（限额或密钥问题？），已暂停；失败的段留着，下次启动会重试";
              return;
            }
            if (this.status.state === "running") await this.publish();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, queue.length)) }, worker));
      if (halted !== null) {
        await this.fail(halted);
        return;
      }
      // 跑完了：剩下的历史开段收尾，任务完成
      if (this.status.state === "running") {
        await this.flush("done");
        return;
      }
    }
    if (this.status.state === "stopping") await this.flush("stopped");
    else await this.publish(); // 暂停：把最后一步的计数落盘
  }

  /** 全部历史开段收尾提取（停止 / 跑完）。 */
  private async flush(final: "done" | "stopped"): Promise<void> {
    const outcome = await this.deps.step({ kind: "flush" });
    if (outcome === null) {
      await this.fail("记忆服务中途停了，停止前的收尾没做完；下次开始会接着处理");
      return;
    }
    this.absorb(outcome);
    this.status.state = final;
    if (outcome.error !== undefined) this.status.error = outcome.error;
    await this.publish();
  }

  private absorb(outcome: MemoryHistoryStepOutcome): void {
    this.status.episodes += outcome.closed;
    this.status.calls += outcome.calls;
    this.status.failed += outcome.failed;
    this.status.written.fact += outcome.written.fact;
    this.status.written.preference += outcome.written.preference;
    this.status.written.insight += outcome.written.insight;
  }

  private async fail(error: string): Promise<void> {
    this.log(`[memory] 从历史生成停下：${error}`);
    this.status.state = "failed";
    this.status.error = error;
    await this.publish();
  }

  private snapshot(): MemoryHistoryStatus {
    return { ...this.status, scopeIds: [...this.status.scopeIds], written: { ...this.status.written } };
  }

  private async publish(): Promise<void> {
    this.status.updatedAt = this.now();
    const snapshot = this.snapshot();
    this.deps.emit(snapshot);
    try {
      await this.deps.writeState(snapshot);
    } catch (cause) {
      // 快照只用来显示进度与重启后恢复；写不了不拦任务（续跑靠段文件，不靠它）
      this.log("[memory] 从历史生成：任务快照落盘失败", cause);
    }
  }

  /**
   * 收集计划：选中作用域里根会话的历史轮，去掉已进过事件段的，按历史时间正序排
   * （同一时刻按会话、轮号定序；run 按会话分组时会话的先后就是第一轮的先后）。
   * 每条会话在计划里的最后一轮标 closeAfter。
   */
  private async collect(
    sessions: readonly HistorySessionMeta[],
    scopeIds: ReadonlySet<string>,
  ): Promise<{ turns: PlannedTurn[]; stats: Map<string, { turns: number; processed: number; calls: number }> }> {
    const chosen = sessions.filter((meta) => meta.parentId === undefined && scopeIds.has(memoryScopeOf(meta)));
    const processed = await this.deps.processedTurns();
    const perSession = await mapLimited(chosen, LOAD_CONCURRENCY, async (meta) => {
      const detail = await this.deps.load(meta.id).catch((cause: unknown) => {
        this.log(`[memory] 从历史生成：会话 ${meta.id} 的转录读不了，跳过`, cause);
        return null;
      });
      if (detail === null) return null;
      const done = processed.get(meta.id);
      const all = historyTurnsOf(meta, detail.transcript);
      const fresh = all.filter((turn) => done?.has(turn.turn) !== true);
      return { meta, scopeId: memoryScopeOf(meta), fresh, skipped: all.length - fresh.length };
    });
    const turns: PlannedTurn[] = [];
    const stats = new Map<string, { turns: number; processed: number; calls: number }>();
    for (const session of perSession) {
      if (session === null) continue;
      const row = stats.get(session.scopeId) ?? { turns: 0, processed: 0, calls: 0 };
      row.turns += session.fresh.length;
      row.processed += session.skipped;
      row.calls += estimateCalls(session.fresh, this.deps.gapMs);
      stats.set(session.scopeId, row);
      for (const turn of session.fresh) {
        turns.push({ sessionId: session.meta.id, scopeId: session.scopeId, turn, closeAfter: false });
      }
    }
    turns.sort(
      (a, b) => a.turn.at - b.turn.at || a.sessionId.localeCompare(b.sessionId) || a.turn.turn - b.turn.turn,
    );
    const seen = new Set<string>();
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const item = turns[index]!;
      if (seen.has(item.sessionId)) continue;
      seen.add(item.sessionId);
      item.closeAfter = true;
    }
    return { turns, stats };
  }
}
