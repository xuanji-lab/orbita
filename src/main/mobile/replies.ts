/**
 * 手机「回一句」的待发队列——每条会话一把串行锁、一个待发队列（主进程内存）。
 *
 * 规矩（规格 4.4 / 4.5）：
 * - 回复时这条会话空闲就立刻发（`queued: false`）；在跑就排队，`queued: true`，`position` 是它前面
 *   的条数。每条会话最多排 5 条，超了回 `busy`。
 * - 发的时候照自动化 this_session 的做法，按会话 meta 拼开工上下文（`resumeTurnContext`），
 *   `text` 就是手机发来的那一句——手机只给 sessionId 和那句话。
 * - `phase` 变 `idle` 时先投下一条待发的回复。
 * - agent 那头的失败走广播事件、不带调用方：按会话对回给发起的手机（`reply.failed`）；发成功了
 *   `reply.sent`。
 * - 停止：清掉这条会话的待发队列，逐条回 `unavailable`；已经发出去的那一条不动（它是被用户停的）。
 * - 手机断线不丢队列；璇玑退出才清（`cancelAll`）。
 *
 * **为什么在飞的那一条要单独记**：`submitTurn` 返回只说明命令发给了 agent 进程，这一轮真正开起来
 * 是几百毫秒之后的事，那之前运行态表里这条会话还是 idle。只看表的话，紧跟着来的第二条会判成
 * 「空闲」再发一次，撞 already running。所以每条会话有一个「在飞」的槽：从发出到收到 idle（或
 * 失败）为止，这一条会话不再直接发，只排队。
 *
 * **失败怎么对回是哪一条**：agent 的 `failed` 事件不带轮次 id。回合级失败（`turn: true`）只可能
 * 属于这条会话此刻在跑的那一轮，也就是在飞的那一条；操作级失败（开轮本身出错，比如撞了
 * already running）只在发出后几秒内才算它的——更晚的是别的操作的失败（用户在桌面上换模型没成…），
 * 不能算到回复头上。runtime 整个没了（sessionId 为 null）时所有在飞的都算失败。
 *
 * 纯核 + 依赖注入：可被 `node --test` 用假的 submitTurn 直接驱动，不 import electron。
 */
import type { AgentEvent, SubmitAgentInput } from "../../shared/agent-ipc.ts";
import type { MobileError } from "../../shared/mobile.ts";
import { resumeTurnContext } from "../agent/turn-context.ts";
import type { SessionMeta } from "../../shared/session.ts";

/** 一条来自手机的回复。`source` 是发起它的设备 id——回执只发给它 */
export interface MobileReply {
  requestId: string;
  text: string;
  source: string;
}

export interface ReplyQueueDeps {
  readMeta(sessionId: string): Promise<SessionMeta | null>;
  /** `registerAgentIpc` 返回的那个函数——与用户发消息、自动化、子会话共用同一套开轮装配 */
  submitTurn(input: SubmitAgentInput): Promise<void>;
  /** 这条会话此刻是不是有人在跑（桌面端开的也算）。来自主进程的运行态表 */
  isRunning(sessionId: string): boolean;
}

/** 回执送到哪儿。生产环境是「按设备 id 找到在线的那条连接，发一条通知」 */
export interface ReplyObserver {
  /** 发出去了：这一轮已经开跑 */
  sent(reply: MobileReply, sessionId: string): void;
  /** 没发出去，或者 agent 那头这一轮没跑成 */
  failed(reply: MobileReply, sessionId: string, error: MobileError): void;
}

export interface ReplyOutcome {
  queued: boolean;
  position: number;
}

export type ReplySubmit = ReplyOutcome | { error: MobileError };

/** 每条会话最多排几条 */
export const REPLY_QUEUE_MAX = 5;

/** 发出后多久之内收到的操作级失败算这一条的 */
const SUBMIT_GRACE_MS = 5_000;

/** agent 的失败原文最多回给手机多少字符 */
const FAILURE_TEXT_MAX = 400;

interface Lane {
  /** 已经交给 submitTurn、还没等到 idle 或失败的那一条 */
  inFlight: MobileReply | null;
  /** 在飞那一条 submitTurn 返回的时刻；0 = 还在装配 */
  inFlightSince: number;
  queue: MobileReply[];
  /** 串行锁：对这条会话的每一次读改写都排在这条链上 */
  chain: Promise<void>;
}

export class ReplyQueue {
  private readonly deps: ReplyQueueDeps;
  private readonly observer: ReplyObserver;
  private readonly lanes = new Map<string, Lane>();
  /** 退出之后不再接新的回复 */
  private disposed = false;

  constructor(deps: ReplyQueueDeps, observer: ReplyObserver) {
    this.deps = deps;
    this.observer = observer;
  }

  /**
   * 手机回了一句。空闲立刻发；在跑（或在飞）就排队。排满了回 `busy`。
   * 退出之后回 `unavailable`。
   */
  submit(sessionId: string, reply: MobileReply): Promise<ReplySubmit> {
    return this.exclusive(sessionId, (lane) => {
      if (this.disposed) return { error: { code: "unavailable", message: "电脑正在退出，这句话没有发出去" } };
      if (lane.inFlight !== null || this.deps.isRunning(sessionId)) {
        if (lane.queue.length >= REPLY_QUEUE_MAX) {
          return { error: { code: "busy", message: `这条任务还有 ${lane.queue.length} 句没发出去，等一等再回` } };
        }
        lane.queue.push(reply);
        return { queued: true, position: lane.queue.length };
      }
      lane.inFlight = reply;
      lane.inFlightSince = 0;
      void this.dispatch(sessionId, reply);
      return { queued: false, position: 0 };
    });
  }

  /** 喂 agent 事件（事件泵的订阅点）：idle 投下一条，failed 把在飞的那一条判掉 */
  onAgentEvent(event: AgentEvent): void {
    if (event.type === "phase") {
      if (event.phase !== "idle") return;
      const settled = event.sessionId;
      void this.exclusive(settled, (lane) => {
        lane.inFlight = null;
        lane.inFlightSince = 0;
        this.drainLocked(settled, lane);
      });
      return;
    }
    if (event.type !== "failed") return;
    if (event.sessionId === null) {
      // runtime 整个没了：在飞的全都失败。排着的不动——下一条会把 runtime 重新拉起来
      for (const sessionId of [...this.lanes.keys()]) void this.failWhateverInFlight(sessionId, "agent 进程退出了", event.message);
      return;
    }
    const { sessionId, message } = event;
    void this.exclusive(sessionId, (lane) => {
      if (lane.inFlight === null) return;
      // 操作级失败只认发出后几秒内的：更晚的是别的操作的
      if (event.turn !== true && !(lane.inFlightSince > 0 && Date.now() - lane.inFlightSince < SUBMIT_GRACE_MS)) return;
      const reply = lane.inFlight;
      lane.inFlight = null;
      lane.inFlightSince = 0;
      this.notifyFailed(reply, sessionId, { code: "unavailable", message: failureText("这一轮没有跑成", message) });
      this.drainLocked(sessionId, lane);
    });
  }

  /** 停止一条会话：清掉它的待发队列，逐条回 `error`。在飞的那一条不动。返回清掉的条数 */
  cancel(sessionId: string, error: MobileError): Promise<number> {
    return this.exclusive(sessionId, (lane) => {
      const dropped = lane.queue.splice(0);
      for (const reply of dropped) this.notifyFailed(reply, sessionId, error);
      return dropped.length;
    });
  }

  /**
   * 忘掉一台设备（撤销）：清掉所有会话里来自它的待发回复，逐条回 `error`。
   * 在飞的那几条不动——它们已经交给 agent 了，撤不回；但回执不会再发给它（连接已断）。
   */
  async cancelForSource(source: string, error: MobileError): Promise<number> {
    let total = 0;
    for (const sessionId of [...this.lanes.keys()]) {
      total += await this.exclusive(sessionId, (lane) => {
        const kept: MobileReply[] = [];
        let dropped = 0;
        for (const reply of lane.queue) {
          if (reply.source === source) {
            this.notifyFailed(reply, sessionId, error);
            dropped += 1;
          } else {
            kept.push(reply);
          }
        }
        lane.queue = kept;
        return dropped;
      });
    }
    return total;
  }

  /** 璇玑退出：所有待发的、在飞的都回 `error`，之后不再接新的回复 */
  cancelAll(error: MobileError): void {
    this.disposed = true;
    for (const [sessionId, lane] of this.lanes) {
      const dropped = lane.inFlight === null ? [] : [lane.inFlight];
      lane.inFlight = null;
      dropped.push(...lane.queue.splice(0));
      for (const reply of dropped) this.notifyFailed(reply, sessionId, error);
    }
    this.lanes.clear();
  }

  /** 某条会话此刻排着几条（算上在飞的）；测试与诊断用 */
  pendingCount(sessionId: string): number {
    const lane = this.lanes.get(sessionId);
    if (lane === undefined) return 0;
    return lane.queue.length + (lane.inFlight === null ? 0 : 1);
  }

  // ———————————————————— 内部 ————————————————————

  private async dispatch(sessionId: string, reply: MobileReply): Promise<void> {
    let failed: MobileError | null = null;
    try {
      const meta = await this.deps.readMeta(sessionId);
      if (meta === null) failed = { code: "not_found", message: "这条任务已经不在了" };
      else {
        const context = resumeTurnContext(meta, reply.text);
        if (!context.ok) failed = { code: "unavailable", message: "这条任务只能看、不能接着聊（它没有可续的对话状态）" };
        else await this.deps.submitTurn(context.input);
      }
    } catch (cause) {
      failed = { code: "unavailable", message: failureText("这句话没有发出去", cause instanceof Error ? cause.message : String(cause)) };
    }
    if (failed !== null) return this.failInFlight(sessionId, failed);
    await this.exclusive(sessionId, (lane) => {
      if (lane.inFlight === reply) lane.inFlightSince = Date.now();
    });
    this.guard(() => this.observer.sent(reply, sessionId));
  }

  /**
   * 在飞的那一条判成失败（以 lane 里此刻的那一条为准——`dispatch` 的失败路径晚一步才到，
   * 这期间它可能已经被 idle 或 failed 事件处理过，那就什么都不做），然后照常往下投
   */
  private failInFlight(sessionId: string, error: MobileError): Promise<void> {
    return this.exclusive(sessionId, (lane) => {
      if (lane.inFlight === null) return;
      const reply = lane.inFlight;
      lane.inFlight = null;
      lane.inFlightSince = 0;
      this.notifyFailed(reply, sessionId, error);
      this.drainLocked(sessionId, lane);
    });
  }

  /** runtime 整个没了：不管哪一条在飞，都按 `lead：detail` 判失败；不接着投（排着的等下一次投递时机） */
  private failWhateverInFlight(sessionId: string, lead: string, detail: string): Promise<void> {
    return this.exclusive(sessionId, (lane) => {
      if (lane.inFlight === null) return;
      const reply = lane.inFlight;
      lane.inFlight = null;
      lane.inFlightSince = 0;
      this.notifyFailed(reply, sessionId, { code: "unavailable", message: failureText(lead, detail) });
      this.drainLocked(sessionId, lane);
    });
  }

  /** 调用方已持有这条会话的锁：有空就投队首。别的轮还在跑（桌面端开的）就等它的 idle */
  private drainLocked(sessionId: string, lane: Lane): void {
    if (this.disposed || lane.inFlight !== null || lane.queue.length === 0) return;
    if (this.deps.isRunning(sessionId)) return;
    const next = lane.queue.shift();
    if (next === undefined) return;
    lane.inFlight = next;
    lane.inFlightSince = 0;
    void this.dispatch(sessionId, next);
  }

  private notifyFailed(reply: MobileReply, sessionId: string, error: MobileError): void {
    this.guard(() => this.observer.failed(reply, sessionId, error));
  }

  /** 回执送不出去（观察者抛错）不能影响队列本身 */
  private guard(notify: () => void): void {
    try {
      notify();
    } catch (cause) {
      console.error("[mobile] 回复的回执没送出去", cause);
    }
  }

  /**
   * 对一条会话的读改写都排到它的链上；链上某一环失败不卡住后面的。
   * 链的最后一环跑完、这条会话也空了，就把槽收掉——不然长跑的应用里会攒下一堆没人要的槽。
   * **只在链尾收**：排在后面的环手里还是这个槽对象，中间收掉的话新来的回复会另起一个槽，锁就白排了。
   */
  private exclusive<T>(sessionId: string, run: (lane: Lane) => Promise<T> | T): Promise<T> {
    const lane = this.laneOf(sessionId);
    const next = lane.chain.then(() => run(lane), () => run(lane));
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    lane.chain = settled;
    void settled.then(() => {
      if (lane.chain === settled && lane.inFlight === null && lane.queue.length === 0 && this.lanes.get(sessionId) === lane) {
        this.lanes.delete(sessionId);
      }
    });
    return next;
  }

  private laneOf(sessionId: string): Lane {
    let lane = this.lanes.get(sessionId);
    if (lane === undefined) {
      lane = { inFlight: null, inFlightSince: 0, queue: [], chain: Promise.resolve() };
      this.lanes.set(sessionId, lane);
    }
    return lane;
  }
}

/** 给手机的一句失败说明：一句中文 + agent 或开轮的原文（截到 400 字符） */
function failureText(lead: string, detail: string): string {
  const text = detail.trim();
  if (text === "") return lead;
  const chars = [...text];
  return `${lead}：${chars.length > FAILURE_TEXT_MAX ? `${chars.slice(0, FAILURE_TEXT_MAX).join("")}…` : text}`;
}
