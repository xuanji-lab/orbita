/**
 * renderer 手里那份会话列表（`session.sessions`）什么时候该从盘上重拉——事件泵
 * 每来一个 agent 事件问一次。列表是缓存，真值在主进程的 SessionStore；侧栏、
 * 右图标条的 Sub-sessions 入口、标题旁的子会话芯片都只读这份缓存。
 *
 * **以前只有「刷 / 不刷」两态，刷 = 整表重拉**：`list()` 挨个读全部 `.meta.json`，
 * 1432 条会话（含 688 条子会话）实测 180ms，而任何一轮结束、出标题或换模型都会
 * 付一次。现在分三态：
 * - `{ kind: "meta", id }`：列表里已有这条，只取这一条的 meta 替换；
 * - `{ kind: "full" }`：列表里没有这条，宁多拉一次，不漏；
 * - `"none"`：什么都不用做。
 *
 * 判定：
 * - `phase idle`：一轮跑完，标题与 updatedAt 都变了。**哪条会话跑完都刷**，
 *   后台完成的会话侧栏也该亮起来。列表里有 → meta；没有 → full。
 * - `phase turn|compaction`：列表里有时**不刷**——轮中途 meta 没变，跑完再刷；
 *   列表里没有 → full（delegate 刚派出的子会话，见下）。
 * - `title` / `model`：主进程已落 meta（可能早于整轮结束，不等 idle）。
 *   列表里有 → meta；没有 → full。
 * - **列表里没有的会话发来 `phase`**：这条会话的 meta 不是 renderer 建的，
 *   renderer 也就没有「建完刷一次」的时机。今天的生产者是 delegate——主进程
 *   `applyDelegate` 先落子会话 meta 再开轮，只广播通道事件。漏掉这一条时，
 *   母会话这一轮没跑完之前子会话都不在列表里：通道列已经亮了（它每次现问
 *   主进程），Sub-sessions 入口却不出现，派出卡点开的面板也被立刻关掉
 *   （App 里「没有子会话就关面板」的守卫），2026-09-25 实测一整轮看不到子会话。
 *   meta 一定先于这个事件落盘：`applyDelegate` 里 `ensureSession` 在 `submitTurn`
 *   之前 await 完，`phase` 只在开轮之后才发。**为什么是 full 而不是 meta**：
 *   列表里没有这条说明我们还不知道它的归属与存在，而这一拍之前的其它会话变化
 *   也可能没落到这份缓存上；整表读一次最稳，且这种事件只在第一次见到会话时出现。
 * - 其余事件 → none：列表里没有的会话只认 phase（每轮至多几次），不认流式帧
 *   那类高频事件。
 *
 * 纯判定与纯合并，不 import React；队列的读盘与回填全部注入（`SessionListRefreshQueue`），
 * `node --test` 直接加载本文件。
 */
import type { AgentEvent } from "@shared/agent-ipc";
import type { SessionMeta } from "@shared/session";
import { sortSessions } from "../../../../shared/session.ts";

/** 事件要求列表做什么：不刷 / 只取这一条 / 整表重拉 */
export type SessionRefreshNeed =
  | "none"
  | { readonly kind: "meta"; readonly id: string }
  | { readonly kind: "full" };

export function sessionRefreshNeed(
  event: AgentEvent,
  listed: readonly SessionMeta[],
): SessionRefreshNeed {
  const isListed = (id: string): boolean => listed.some((meta) => meta.id === id);
  if (event.type === "title" || event.type === "model") {
    return isListed(event.sessionId) ? { kind: "meta", id: event.sessionId } : { kind: "full" };
  }
  if (event.type !== "phase") return "none";
  if (!isListed(event.sessionId)) return { kind: "full" };
  // 轮中途 meta 没变：整表重拉（以前的写法）也是白读，等 idle
  return event.phase === "idle" ? { kind: "meta", id: event.sessionId } : "none";
}

/**
 * 把一条 meta 合并进列表：有则替换、null 则移除（会话被删 / meta 坏了，与
 * `list()` 跳过坏记录同口径），**并按 `sortSessions` 重排**。
 *
 * 排法必须与整表重拉共用一个函数（置顶在前，其余 updatedAt 倒序）——否则增量
 * 刷新前后同一条会话会跳位置。因为 sortSessions 是稳定排序，且这里的集合与
 * 「整表重拉得到的那一份」一致时，逐条结果也一致（测试里 deepEqual 把关）。
 */
export function applySessionMeta(
  list: readonly SessionMeta[],
  id: string,
  meta: SessionMeta | null,
): SessionMeta[] {
  const rest = list.filter((entry) => entry.id !== id);
  return sortSessions(meta === null ? rest : [...rest, meta]);
}

export interface SessionListRefreshPorts {
  /** 整表重拉（生产环境是 `api.session.list`） */
  readonly loadAll: () => Promise<SessionMeta[]>;
  /** 单条 meta（生产环境是 `api.session.meta`）；null = 已被删 / meta 坏了 */
  readonly loadMeta: (id: string) => Promise<SessionMeta | null>;
  /** 整表读回来：调用方替换列表、置 READY、通知各查看槽 syncOpened */
  readonly onAll: (list: SessionMeta[]) => void;
  /** 单条读回来：调用方用 `applySessionMeta` 替换并重排 */
  readonly onMeta: (id: string, meta: SessionMeta | null) => void;
  /** 读失败：列表保留原样（读失败不清空），错误交给调用方展示 */
  readonly onError: (cause: unknown) => void;
  /** 突发合并窗口，默认 150ms */
  readonly delayMs?: number;
}

/** 默认合并窗口：150ms 内冒出的多条新子会话（delegate 连派）只读一次整表 */
const DEFAULT_DELAY_MS = 150;

/**
 * 列表增量刷新的调度器。三条规矩：
 * 1. **突发合并**：窗口（默认 150ms）内攒下的请求，窗口到点合并成一批；整表请求
 *    会吞掉同批的 meta 请求（全量读一定覆盖它们）。
 * 2. **同一时刻只有一批在途**；在途期间来的请求等这批结束后**立刻**补拉一次，
 *    不再等窗口（否则事件会一直往后排）。
 * 3. **meta 按 id 去重**：同一条已在排队或在途时不重复拉。
 *
 * 不依赖 React，读盘与回填全部注入——`node --test` 直接用假端口驱动。
 */
export class SessionListRefreshQueue {
  private readonly ports: SessionListRefreshPorts;
  private readonly delayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 还没开始跑的请求（窗口里攒着，或在途期间攒着） */
  private pendingFull = false;
  private readonly pendingMetaIds = new Set<string>();
  /** 正在跑的那一批（full 或一组 meta，二者不会同时） */
  private inFlightFull = false;
  private readonly inFlightMetaIds = new Set<string>();
  private disposed = false;

  constructor(ports: SessionListRefreshPorts) {
    this.ports = ports;
    this.delayMs = ports.delayMs ?? DEFAULT_DELAY_MS;
  }

  /** 整表重拉的请求（列表里出现了不认识的会话） */
  requestFull(): void {
    if (this.disposed || this.pendingFull) return;
    this.pendingFull = true;
    this.schedule();
  }

  /**
   * 单条 meta 的请求（列表里已有的会话状态变了）。同一 id 在途 / 已排队时不重复拉；
   * 整表重拉已在排队时直接让给它（全量读一定覆盖这一条）。
   */
  requestMeta(id: string): void {
    if (this.disposed) return;
    if (this.pendingMetaIds.has(id) || this.inFlightMetaIds.has(id)) return;
    if (this.pendingFull) return;
    this.pendingMetaIds.add(id);
    this.schedule();
  }

  /** 卸载时调用：清掉定时器；在途请求的回调不再落地 */
  /**
   * 卸载时调用：清掉定时器与还没发出的请求；在途请求的回调不再落地。
   *
   * **之后可以 `revive()` 复用同一实例**：React StrictMode 在开发环境会
   * setup → cleanup → setup，同一个队列会被 dispose 一次再继续用；没有 revive
   * 的话开发模式下增量刷新会永久失效（生产不双挂载，验不出来）。
   */
  dispose(): void {
    this.disposed = true;
    this.pendingFull = false;
    this.pendingMetaIds.clear();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 重新启用（StrictMode 第二次 setup / 热更新后的同一个实例） */
  revive(): void {
    this.disposed = false;
  }

  private hasPending(): boolean {
    return this.pendingFull || this.pendingMetaIds.size > 0;
  }

  private schedule(): void {
    // 有在途的一批时先不排：那批结束时 `next()` 会立刻接手（不等窗口）
    if (this.disposed || this.timer !== null || this.inFlightFull || this.inFlightMetaIds.size > 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.run();
    }, this.delayMs);
  }

  private run(): void {
    if (this.disposed) return;
    // 已经有在途的一批：等它结束（finally 里会再调 run）
    if (this.inFlightFull || this.inFlightMetaIds.size > 0) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pendingFull) {
      this.pendingFull = false;
      this.pendingMetaIds.clear();
      this.inFlightFull = true;
      void this.ports
        .loadAll()
        .then(
          (list) => {
            if (!this.disposed) this.ports.onAll(list);
          },
          (cause: unknown) => {
            if (!this.disposed) this.ports.onError(cause);
          },
        )
        .finally(() => {
          this.inFlightFull = false;
          this.next();
        });
      return;
    }
    if (this.pendingMetaIds.size === 0) return;
    const ids = [...this.pendingMetaIds];
    this.pendingMetaIds.clear();
    for (const id of ids) this.inFlightMetaIds.add(id);
    void Promise.all(
      ids.map((id) =>
        this.ports
          .loadMeta(id)
          .then(
            (meta) => {
              if (!this.disposed) this.ports.onMeta(id, meta);
            },
            (cause: unknown) => {
              if (!this.disposed) this.ports.onError(cause);
            },
          )
          .finally(() => this.inFlightMetaIds.delete(id)),
      ),
    ).finally(() => this.next());
  }

  /** 一批跑完：在途期间攒下的请求立刻再跑一批；没有就歇着（下一个请求自己排窗口） */
  private next(): void {
    if (this.disposed) return;
    if (this.hasPending()) this.run();
  }
}
