/**
 * agent tab 的生命周期账本：谁在什么时候活跃过、哪些该回收。
 *
 * 为什么单独一个模块：回收决策（闲置判定、LRU 淘汰、全局上限）全是纯算术，把它从
 * sandbox.ts 里摘出来，时钟可注入，node --test 直接加载——Electron 只留在边缘
 * （定时器、销毁 WebContentsView）。账本不 import electron。
 *
 * 三条回收规则（回收后下次请求都走懒建路径重建，并给模型一句提示）：
 *   1. 闲置：距最后一次活跃超过 idleMs
 *   2. 上限：全局 agent tab 数超过 maxTabs 时，按 LRU 淘汰最久未活跃的
 *   3. 忙碌保护：一次工具调用还没结束（正在导航 / 交接）的 tab 绝不回收——
 *      宁可暂时超上限，也不拆一次跑着的工具调用
 */

/** 回收原因：闲置到点 / 超出全局上限被 LRU 淘汰 */
export type AgentTabReclaimReason = "idle" | "evicted";

export interface AgentTabReclaimVictim {
  sessionId: string;
  reason: AgentTabReclaimReason;
}

interface LedgerEntry {
  /** 最后一次 agent 浏览器请求（或建 tab）的时刻 */
  lastActiveAt: number;
  /** 一次工具调用还没结束（正在导航 / 交接） */
  busy: boolean;
}

export interface AgentTabLedgerOptions {
  /** 闲置多久算可回收（毫秒） */
  idleMs: number;
  /** 全局 agent tab 数上限 */
  maxTabs: number;
  /** 时钟，测试注入；默认 Date.now */
  now?: () => number;
}

export class AgentTabLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly idleMs: number;
  private readonly maxTabs: number;
  private readonly now: () => number;

  constructor(options: AgentTabLedgerOptions) {
    this.idleMs = options.idleMs;
    this.maxTabs = options.maxTabs;
    this.now = options.now ?? Date.now;
  }

  /** 新建了一张 agent tab：登记并记为刚活跃。已有记录就只刷新时间 */
  register(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry === undefined) this.entries.set(sessionId, { lastActiveAt: this.now(), busy: false });
    else entry.lastActiveAt = this.now();
  }

  /** 一次 agent 浏览器请求：刷新活跃时间。没有这张 tab 的会话是空操作（不凭空记账） */
  touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (entry !== undefined) entry.lastActiveAt = this.now();
  }

  /** tab 没了（销毁 / 会话关闭 / 崩溃清理）：从账本划掉 */
  forget(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** 一次工具调用开始 / 结束。忙碌的 tab 不回收 */
  setBusy(sessionId: string, busy: boolean): void {
    const entry = this.entries.get(sessionId);
    if (entry !== undefined) entry.busy = busy;
  }

  /** 现在有几张 agent tab */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /**
   * 该回收的会话，最久未活跃的在前：
   *   - 闲置到点的：`now - lastActiveAt >= idleMs`
   *   - 超出上限的部分：`size - 已选闲置 + reserve > maxTabs` 时，从剩下的里再按 LRU 淘汰
   *
   * reserve 给「马上要新建的那张 tab」留位置（sandbox 建新 tab 前传 1）。闲置的一定比
   * 没闲置的老，所以返回顺序整体就是 LRU。忙碌的一律跳过。
   */
  reclaimable(reserve = 0): AgentTabReclaimVictim[] {
    const now = this.now();
    const candidates = [...this.entries.entries()]
      .filter(([, entry]) => !entry.busy)
      .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
    const victims: AgentTabReclaimVictim[] = [];
    const chosen = new Set<string>();
    for (const [sessionId, entry] of candidates) {
      if (now - entry.lastActiveAt >= this.idleMs) {
        victims.push({ sessionId, reason: "idle" });
        chosen.add(sessionId);
      }
    }
    let excess = this.entries.size - victims.length + reserve - this.maxTabs;
    for (const [sessionId] of candidates) {
      if (excess <= 0) break;
      if (chosen.has(sessionId)) continue;
      victims.push({ sessionId, reason: "evicted" });
      chosen.add(sessionId);
      excess -= 1;
    }
    return victims;
  }
}

export interface AgentTabNoticeContext {
  /** 闲置回收阈值（分钟），写进给模型的话里 */
  idleMinutes: number;
  /** 全局上限，写进给模型的话里 */
  maxTabs: number;
}

/**
 * 回收 / 崩溃之后，下一次 agent 浏览器请求开头的那句话。模型据此知道旧页面没了，
 * 手上的 refs、截图坐标、滚动位置都作废，要先重新导航。
 */
export function agentTabNotice(reason: AgentTabReclaimReason | "crashed", context: AgentTabNoticeContext): string {
  const tail =
    "This is a new, empty tab: the old page, its scroll position and any element refs are gone — " +
    "call browser_navigate to open the page again.";
  if (reason === "crashed") return `Your browser tab crashed and was replaced. ${tail}`;
  if (reason === "idle") {
    return `Your browser tab was closed after ${context.idleMinutes} minutes with no browser activity. ${tail}`;
  }
  return `Your browser tab was closed to stay under the limit of ${context.maxTabs} agent browser tabs. ${tail}`;
}
