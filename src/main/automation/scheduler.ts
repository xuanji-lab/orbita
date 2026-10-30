/**
 * 自动化调度器（实验功能 automation）：「nextRunAt 时间戳 + 30 秒短 tick」。
 *
 * **为什么不是一个 setTimeout 等到点**：Mac 睡眠时定时器不走，醒来后一个长 setTimeout 要么早要么晚且不可知；
 * 每 30 秒看一眼「有没有 nextRunAt ≤ 现在」，睡醒后（`powerMonitor` 的 resume 立刻再 tick 一次）
 * 最多晚一个 tick。代价是每 30 秒读一次内存里的列表，近乎零成本。
 *
 * **错过只补一次**：应用没开 / 电脑睡眠错过了排期，醒来发现 nextRunAt 早已过期（晚于 LATE_MS）→ 只跑**一次**
 * （记 `caughtUp`），然后从现在重新排，不把错过的格子逐个补回来。
 *
 * **两种去处**：
 * - new_session：开一条新会话跑；上一次还没跑完 → 本次记 skipped（不排队）；
 * - this_session：把指令送回创建它的会话。会话空闲就送；**在忙就等**——记一条持久的
 *   `pendingDelivery`，等它空闲（phase 回到 idle）再送一次，等待期间又到点只合并成一次（merged + 1），
 *   不叠加。会话被删 → 任务 completed（sessionDeleted）。
 *
 * 分层：**纯函数 `planFire` / `planPending` / `applyRunResult` 决定状态怎么变**（可穷尽测试），
 * `AutomationScheduler` 只做时钟、串行化与 IO（开会话 / 送会话、读写 store、收 agent 事件）。
 * 时钟、开会话、送会话、中止、会话忙闲都是注入的——测试用假时钟与假 launch，不起真模型、不 import electron。
 *
 * 所有会改状态的动作（tick / 立即运行 / 一次运行的收尾）都排进同一条串行队列：同一条自动化的「上次还在跑」
 * 判定与 store 的读-改-写不会交错。收 agent 事件（onAgentEvent）本身是同步的、只写内存里的运行快照，
 * 收尾才排队——所以事件流不会被队列里一次几秒的开会话堵住。
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  AUTOMATION_EXCERPT_MAX,
  AUTOMATION_LAST_RESULT_MAX,
  AUTOMATION_MAX_CONSECUTIVE_FAILURES,
  AUTOMATION_MAX_RUNS_PER_DAY,
  AUTOMATION_RUNS_KEPT,
  nextRunAfter,
  runsInLastDay,
  type Automation,
  type AutomationEndReason,
  type AutomationRun,
  type AutomationRunTrigger,
  type AutomationSkipReason,
} from "../../shared/automation.ts";
import { clipText } from "./launch.ts";
import type { AutomationStore } from "./store.ts";

/** tick 间隔 */
export const TICK_MS = 30_000;
/** 到点后晚于它才算「错过」（超过两个 tick 才说得上睡眠 / 没开应用，而不是 tick 的正常抖动） */
export const LATE_MS = 90_000;
/** 同时在跑的运行数上限：醒来后一堆自动化同时到点，不该同时拉起一堆 agent */
export const MAX_CONCURRENT_RUNS = 3;
/** 一次运行最长这么久，超了中止并记失败——无人值守的运行卡在等人的地方，不该永远占着「上次还在跑」 */
export const RUN_TIMEOUT_MS = 60 * 60 * 1000;

/* ---------- 纯决策 ---------- */

export type FirePlan =
  | { kind: "none" }
  /** 该跑 / 该送：next 是写回 store 的新状态（已记一条 running 的运行、runCount + 1） */
  | { kind: "go"; next: Automation; number: number }
  /** new_session：没跑（上次还在跑 / 24 小时上限），已记 skipped 并重新排期 */
  | { kind: "skipped"; next: Automation }
  /** this_session：会话在忙，这次进入等待（或并进已有的等待），已重新排期 */
  | { kind: "waiting"; next: Automation }
  /** 到终点了（until 过了 / maxRuns 用完），直接结束，没有运行 */
  | { kind: "ended"; next: Automation }
  /** 手动触发被拒（给用户的一句话） */
  | { kind: "refused"; error: string };

function atDailyCap(automation: Automation, now: number): boolean {
  return runsInLastDay(automation, now) >= AUTOMATION_MAX_RUNS_PER_DAY;
}

function trimRuns(runs: AutomationRun[]): AutomationRun[] {
  return runs.slice(0, AUTOMATION_RUNS_KEPT);
}

/**
 * 从 `now` 起重新排期。once 与「下一次越过 until」都排不出下一次：nextRunAt 置 null，
 * 这次运行（如果有）收尾时再翻成 completed（见 applyRunResult）——不在运行中途就把任务翻成已完成。
 */
function rescheduled(automation: Automation, now: number): Automation {
  if (automation.schedule.kind === "once") return { ...automation, nextRunAt: null };
  const next = nextRunAfter(automation.schedule, now);
  if (next === null || (automation.until !== undefined && next > automation.until)) {
    return { ...automation, nextRunAt: null };
  }
  return { ...automation, nextRunAt: next };
}

/** 记一条 skipped：同一原因连续跳过合并成一条（repeat 计数），不让「上次还在跑」刷满历史 */
function withSkipped(automation: Automation, now: number, reason: AutomationSkipReason, runId: string): Automation {
  const newest = automation.runs[0];
  if (newest !== undefined && newest.status === "skipped" && newest.skipReason === reason) {
    const merged: AutomationRun = { ...newest, runAt: now, repeat: (newest.repeat ?? 1) + 1 };
    return { ...automation, runs: [merged, ...automation.runs.slice(1)] };
  }
  const skipped: AutomationRun = {
    id: runId,
    runAt: now,
    trigger: "schedule",
    status: "skipped",
    sessionId: null,
    durationMs: null,
    tokens: null,
    skipReason: reason,
  };
  return { ...automation, runs: trimRuns([skipped, ...automation.runs]) };
}

/** 到终点了吗：跑满次数 = finished；until 已过 = expired。没到返回 null */
export function endReasonOf(automation: Automation, now: number): AutomationEndReason | null {
  if (automation.maxRuns !== undefined && automation.runCount >= automation.maxRuns) return "finished";
  if (automation.until !== undefined && now > automation.until) return "expired";
  return null;
}

function completed(automation: Automation, reason: AutomationEndReason, now: number): Automation {
  const next: Automation = { ...automation, status: "completed", endReason: reason, nextRunAt: null, updatedAt: now };
  delete next.pendingDelivery;
  return next;
}

function runRecord(
  automation: Automation,
  input: { now: number; trigger: AutomationRunTrigger; runId: string; sessionId: string; merged?: number },
): AutomationRun {
  return {
    id: input.runId,
    runAt: input.now,
    trigger: input.trigger,
    status: "running",
    sessionId: input.sessionId,
    durationMs: null,
    tokens: null,
    ...(input.merged !== undefined && input.merged > 0 ? { merged: input.merged } : {}),
  };
}

/**
 * 一次触发该怎么办。`trigger`：schedule / caughtUp 来自到点（调用方已按迟到程度分好）；manual 来自「立即运行」。
 * **到点触发**走护栏的「记 skipped / 进入等待、照常重新排期」；**手动触发**撞护栏时拒绝并说原因——用户点的按钮要有回应。
 * 手动运行不动排期（nextRunAt 原样）。
 *
 * `busy`：new_session 是「这条任务上一次还在跑」；this_session 是「目标会话此刻不空闲」。
 */
export function planFire(
  automation: Automation,
  input: { now: number; trigger: AutomationRunTrigger; busy: boolean; runId: string; sessionId: string },
): FirePlan {
  const { now, trigger, busy } = input;
  const thisSession = automation.target.kind === "this_session";
  if (trigger === "manual") {
    if (automation.status !== "active" && automation.status !== "paused") {
      return { kind: "refused", error: "Restart this automation before running it." };
    }
    if (busy) {
      return { kind: "refused", error: thisSession ? "The session is busy right now; try again when it is idle." : "The previous run is still going." };
    }
    if (endReasonOf(automation, now) !== null) return { kind: "refused", error: "This automation has reached its end." };
    if (atDailyCap(automation, now)) {
      return { kind: "refused", error: `At most ${AUTOMATION_MAX_RUNS_PER_DAY} runs per 24 hours; try again later.` };
    }
  } else {
    if (automation.status !== "active" || automation.nextRunAt === null || automation.nextRunAt > now) return { kind: "none" };
    const reason = endReasonOf(automation, now);
    if (reason !== null) return { kind: "ended", next: completed(automation, reason, now) };
    if (thisSession && busy) {
      // 会话在忙：不叠加，只记「等着送」；等待期间再到点合并成一次
      const waiting = rescheduled(automation, now);
      const pending = automation.pendingDelivery;
      return {
        kind: "waiting",
        next: {
          ...waiting,
          pendingDelivery:
            pending === undefined
              ? { since: now, trigger, merged: 0 }
              : { ...pending, merged: pending.merged + 1 },
          updatedAt: now,
        },
      };
    }
    if (busy) {
      const next = withSkipped(rescheduled(automation, now), now, "overlap", input.runId);
      return { kind: "skipped", next: { ...next, updatedAt: now } };
    }
    if (atDailyCap(automation, now)) {
      const next = withSkipped(rescheduled(automation, now), now, "dailyCap", input.runId);
      return { kind: "skipped", next: { ...next, updatedAt: now } };
    }
  }
  const base = trigger === "manual" ? automation : rescheduled(automation, now);
  // 到点时恰好有一次等着送的（会话刚空下来、drain 还没赶上）：并进这一次，不留一条悬空的等待
  const pending = automation.pendingDelivery;
  const merged = pending === undefined ? 0 : pending.merged + 1;
  const next: Automation = {
    ...base,
    runs: trimRuns([
      runRecord(automation, { now, trigger, runId: input.runId, sessionId: input.sessionId, merged }),
      ...automation.runs,
    ]),
    runCount: automation.runCount + 1,
    updatedAt: now,
  };
  delete next.pendingDelivery;
  return { kind: "go", next, number: next.runCount };
}

/**
 * this_session 等待中的送达：会话空闲了就送一次。不再重新排期（进入等待时已经排过了）；
 * 到点触发的方式沿用最先到点的那次（schedule / caughtUp），合并的次数记进这次运行。
 */
export function planPending(
  automation: Automation,
  input: { now: number; busy: boolean; runId: string; sessionId: string },
): FirePlan {
  const pending = automation.pendingDelivery;
  if (pending === undefined || automation.status !== "active") return { kind: "none" };
  if (input.busy) return { kind: "none" };
  const reason = endReasonOf(automation, input.now);
  if (reason !== null) return { kind: "ended", next: completed(automation, reason, input.now) };
  if (atDailyCap(automation, input.now)) {
    const next = withSkipped(automation, input.now, "dailyCap", input.runId);
    delete next.pendingDelivery;
    return { kind: "skipped", next: { ...next, updatedAt: input.now } };
  }
  const next: Automation = {
    ...automation,
    runs: trimRuns([
      runRecord(automation, { now: input.now, trigger: pending.trigger, runId: input.runId, sessionId: input.sessionId, merged: pending.merged }),
      ...automation.runs,
    ]),
    runCount: automation.runCount + 1,
    updatedAt: input.now,
  };
  delete next.pendingDelivery;
  return { kind: "go", next, number: next.runCount };
}

/** 一次运行收尾的结果（scheduler 从 agent 事件里攒出来的） */
export interface RunResult {
  status: "success" | "error";
  durationMs: number;
  tokens: number | null;
  error?: string;
  /** 最终回答全文（只在成功时有意义）；摘录与「上次结果」都从它截 */
  answer?: string;
  /** 会话没开成（launch 失败）：运行记录不指向任何会话 */
  noSession?: boolean;
  /** 失败不计入「连续失败」（应用退出时被打断的那类：不是自动化自己的错） */
  notCounted?: boolean;
}

/**
 * 把一次运行的结果写进状态：运行记录翻终态；成功清连续失败、（new_session 才）记下「上次结果」；
 * 失败累加，到 3 次进入失败态（带原因）；终点到了（maxRuns 用完 / 没有下一次排期）完成。
 */
export function applyRunResult(automation: Automation, runId: string, result: RunResult, now: number): Automation {
  const index = automation.runs.findIndex((run) => run.id === runId);
  const existing = automation.runs[index];
  if (existing === undefined) return automation;
  const answer = result.answer?.trim() ?? "";
  const run: AutomationRun = {
    ...existing,
    status: result.status,
    durationMs: result.durationMs,
    tokens: result.tokens,
    ...(result.noSession === true ? { sessionId: null } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    ...(result.status === "success" && answer !== "" ? { resultExcerpt: clipText(answer, AUTOMATION_EXCERPT_MAX) } : {}),
  };
  const runs = [...automation.runs];
  runs[index] = run;
  const failures =
    result.status === "success"
      ? 0
      : result.notCounted === true
        ? automation.consecutiveFailures
        : automation.consecutiveFailures + 1;
  let next: Automation = {
    ...automation,
    runs,
    consecutiveFailures: failures,
    updatedAt: now,
    // this_session 不存「上次结果」：那条会话的对话里本来就有上一次
    ...(result.status === "success" && answer !== "" && automation.target.kind === "new_session"
      ? { lastResult: clipText(answer, AUTOMATION_LAST_RESULT_MAX) }
      : {}),
  };
  if (next.status === "active") {
    if (failures >= AUTOMATION_MAX_CONSECUTIVE_FAILURES) {
      next = { ...next, status: "failed", failureReason: result.error ?? "Failed repeatedly.", nextRunAt: null };
      delete next.pendingDelivery;
    } else if (next.maxRuns !== undefined && next.runCount >= next.maxRuns) {
      next = completed(next, "finished", now);
    } else if (next.nextRunAt === null) {
      // once 触发后、或下一次排到了 until 之外：这次跑完就是终点
      next = completed(next, next.schedule.kind === "once" ? "finished" : "expired", now);
    }
  }
  return next;
}

/* ---------- 调度器 ---------- */

export interface SchedulerDeps {
  store: AutomationStore;
  now(): number;
  /** 实验开关（每次 tick 现读：关着调度器什么都不做） */
  enabled(): Promise<boolean>;
  /** new_session：开一条会话并开轮（launch.ts 的 launchAutomationRun 套好依赖）；失败抛错，会话已回滚 */
  launch(input: { automation: Automation; sessionId: string; number: number; at: number; trigger: AutomationRunTrigger }): Promise<void>;
  /** this_session：把指令送回目标会话（launch.ts 的 deliverAutomationRun）；会话没了抛 SessionGoneError */
  deliver(input: { automation: Automation; number: number; at: number }): Promise<void>;
  /** 目标会话还在吗（被删了 → 任务 completed / sessionDeleted） */
  sessionExists(sessionId: string): Promise<boolean>;
  /** 这条会话此刻是不是在跑（主进程按 phase 事件维护的 phases 表） */
  isSessionBusy(sessionId: string): boolean;
  /** 中止一条会话在跑的轮（超时用） */
  abort(sessionId: string): Promise<void>;
  /** 任何一条自动化变了：推给 renderer 重拉 */
  notify(): void;
  /** 正在执行的运行数变了（阻止睡眠开关据此放开 / 拦住） */
  onActiveChange?: (count: number) => void;
  newId?: () => string;
}

interface ActiveRun {
  automationId: string;
  runId: string;
  /** 这次运行跑在哪条会话：new_session 是新开的；this_session 是目标会话 */
  sessionId: string;
  startedAt: number;
  /** 最近一条有文字的 assistant 终态帧的全部文字块：最终回答 */
  answer: string;
  /** 最后一条 assistant 终态帧的状态（error / aborted 说明这轮没正常说完） */
  lastStatus: "complete" | "error" | "aborted" | null;
  lastErrorMessage: string | null;
  tokens: number | null;
  /** 回合级失败（turn: true）：这一轮没得到回答 */
  turnFailure: string | null;
  /** 其它失败帧：只有在没产出任何回答时才算这次运行失败 */
  softFailure: string | null;
  /** 是否测 token：this_session 的会话 stats 是整条会话累计的，量不出这一次 */
  trackTokens: boolean;
}

export type RunNowOutcome = { ok: true } | { ok: false; error: string };

export class AutomationScheduler {
  private readonly deps: SchedulerDeps;
  private readonly newId: () => string;
  /** 在跑的运行，按自动化 id */
  private readonly active = new Map<string, ActiveRun>();
  /** 会话 id → 自动化 id：agent 事件按它路由（同一条会话同一时刻至多一个运行：忙就等） */
  private readonly bySession = new Map<string, string>();
  /** 有等待送达的 this_session 任务的会话：这些会话 idle 时要回头送 */
  private readonly pendingSessions = new Set<string>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private tickQueued = false;
  private recovered = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.newId = deps.newId ?? randomUUID;
  }

  /** 起 30 秒 tick（幂等）。不立刻 tick——调用方在主进程就绪后自己决定 */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick().catch(logError), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** 正在执行的运行数 */
  activeCount(): number {
    return this.active.size;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(fn);
    this.serial = task.catch(() => undefined);
    return task;
  }

  private sessionBusy(sessionId: string): boolean {
    return this.bySession.has(sessionId) || this.deps.isSessionBusy(sessionId);
  }

  private setActive(run: ActiveRun): void {
    this.active.set(run.automationId, run);
    this.bySession.set(run.sessionId, run.automationId);
    this.deps.onActiveChange?.(this.active.size);
  }

  private clearActive(run: ActiveRun): void {
    this.active.delete(run.automationId);
    this.bySession.delete(run.sessionId);
    this.deps.onActiveChange?.(this.active.size);
  }

  /** 看一眼有没有到点的。睡眠唤醒（powerMonitor resume）与启动后都直接调它 */
  async tick(): Promise<void> {
    if (!(await this.deps.enabled())) return;
    // 队列里已经有一个等着的 tick 就不再叠：开会话慢的时候别攒一串
    if (this.tickQueued) return;
    this.tickQueued = true;
    await this.enqueue(async () => {
      this.tickQueued = false;
      const now = this.deps.now();
      if (!this.recovered) {
        await this.recover(now);
        this.recovered = true;
      }
      await this.reapTimeouts(now);
      await this.sweepGoneSessions(now);
      for (const automation of await this.deps.store.list()) {
        if (automation.status !== "active") continue;
        if (this.active.size >= MAX_CONCURRENT_RUNS) break;
        if (automation.nextRunAt !== null && automation.nextRunAt <= now) {
          const late = now - automation.nextRunAt > LATE_MS;
          await this.fire(automation.id, now, late ? "caughtUp" : "schedule");
        } else if (automation.pendingDelivery !== undefined) {
          await this.drainPending(automation.id, now);
        }
      }
    });
  }

  /** 面板上的「立即运行」：不动排期，开 / 送一次 */
  runNow(automationId: string): Promise<RunNowOutcome> {
    return this.enqueue(async () => {
      if (!(await this.deps.enabled())) return { ok: false, error: "Automations are turned off." };
      const automation = await this.deps.store.get(automationId);
      if (automation === null) return { ok: false, error: "Automation not found." };
      if (automation.target.kind === "this_session" && !(await this.deps.sessionExists(automation.target.sessionId))) {
        await this.complete(automation.id, "sessionDeleted");
        return { ok: false, error: "The session this automation is bound to no longer exists." };
      }
      return this.fire(automationId, this.deps.now(), "manual");
    });
  }

  /** 绑定的会话被删了的 this_session 任务一律翻成 completed（会话没了，叫醒谁） */
  private async sweepGoneSessions(now: number): Promise<void> {
    for (const automation of await this.deps.store.list()) {
      if (automation.target.kind !== "this_session" || automation.status === "completed") continue;
      if (await this.deps.sessionExists(automation.target.sessionId)) continue;
      await this.complete(automation.id, "sessionDeleted", now);
    }
  }

  private async complete(automationId: string, reason: AutomationEndReason, now: number = this.deps.now()): Promise<void> {
    await this.deps.store.update(automationId, (current) => (current.status === "completed" ? null : completed(current, reason, now)));
    this.deps.notify();
  }

  /** 排在队列里的一次触发：决策是纯函数，这里只负责落盘、开会话 / 送会话与失败收尾 */
  private async fire(automationId: string, now: number, trigger: AutomationRunTrigger): Promise<RunNowOutcome> {
    const runId = this.newId();
    // 闭包里赋值、闭包外读：用对象装，免得 TS 把窄化后的 null 当成永远是 null
    const box: { plan: FirePlan; before: Automation | null; sessionId: string } = {
      plan: { kind: "none" },
      before: null,
      sessionId: this.newId(),
    };
    await this.deps.store.update(automationId, (current) => {
      box.before = current;
      const bound = current.target.kind === "this_session" ? current.target.sessionId : null;
      if (bound !== null) box.sessionId = bound;
      const busy = bound !== null ? this.sessionBusy(bound) : this.active.has(automationId);
      box.plan = planFire(current, { now, trigger, busy, runId, sessionId: box.sessionId });
      return box.plan.kind === "none" || box.plan.kind === "refused" ? null : box.plan.next;
    });
    const { plan, before } = box;
    if (before === null) return { ok: false, error: "Automation not found." };
    if (plan.kind === "refused") return { ok: false, error: plan.error };
    if (plan.kind === "none") return { ok: true };
    if (plan.kind === "waiting" && before.target.kind === "this_session") this.pendingSessions.add(before.target.sessionId);
    this.deps.notify();
    if (plan.kind !== "go") return { ok: true };
    await this.begin(before, plan.next, runId, box.sessionId, plan.number, now, trigger);
    return { ok: true };
  }

  /** this_session 等待中的送达：会话空闲了就送一次 */
  private async drainPending(automationId: string, now: number): Promise<void> {
    const runId = this.newId();
    const box: { plan: FirePlan; before: Automation | null; sessionId: string } = { plan: { kind: "none" }, before: null, sessionId: "" };
    await this.deps.store.update(automationId, (current) => {
      box.before = current;
      if (current.target.kind !== "this_session") return null;
      box.sessionId = current.target.sessionId;
      const busy = this.sessionBusy(box.sessionId);
      box.plan = planPending(current, { now, busy, runId, sessionId: box.sessionId });
      return box.plan.kind === "go" || box.plan.kind === "skipped" || box.plan.kind === "ended" ? box.plan.next : null;
    });
    const { plan, before } = box;
    if (before === null || plan.kind === "none") return;
    this.deps.notify();
    if (plan.kind !== "go") return;
    await this.begin(before, plan.next, runId, box.sessionId, plan.number, now, before.pendingDelivery?.trigger ?? "schedule");
  }

  /** 登记在跑的运行，然后开会话 / 送会话；开不成当场把这次运行记成失败 */
  private async begin(
    before: Automation,
    after: Automation,
    runId: string,
    sessionId: string,
    number: number,
    now: number,
    trigger: AutomationRunTrigger,
  ): Promise<void> {
    const run: ActiveRun = {
      automationId: before.id,
      runId,
      sessionId,
      startedAt: now,
      answer: "",
      lastStatus: null,
      lastErrorMessage: null,
      tokens: null,
      turnFailure: null,
      softFailure: null,
      trackTokens: before.target.kind === "new_session",
    };
    this.setActive(run);
    try {
      if (before.target.kind === "new_session") {
        await this.deps.launch({ automation: after, sessionId, number, at: now, trigger });
      } else {
        await this.deps.deliver({ automation: after, number, at: now });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error(`[automation] 「${before.title}」没能开始运行`, cause);
      this.clearActive(run);
      const end = this.deps.now();
      await this.deps.store.update(before.id, (current) =>
        applyRunResult(current, runId, { status: "error", durationMs: end - now, tokens: null, error: message, noSession: before.target.kind === "new_session" }, end),
      );
      this.deps.notify();
    }
  }

  /** 收一条 agent 事件：只路由属于在跑运行的会话，同步写内存快照；idle 才排收尾 */
  onAgentEvent(event: AgentEvent): void {
    if (event.type === "phase") {
      if (event.phase !== "idle") return;
      const running = this.runOfSession(event.sessionId);
      if (running === undefined && !this.pendingSessions.has(event.sessionId)) return;
      void this.enqueue(async () => {
        if (running !== undefined) await this.settle(running, undefined);
        if (this.pendingSessions.has(event.sessionId)) await this.drainSession(event.sessionId);
      }).catch(logError);
      return;
    }
    if (this.bySession.size === 0) return;
    if (event.type === "failed") {
      if (event.sessionId === null) return;
      const run = this.runOfSession(event.sessionId);
      if (run === undefined) return;
      if (event.turn === true) run.turnFailure = event.message;
      else run.softFailure = event.message;
      return;
    }
    if (event.type === "stats") {
      const run = this.runOfSession(event.sessionId);
      if (run !== undefined && run.trackTokens) run.tokens = event.stats.tokens.total;
      return;
    }
    if (event.type === "progress") {
      const run = this.runOfSession(event.sessionId);
      if (run === undefined || event.progress.type !== "item_finished") return;
      const item = event.progress.item;
      if (item.role !== "assistant") return;
      run.lastStatus = item.status === "complete" ? "complete" : item.status === "aborted" ? "aborted" : "error";
      run.lastErrorMessage = item.status === "error" ? (item.errorMessage ?? null) : null;
      const text = item.content
        .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (text !== "") run.answer = text;
    }
  }

  private runOfSession(sessionId: string): ActiveRun | undefined {
    const automationId = this.bySession.get(sessionId);
    return automationId === undefined ? undefined : this.active.get(automationId);
  }

  /** 一条会话空闲了：把等着送它的任务送出去 */
  private async drainSession(sessionId: string): Promise<void> {
    const now = this.deps.now();
    let stillPending = false;
    for (const automation of await this.deps.store.list()) {
      if (automation.target.kind !== "this_session" || automation.target.sessionId !== sessionId) continue;
      if (automation.pendingDelivery === undefined || automation.status !== "active") continue;
      if (this.active.size >= MAX_CONCURRENT_RUNS || this.sessionBusy(sessionId)) {
        stillPending = true;
        continue;
      }
      await this.drainPending(automation.id, now);
      // 送出去之后这条会话又忙了，其余的接着等
      if (this.sessionBusy(sessionId)) stillPending = true;
    }
    if (!stillPending) this.pendingSessions.delete(sessionId);
  }

  /**
   * 一次运行收尾：成败判定 → 写 store → 通知。成功 = 没有回合级失败、最后一条回答不是 error / aborted、
   * 且（没有其它失败帧 或 至少产出了回答）。`forcedError` 给超时这类外部原因。
   */
  private async settle(run: ActiveRun, forcedError: string | undefined): Promise<void> {
    if (this.active.get(run.automationId) !== run) return; // 已收过尾（超时与 idle 赛跑）
    this.clearActive(run);
    const now = this.deps.now();
    const failure =
      forcedError ??
      run.turnFailure ??
      (run.lastStatus === "error"
        ? (run.lastErrorMessage ?? "The model returned an error.")
        : run.lastStatus === "aborted"
          ? "The run was stopped before it finished."
          : run.answer === "" && run.softFailure !== null
            ? run.softFailure
            : null);
    const result: RunResult =
      failure === null
        ? { status: "success", durationMs: now - run.startedAt, tokens: run.tokens, answer: run.answer }
        : { status: "error", durationMs: now - run.startedAt, tokens: run.tokens, error: failure };
    await this.deps.store.update(run.automationId, (current) => applyRunResult(current, run.runId, result, now));
    this.deps.notify();
  }

  private async reapTimeouts(now: number): Promise<void> {
    for (const run of [...this.active.values()]) {
      if (now - run.startedAt <= RUN_TIMEOUT_MS) continue;
      await this.deps.abort(run.sessionId).catch((cause: unknown) => console.error("[automation] 超时中止失败", cause));
      await this.settle(run, `The run was stopped after ${Math.round(RUN_TIMEOUT_MS / 60_000)} minutes.`);
    }
  }

  /**
   * 启动后第一次 tick 前的自愈：上次退出时还标着 running 的运行记为中断（不计连续失败——
   * 应用退出不是自动化的错）；排期丢了的补上；等着送达的会话登记回来。
   */
  private async recover(now: number): Promise<void> {
    for (const automation of await this.deps.store.list()) {
      if (automation.target.kind === "this_session" && automation.pendingDelivery !== undefined) {
        this.pendingSessions.add(automation.target.sessionId);
      }
      const stale = automation.runs.filter((run) => run.status === "running");
      // once 排过之后、或等着送达时 nextRunAt 本来就是 null，不算丢了排期
      const lostSchedule =
        automation.status === "active" && automation.nextRunAt === null && automation.pendingDelivery === undefined;
      if (stale.length === 0 && !lostSchedule) continue;
      await this.deps.store.update(automation.id, (current) => {
        let next = current;
        for (const run of stale) {
          next = applyRunResult(
            next,
            run.id,
            { status: "error", durationMs: Math.max(0, now - run.runAt), tokens: null, error: "Interrupted: the app quit while this run was going.", notCounted: true },
            now,
          );
        }
        if (next.status === "active" && next.nextRunAt === null) {
          // 到这里仍排不出下一次的（once 已触发过 / 越过 until）已被 applyRunResult 翻成 completed；
          // 还剩 null 的是没有运行记录的，从现在重排
          next = rescheduled(next, now);
          if (next.nextRunAt === null) next = completed(next, next.schedule.kind === "once" ? "finished" : "expired", now);
        }
        return next;
      });
    }
    this.deps.notify();
  }
}

function logError(cause: unknown): void {
  console.error("[automation] 调度出错（不影响下一次 tick）", cause);
}
