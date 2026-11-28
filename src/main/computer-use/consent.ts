/**
 * 电脑使用的**会话授权闸门**（2026-11-27）。
 *
 * 为什么在这里、为什么长这样：
 *
 *   1. **授权不是工具审批**。2026-11-16 用户删掉了整套 PermissionMode 与审批卡（不带上下文、
 *      卡住长程任务）。这一层问的是「本会话里 agent 能不能碰这台沙箱桌面」——一次点头，
 *      本会话内不再问；答完就是一条持久记录（会话 meta 的 `computerUseConsent`），
 *      后续每次电脑工具执行前只读这条记录，不再弹任何东西。
 *   2. **闸门只在主进程**。电脑工具（`computer_*` 像素/UIA 车道 + `sandbox_*` 浏览器车道）
 *      的所有请求都从 agent 进程发到主进程的 `computerUseRequest`（shared/computer-use.ts），
 *      而会话 meta 与 renderer 也都归主进程——在这里拦一次就覆盖两整组工具，DOM 车道与
 *      像素车道不会各漏一条。
 *   3. **fail closed**。没人能回答时（窗口已关、没有窗口、120s 超时、会话删了、落不下盘）
 *      一律拒，并且**只有「有人回答了 / 真的超时了 / 没人可答」才写 `denied`**——绝不静默放行。
 *      超时默认放行正是这一刀要消灭的错法：模型会学会「先干起来，人回来再补票」。
 *   4. **模型不能给自己授权**。写 `allowed` 的路径只有一条：用户在确认行里点「允许本会话」
 *      （或会话里已有的持久记录）。模型能发出的只有工具请求，它没有写 meta 的通路。
 *
 * 2026-11-27 验收后的两条规矩（见 report.md 的「验收后修订」）：
 *   - **取消 ≠ 拒绝**。停轮 / 抢跑 / 会话被删 / agent 进程退出时，挂起的提问按 `cancelled`
 *     结掉：不写 meta、回一句「这一轮已停止」。否则用户只是按了停止，120s 后会话就被永久
 *     写成 denied（他从没拒绝过），而且停轮之后在还挂着的确认行上点「允许」会真的执行。
 *   - **写盘必须被确认**。`SessionStore.update` 对不存在的会话是静默 no-op（不抛）——
 *     所以写入方要回一句「真的落下了」，没落下按拒绝收口（会话在挂起期间被删的那条路）。
 *
 * 提问通道的复用说明（任务要求「先找仓里已有的提问/回答通道」）：
 *   - `intentAsk` / `agentAnswerIntentConfirm`（src/agent/intent-confirm-wait.ts）是**存在**的
 *     一条 ask/answer，但它是 agent 进程里的 `IntentConfirmWaiter`，载荷是意图确认卡的
 *     `IntentAskView[]` / `IntentConfirmDecision`，落点是右栏意图面板——语义与落点都对不上
 *     一次会话级授权，硬塞会把两件事的「已答 / 未答」混在一个 requestId 表里。
 *   - 内置浏览器的 `request_user_action`（main/browser/sandbox.ts 的 beginHandoff）是**主进程
 *     侧**的 pending promise + renderer 回答，但它绑死在一个 tab 上：占住该 tab 的命令队列、
 *     画在浏览器工具条里、依赖 tab 生命周期才会 settle。桌面授权没有 tab 可挂。
 *   - 因此这里建**最小的一对**：主进程广播 `computerUseConsentAsk`（同 agent:event 通道，
 *     与 intentAsk / 急停同一条路），renderer 用 `computer-use:consent-answer` 回答。
 *     形状照抄 beginHandoff 的成熟部分：requestId 对号、超时按「没发生」结、陈旧应答丢弃。
 *
 * 纯主进程模块：不 import electron（广播函数注入），node --test 可直接加载。
 */
import { randomUUID } from "node:crypto";
import {
  COMPUTER_USE_CONSENT_DENIED_TEXT,
  COMPUTER_USE_CONSENT_STOPPED_TEXT,
  COMPUTER_USE_CONSENT_TIMEOUT_MS,
  type ComputerUseConsent,
  type ComputerUseConsentAskCancelledEvent,
  type ComputerUseConsentAskEvent,
  type ComputerUseConsentSource,
  type ComputerUseConsentStateEvent,
  type ComputerUseToolRequest,
} from "../../shared/computer-use.ts";

/**
 * 一次提问的结局。
 * - `allowed` / `denied`：用户答了（或超时按拒绝）——闸门会写 meta。
 * - `cancelled`：这一轮结束了、提问作废——**不写 meta**，工具以「本轮已停止」收场。
 */
export type ConsentAskOutcome =
  | { decision: "allowed"; requestId: string; source: "answered" }
  | { decision: "denied"; requestId: string; source: "answered" | "timeout" | "unavailable" }
  | { decision: "cancelled"; requestId: string; source: "cancelled" };

interface PendingAsk {
  requestId: string;
  promise: Promise<ConsentAskOutcome>;
  settle: (outcome: ConsentAskOutcome) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ComputerUseConsentWaiterDeps {
  /** 主进程 → renderer：提问（生产是 broadcastAgentEvent；测试收进数组） */
  send: (event: ComputerUseConsentAskEvent) => void;
  /** 主进程 → renderer：提问被撤掉（本轮结束）。没有它就是只清主进程侧 */
  notifyCancelled?: (event: ComputerUseConsentAskCancelledEvent) => void;
  timeoutMs?: number;
  now?: () => number;
  /** 超时结掉时留一行日志（默认 console.warn，测试可静音） */
  log?: (message: string) => void;
}

/**
 * 挂起的「电脑使用授权」提问表。
 *
 * **一条会话同一时刻最多一个提问**：一批并行工具调用（模型常常一次发 screenshot + click）
 * 会同时撞到 `unset`，第二、三个应当共用同一个问题——各自弹一张卡会让用户回答三次，
 * 而三次回答说的是同一件事。所以 `ask` 对同会话的重复调用返回同一个 promise。
 *
 * 应答按 requestId 校对：迟到 / 陈旧的应答丢弃（对话被停、会话删掉之后用户才点「允许」，
 * 不能让那一下给下一条会话放行）。
 */
export class ComputerUseConsentWaiter {
  private readonly pending = new Map<string, PendingAsk>();
  private readonly send: (event: ComputerUseConsentAskEvent) => void;
  private readonly notifyCancelled: ((event: ComputerUseConsentAskCancelledEvent) => void) | null;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(deps: ComputerUseConsentWaiterDeps) {
    this.send = deps.send;
    this.notifyCancelled = deps.notifyCancelled ?? null;
    this.timeoutMs = deps.timeoutMs ?? COMPUTER_USE_CONSENT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((message) => console.warn(`[computer-use] ${message}`));
  }

  /**
   * 发一次提问并挂起等回答。同会话已有挂起的提问时直接复用（见类注释）。
   * 超时按 **denied** 结掉——不是「等一下再说」，也不是放行。
   */
  ask(sessionId: string, action: ComputerUseToolRequest["action"]): Promise<ConsentAskOutcome> {
    const existing = this.pending.get(sessionId);
    if (existing !== undefined) return existing.promise;

    const requestId = `${sessionId}:consent:${randomUUID()}`;
    let settle: (outcome: ConsentAskOutcome) => void = () => undefined;
    const promise = new Promise<ConsentAskOutcome>((resolve) => {
      settle = resolve;
    });
    const entry: PendingAsk = { requestId, promise, settle, timer: null };
    entry.timer = setTimeout(() => {
      this.log(`授权提问超时（${Math.round(this.timeoutMs / 1000)}s），按拒绝处理：${sessionId}`);
      this.finish(sessionId, { decision: "denied", requestId, source: "timeout" });
    }, this.timeoutMs);
    this.pending.set(sessionId, entry);
    this.send({ type: "computerUseConsentAsk", sessionId, requestId, action, askedAt: this.now() });
    return promise;
  }

  /** 应答到达：requestId 对得上才结（陈旧应答丢弃）。返回是否真的结掉了。 */
  answer(requestId: string, allowed: boolean): boolean {
    const pending = this.findByRequestId(requestId);
    if (pending === null) return false;
    this.finish(pending.sessionId, {
      decision: allowed ? "allowed" : "denied",
      requestId,
      source: "answered",
    });
    return true;
  }

  /**
   * 这一轮结束了（停止 / 抢跑 / interrupt / 会话被删 / agent 进程退出）：
   * 把该会话挂起的提问按 **cancelled** 结掉——不写 meta、回「本轮已停止」，
   * 并通知 renderer 把确认行撤下。没有挂起的提问是 no-op。
   *
   * 为什么不能按 denied 结：用户没有表态。按 denied 结会（a）让停轮之后迟迟点在
   * 确认行上的「允许」真的执行一个已经不存在了的动作，（b）120s 后把从没拒绝过的
   * 会话永久写成 denied、以后不再问。
   */
  cancel(sessionId: string): void {
    const pending = this.pending.get(sessionId);
    if (pending === undefined) return;
    this.finish(sessionId, { decision: "cancelled", requestId: pending.requestId, source: "cancelled" });
    this.notifyCancelled?.({
      type: "computerUseConsentAskCancelled",
      sessionId,
      requestId: pending.requestId,
      reason: "turn-ended",
    });
  }

  /** 所有会话的挂起提问按 cancelled 结掉（agent 进程整个退出）。 */
  cancelAll(): void {
    for (const sessionId of [...this.pending.keys()]) this.cancel(sessionId);
  }

  /**
   * 再也没有人能回答这些问题了（主窗口全关 / 应用要退出）：按 **denied** 结掉。
   * 与 `cancel` 的区别只在结局：这条路上写入 denied 是对的（「没人能回答」= 拒绝），
   * 而本轮结束不是。
   */
  abandonAll(): void {
    for (const sessionId of [...this.pending.keys()]) {
      const pending = this.pending.get(sessionId);
      if (pending === undefined) continue;
      this.finish(sessionId, { decision: "denied", requestId: pending.requestId, source: "unavailable" });
      // 「按拒绝落库」由闸门在 ensure 的续体里做（write 返回后才广播），这里不替它写。
      // 注意：进程随后立刻退出时这次写可能是 best-effort（fail closed，下次启动仍是 unset，
      // 会重新问一次）——注释里别写成「已落库」。
    }
  }

  /** 等待中的会话数（测试与诊断用）。 */
  get size(): number {
    return this.pending.size;
  }

  private findByRequestId(requestId: string): { sessionId: string } | null {
    const sessionId = requestId.split(":consent:")[0] ?? "";
    if (sessionId === "") return null;
    const pending = this.pending.get(sessionId);
    return pending !== undefined && pending.requestId === requestId ? { sessionId } : null;
  }

  private finish(sessionId: string, outcome: ConsentAskOutcome): void {
    const pending = this.pending.get(sessionId);
    if (pending === undefined || pending.requestId !== outcome.requestId) return;
    if (pending.timer !== null) clearTimeout(pending.timer);
    this.pending.delete(sessionId);
    pending.settle(outcome);
  }
}

/** 闸门对一次工具请求的裁决：放行，或者一句给模型的拒绝 / 停止文本。 */
export type ConsentVerdict = { ok: true } | { ok: false; error: string };

/** 读会话时闸门要的两件事（一次读盘拿齐，避免「读两次、中间被删」的缝） */
export interface ComputerUseConsentFacts {
  consent: ComputerUseConsent;
  /**
   * 这一条会话、这一轮，用户能不能看到并回答那个提问：null = 能；否则就是回给模型的拒绝文本。
   * 由 `shared/computer-use.ts` 的 `computerUseBlockedReason(会话身份, 这一轮的发起者)` 算出来——
   * **只此一处判据**（子会话 / 幕后 / 未 promoted 的自动化会话 → 主会话专用；
   * 自动化发起的轮次 → 不弹提问）。闸门只负责当场拒。
   */
  blockedReason: string | null;
}

export interface ComputerUseConsentGateDeps {
  /** 读会话：null = 会话已不存在（按拒绝处理，不提问） */
  read: (sessionId: string) => Promise<ComputerUseConsentFacts | null>;
  /**
   * 落盘。**必须回一句「真的落下了」**：`SessionStore.update` 对不存在的会话静默 return
   * （不抛错），只 await 不抛什么都不代表写成功——会话在提问挂起期间被删时，那正是
   * 一条 fail-open 的路。
   */
  write: (sessionId: string, consent: ComputerUseConsent) => Promise<boolean>;
  /** 挂起的提问（waiter.ask）；这里不判窗口，`canAsk` 已经先问过 */
  ask: (sessionId: string, action: ComputerUseToolRequest["action"]) => Promise<ConsentAskOutcome>;
  /** 现在有没有人能回答（主窗口在不在）。false = 不提问，直接按拒绝落库 */
  canAsk: () => boolean;
  /** 状态变化广播（回答 / 超时 / 拒绝 / 撤销 / 急停）。写失败时不广播 */
  notify: (event: ComputerUseConsentStateEvent) => void;
  log?: (message: string) => void;
}

export interface ComputerUseConsentGate {
  /**
   * 电脑工具执行前的闸门。allowed / denied 直接裁决；unset 先问一次并把答复
   * （或超时 / 无人可答）落库；本轮被停掉时回「已停止」且不写 meta。
   * 任何异常路径都返回拒绝，不抛。
   */
  ensure: (sessionId: string, action: ComputerUseToolRequest["action"]) => Promise<ConsentVerdict>;
  /** 撤销 / 急停：改回 unset（下一次电脑操作重新问），并广播。 */
  reset: (sessionId: string, source: "revoked" | "emergency-stop") => Promise<void>;
}

export function createComputerUseConsentGate(deps: ComputerUseConsentGateDeps): ComputerUseConsentGate {
  const log = deps.log ?? ((message) => console.log(`[computer-use] ${message}`));

  /**
   * 落一次决定。**没落盘就不算数**：用户可能点了允许，但这条会话的 meta 写不进去
   * （刚被删 / 磁盘满），下次执行时读到 unset 又会问一遍——与其把一次没记下来的
   * 「允许」当成允许用，不如这次就不动桌面。
   */
  const record = async (
    sessionId: string,
    state: ComputerUseConsent,
    source: ComputerUseConsentSource,
    requestId?: string,
  ): Promise<boolean> => {
    let wrote = false;
    try {
      wrote = await deps.write(sessionId, state);
    } catch (cause: unknown) {
      log(`授权落盘失败（按拒绝处理）：${sessionId} ${cause instanceof Error ? cause.message : String(cause)}`);
      return false;
    }
    if (!wrote) {
      log(`授权没有落下（会话已删 / 不在盘上，按拒绝处理）：${sessionId} ${state}`);
      return false;
    }
    deps.notify({
      type: "computerUseConsentState",
      sessionId,
      state,
      source,
      ...(requestId === undefined ? {} : { requestId }),
    });
    return true;
  };

  const ensure = async (
    sessionId: string,
    action: ComputerUseToolRequest["action"],
  ): Promise<ConsentVerdict> => {
    const facts = await deps.read(sessionId).catch(() => null);
    // 会话不存在：没有 meta 可记，也没有人可以被问。fail closed。
    if (facts === null) return { ok: false, error: COMPUTER_USE_CONSENT_DENIED_TEXT };
    // 用户看不到 / 这一轮不是他发起的：确认行问了也没人答，等下去只会超时变 denied。
    // **先于授权状态判**：哪怕它的 meta 上留着 allowed，也不该在看不见的轮次里动桌面。
    if (facts.blockedReason !== null) return { ok: false, error: facts.blockedReason };
    if (facts.consent === "allowed") return { ok: true };
    if (facts.consent === "denied") return { ok: false, error: COMPUTER_USE_CONSENT_DENIED_TEXT };
    // unset：先确认有人能回答，再提问。窗口已关 / 无人看守时不弹一个没人看的卡，
    // 直接按拒绝落库（否则每来一条工具就要等到 120s 超时）。
    if (!deps.canAsk()) {
      log(`没有可回答授权的窗口，按拒绝落库：${sessionId}`);
      await record(sessionId, "denied", "unavailable");
      return { ok: false, error: COMPUTER_USE_CONSENT_DENIED_TEXT };
    }
    const outcome = await deps.ask(sessionId, action);
    // 本轮被停掉：不写 meta，回「已停止」——用户没有表态，下一次会重新问。
    if (outcome.decision === "cancelled") {
      return { ok: false, error: COMPUTER_USE_CONSENT_STOPPED_TEXT };
    }
    const recorded = await record(sessionId, outcome.decision, outcome.source, outcome.requestId);
    if (outcome.decision === "allowed" && recorded) return { ok: true };
    return { ok: false, error: COMPUTER_USE_CONSENT_DENIED_TEXT };
  };

  const reset = async (sessionId: string, source: "revoked" | "emergency-stop"): Promise<void> => {
    await record(sessionId, "unset", source);
  };

  return { ensure, reset };
}
