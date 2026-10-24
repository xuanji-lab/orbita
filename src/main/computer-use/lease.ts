/**
 * 沙箱租约 —— 按**资源**分键：一块桌面归一个会话，每个会话的浏览器归它自己。
 *
 * 为什么要有这一层：沙箱里有两类互不相同的稀缺物。
 *
 *   1. **桌面**（`desktop:exclusive`）：一块屏幕、一个前台焦点。像素工具（截图 / 点击 / 打字 /
 *      按键 / 滚动）动的是它，而会话可以是**多个**——主会话和它派出的子会话真并发。消息在
 *      桥里串行，但两条动作序列会任意交错，而且交错的时候**两边都收到成功**：A 点了输入框、
 *      B 点了另一个框、A 的 `computer_type` 落进 B 的框；A 拿自己那张截图的坐标去点、屏幕
 *      已经换成 B 的页面。这些都不是偶发的竞态，是「零归属」的必然结果（上面三种在 #289 栈里
 *      都是能复现的）。
 *   2. **每个会话自己的浏览器**（`browser:<session>`）：v1.5-1 起一个会话一个 Edge（独立
 *      profile、端口、标签页），A 的 cdp-nav 碰不到 B 的页面。它不该排桌面的队——否则一个
 *      会话在网页上的长轮次会把所有人的 sandbox_* 串起来，网页任务等于没并行。
 *
 * 所以租约是 `Map<resourceKey, lane>`：每个键一个持有者、一条 FIFO 队列、一套独立定时器。
 * 桌面键沿用原来的全部语义（30s 等待、队列 8、idle 60s、硬上限 15min），浏览器键立刻可拿、
 * 不排队、不设 idle / 硬上限（数值见 shared 的 COMPUTER_USE_LEASE / COMPUTER_USE_BROWSER_LEASE）。
 *
 * 状态转移（每个键各自一套）：
 *   idle ──acquire(A)──▶ held(A) ──release(A) / idle / 硬上限──▶ idle
 *   held(A) ──acquire(B)──▶ held(A) + queue[B…]（桌面键最多 8 个，满了当场拒绝）
 *   held(A) / queue ──revoke(reason)──▶ idle，**所有键**的持有者与全部等待者立刻拿到终态错误
 *
 * 三条纪律（针对桌面键，各自对应一类踩过的坑）：
 *   1. **抢占的是「等待」，不是「持有」**：已有占用者时后来者排队等（有界 30s），不把
 *      持有者踢下来。踢下来就会让 A 的下一句 type 落进 B 的框——正是这一层要消灭的事。
 *   2. **硬上限不看续期**：只有 idle 线的话，一个不停截图（每张都续期）的会话能饿死别人。
 *   3. **revoke 是终态**：沙箱被停 / 进 error 时，排队者**立刻**失败，而不是等满 30s
 *      才发现沙箱没了（那时它们会拿到一句讲「被占用」的错，指向一个不存在的原因）。
 *      沙箱没了，所有键一起作废——浏览器也是沙箱里的。
 *
 * **状态只在内存里，不落 meta**：沙箱本身不跨应用存活（每次启动都从 off 开始），
 * 把租约写进会话文件只会在崩溃后留下一把没人能放掉的死锁——重启后磁盘上有持有者、
 * 内存里没有沙箱。内存态随进程消失，正是想要的性质。
 *
 * **审计只进内存**：每次拿到 / 放手 / 拒绝都记一条（key、会话、等待、持有、队列深度、时刻），
 * stats() 按 key 聚合。v1.5-2 要靠这些真实数字决定后续路线（桌面到底挤不挤），但它不是
 * 持久化账本——进程重启即清零，和租约本身同寿命。
 *
 * 纯逻辑：时钟与定时器由外部注入（测试用假时钟推进 30s / 60s / 15min，不真等），
 * 不引 electron、不碰文件、不知道会话标题从哪来（标题只是文案素材）。
 */
import {
  COMPUTER_USE_BROWSER_KEY_PREFIX,
  COMPUTER_USE_BROWSER_LEASE,
  COMPUTER_USE_LEASE,
  computerUseLeaseErrors,
  type ComputerUseLeaseAuditRecord,
  type ComputerUseLeaseKeyStats,
  type ComputerUseLeaseResult,
} from "../../shared/computer-use.ts";

/** 租约看到的时钟。测试注入一个推进用的假表；生产直接用 Date.now */
export interface LeaseClock {
  now(): number;
  /** 一次性定时器。返回取消函数 */
  setTimeout(callback: () => void, ms: number): () => void;
}

/** 观察事件：只做日志 / 后续 UI 用，不参与判定。**每个事件都带 key**，日志靠它分资源 */
export type LeaseEvent =
  | {
      type: "acquired";
      key: string;
      sessionId: string;
      title: string;
      waitedMs: number;
      queueDepth: number;
    }
  | {
      type: "released";
      key: string;
      sessionId: string;
      title: string;
      /** 谁让出来的：主动释放 / idle 到点 / 硬上限 / 沙箱被关 */
      reason: LeaseReleaseReason;
      /** 持有到放手的时长 */
      heldMs: number;
      /** 当初拿到它等了多久（审计要看的是这一对） */
      waitedMs: number;
    }
  | { type: "queued"; key: string; sessionId: string; title: string; queueDepth: number }
  | {
      type: "rejected";
      key: string;
      sessionId: string;
      title: string;
      cause: LeaseRejectCause;
    }
  | { type: "revoked"; reason: string; droppedWaiters: number; keys: number };

export type LeaseReleaseReason = "released" | "idle" | "holdExpired" | "revoked";

/** 拒绝的三种来路：等满 / 队列满 / 不排队的键被占（后者正常走不到，兜调用方传错键） */
export type LeaseRejectCause = "timeout" | "queueFull" | "busy";

/**
 * 一个资源键的策略。桌面键 = COMPUTER_USE_LEASE；浏览器键 = COMPUTER_USE_BROWSER_LEASE
 * （**null 表示这条线不存在**：浏览器键不因 idle 放手，也没有硬上限）。
 */
interface LeaseResourcePolicy {
  waitMs: number;
  queueLimit: number;
  idleMs: number | null;
  holdMaxMs: number | null;
}

export interface ComputerUseLease {
  /**
   * 要某个资源键的操作权。拿到（立刻或排队等到了）→ `{ok:true}`；超时 / 队列满 /
   * 沙箱被关 → `{ok:false, error}`，error 可以直接交给模型。
   * **同一个会话重复 acquire 是幂等的**（它已经持有，直接续期）——agent 每条命令都问一次，
   * 不能因为「已经在手」就报错。
   */
  acquire(key: string, sessionId: string, title: string): Promise<ComputerUseLeaseResult>;
  /** 续期：每成功下发一条命令就调一次。非持有者调用是 no-op（日志里留痕） */
  renew(key: string, sessionId: string): void;
  /** 主动释放一个键（非持有者调用是 no-op；排队中的会撤出队列） */
  release(key: string, sessionId: string): void;
  /**
   * 放掉这个会话在**所有键**上的位置：轮次结束 / abort / 会话关闭。
   * 不主动放的话，下一个会话要白白等到 idle 线 60s 或硬上限 15min。
   */
  releaseSession(sessionId: string): void;
  /**
   * 沙箱被停 / 进 error：把所有键的持有者与**全部**等待者清掉。等待者立刻拿到终态错误。
   * 不这么做的话，等满 30s 的会话会收到一句「被某个会话占着」——那时沙箱已经没了。
   */
  revoke(reason: string): void;
  /** 观测：某个键当前的持有者（没有就是 null） */
  owner(key: string): LeaseOwner | null;
  /** 观测：某个键的队列深度（不含持有者） */
  queueDepth(key: string): number;
  /**
   * 观测：按 key 聚合的租约统计（内存、进程生命周期内）。只列**碰过的**键——
   * 一次都没人用过的键没有数字可报。
   */
  stats(): ComputerUseLeaseKeyStats[];
  /** 观测：最近的审计记录（有界环形缓冲，最新的在末尾）。给日志与排障用 */
  audit(): ComputerUseLeaseAuditRecord[];
}

export interface LeaseOwner {
  sessionId: string;
  title: string;
  /** acquire 成功的时刻 */
  since: number;
  /** 最近一次续期 / 初次持有的时刻（idle 线从这里算） */
  lastActive: number;
}

export interface LeaseOptions {
  clock: LeaseClock;
  onEvent?: (event: LeaseEvent) => void;
}

interface Holder extends LeaseOwner {
  /** 这次拿到手之前等了多久（审计用） */
  waitedMs: number;
  /** 取消持有的定时器 */
  finish: () => void;
}

interface Waiter {
  sessionId: string;
  title: string;
  /** 这次 acquire 开始的时刻（日志算 waitedMs） */
  since: number;
  /** 等这个位置的 Promise。同一个会话重复 acquire 拿的就是它（不会分到两个位置） */
  pending: Promise<ComputerUseLeaseResult>;
  /** 唤醒 / 拒绝 / 超时都走它；`settled` 保证只生效一次 */
  settle: (result: ComputerUseLeaseResult) => void;
  settled: boolean;
  cancelTimer: () => void;
}

interface Lane {
  key: string;
  policy: LeaseResourcePolicy;
  held: Holder | null;
  queue: Waiter[];
  /** 审计计数（stats() 从这里算） */
  acquired: number;
  released: number;
  rejected: number;
  waitSumMs: number;
  holdSumMs: number;
}

/** 审计环形缓冲的容量：够看清一轮里发生过什么，又不会随进程寿命无限长 */
const AUDIT_LIMIT = 200;

/**
 * 键 → 策略。**前缀判定**而不是枚举具体会话：浏览器键的数量随会话增长，
 * 策略只取决于它是哪一类资源。
 */
function policyFor(key: string): LeaseResourcePolicy {
  return key.startsWith(COMPUTER_USE_BROWSER_KEY_PREFIX) ? COMPUTER_USE_BROWSER_LEASE : COMPUTER_USE_LEASE;
}

export function createComputerUseLease(options: LeaseOptions): ComputerUseLease {
  const { clock, onEvent } = options;
  const lanes = new Map<string, Lane>();
  const records: ComputerUseLeaseAuditRecord[] = [];

  const notify = (event: LeaseEvent): void => {
    onEvent?.(event);
  };

  const laneFor = (key: string): Lane => {
    const existing = lanes.get(key);
    if (existing !== undefined) return existing;
    const lane: Lane = {
      key,
      policy: policyFor(key),
      held: null,
      queue: [],
      acquired: 0,
      released: 0,
      rejected: 0,
      waitSumMs: 0,
      holdSumMs: 0,
    };
    lanes.set(key, lane);
    return lane;
  };

  const record = (entry: ComputerUseLeaseAuditRecord): void => {
    records.push(entry);
    if (records.length > AUDIT_LIMIT) records.splice(0, records.length - AUDIT_LIMIT);
  };

  /** 把所有权交给 sessionId：清掉旧定时器、重启这个键的时钟 */
  const take = (lane: Lane, sessionId: string, title: string, waitedMs: number): void => {
    const now = clock.now();
    const holder: Holder = {
      sessionId,
      title,
      since: now,
      lastActive: now,
      waitedMs,
      finish: () => undefined,
    };
    lane.held = holder;
    lane.acquired += 1;
    lane.waitSumMs += waitedMs;
    arm(lane, holder);
    record({
      kind: "acquired",
      key: lane.key,
      sessionId,
      waitedMs,
      heldMs: 0,
      queueDepth: lane.queue.length,
      at: now,
    });
    notify({ type: "acquired", key: lane.key, sessionId, title, waitedMs, queueDepth: lane.queue.length });
  };

  /**
   * 挂定时器：idle 线（桌面键 60s 无命令）与硬上限（桌面键 15min，从 acquire 算，续期不动它）。
   * 每次续期 = 重新挂一次，硬上限那根按 `since` 的余量重算，所以续期不会把上限推后。
   * 浏览器键两条线都是 null：它不因为「静默」被收回（回收由桥的实例 idle 线管），
   * 也不因为「占得久」被强制收回（它没占别人的东西）。
   */
  const arm = (lane: Lane, holder: Holder): void => {
    holder.finish();
    const cancels: Array<() => void> = [];
    const { idleMs, holdMaxMs } = lane.policy;
    if (idleMs !== null) {
      cancels.push(
        clock.setTimeout(() => {
          if (lane.held !== holder) return;
          drop(lane, holder, "idle");
        }, idleMs),
      );
    }
    if (holdMaxMs !== null) {
      const remaining = holder.since + holdMaxMs - clock.now();
      cancels.push(
        clock.setTimeout(
          () => {
            if (lane.held !== holder) return;
            drop(lane, holder, "holdExpired");
          },
          Math.max(0, remaining),
        ),
      );
    }
    holder.finish = () => {
      for (const cancel of cancels) cancel();
    };
  };

  /**
   * 让持有者下去，并把操作权交给这个键队列里的下一个。写进**每个**等待者的终结函数：
   * 等待者被唤醒后拿到 ok，调用方接着 acquire 的那条命令就会下发。
   */
  const drop = (lane: Lane, holder: Holder, reason: LeaseReleaseReason): void => {
    if (lane.held !== holder) return;
    holder.finish();
    lane.held = null;
    const heldMs = clock.now() - holder.since;
    lane.released += 1;
    lane.holdSumMs += heldMs;
    record({
      kind: "released",
      key: lane.key,
      sessionId: holder.sessionId,
      waitedMs: holder.waitedMs,
      heldMs,
      queueDepth: lane.queue.length,
      at: clock.now(),
    });
    notify({
      type: "released",
      key: lane.key,
      sessionId: holder.sessionId,
      title: holder.title,
      reason,
      heldMs,
      waitedMs: holder.waitedMs,
    });
    // idle 与硬上限都只是「持有者下去了」，资源还在——队列头部直接接手。
    // revoke（沙箱没了）不走这里：它自己清队，不会让任何人接一把不存在的锁。
    promote(lane);
  };

  /** 队列头部拿锁 */
  const promote = (lane: Lane): void => {
    while (lane.held === null && lane.queue.length > 0) {
      const next = lane.queue.shift();
      if (next === undefined) return;
      next.cancelTimer();
      next.settled = true;
      take(lane, next.sessionId, next.title, clock.now() - next.since);
      next.settle({ ok: true });
    }
  };

  const removeWaiter = (lane: Lane, waiter: Waiter): void => {
    const index = lane.queue.indexOf(waiter);
    if (index >= 0) lane.queue.splice(index, 1);
  };

  /** 拒绝：计数、记账、给模型一句话 */
  const reject = (
    lane: Lane,
    sessionId: string,
    title: string,
    cause: LeaseRejectCause,
    error: string,
    waitedMs: number,
  ): ComputerUseLeaseResult => {
    lane.rejected += 1;
    record({
      kind: "rejected",
      key: lane.key,
      sessionId,
      waitedMs,
      heldMs: 0,
      queueDepth: lane.queue.length,
      at: clock.now(),
    });
    notify({ type: "rejected", key: lane.key, sessionId, title, cause });
    return { ok: false, error };
  };

  const acquire = async (
    key: string,
    sessionId: string,
    title: string,
  ): Promise<ComputerUseLeaseResult> => {
    const lane = laneFor(key);
    // 已经持有：续期即可。agent 的每条命令都会走到这里，不能因为「锁本来就在我手上」报错
    if (lane.held !== null && lane.held.sessionId === sessionId) {
      lane.held.title = title;
      renew(key, sessionId);
      return { ok: true };
    }
    // 已经在排队：不重复排（同一个会话的两条命令不会分到两个位置），拿原来那个等待
    const queued = lane.queue.find((waiter) => waiter.sessionId === sessionId);
    if (queued !== undefined) {
      queued.title = title;
      return await queued.pending;
    }
    if (lane.held === null) {
      take(lane, sessionId, title, 0);
      return { ok: true };
    }
    const ownerTitle = lane.held.title;
    // 不排队的键（浏览器）：自己的浏览器永远立刻可用，走不到这条；真走到了说明调用方
    // 把别人的键递了过来——当场拒绝，不给它排一个没有超时线的队
    if (lane.policy.waitMs <= 0) {
      return reject(lane, sessionId, title, "busy", computerUseLeaseErrors.busy(ownerTitle), 0);
    }
    // 有占用者：排队等它。**队列满就直接拒绝**——无限排队等于把失败推给未来
    if (lane.queue.length >= lane.policy.queueLimit) {
      return reject(
        lane,
        sessionId,
        title,
        "queueFull",
        computerUseLeaseErrors.queueFull(ownerTitle, lane.policy.queueLimit),
        0,
      );
    }
    let cancelTimer = (): void => undefined;
    let settle = (result: ComputerUseLeaseResult): void => {
      void result;
    };
    const pending = new Promise<ComputerUseLeaseResult>((resolve) => {
      settle = (result) => resolve(result);
    });
    const waiter: Waiter = {
      sessionId,
      title,
      since: clock.now(),
      pending,
      settle: (result) => settle(result),
      settled: false,
      cancelTimer: () => cancelTimer(),
    };
    // 有界等待：到点还没轮到就撤出队列并回一句人话。定时器在 promote / revoke / release
    // 里取消；settled 标记兜住「已取消但回调已入队」的窗口。
    cancelTimer = clock.setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      removeWaiter(lane, waiter);
      const waitedMs = clock.now() - waiter.since;
      const timeoutError = computerUseLeaseErrors.timeout(ownerTitle);
      void reject(lane, sessionId, title, "timeout", timeoutError, waitedMs);
      waiter.settle({ ok: false, error: timeoutError });
    }, lane.policy.waitMs);
    lane.queue.push(waiter);
    notify({ type: "queued", key: lane.key, sessionId, title, queueDepth: lane.queue.length });
    return await pending;
  };

  const renew = (key: string, sessionId: string): void => {
    const lane = lanes.get(key);
    if (lane === undefined || lane.held === null || lane.held.sessionId !== sessionId) return;
    lane.held.lastActive = clock.now();
    arm(lane, lane.held);
  };

  const release = (key: string, sessionId: string): void => {
    const lane = lanes.get(key);
    if (lane === undefined) return;
    if (lane.held === null || lane.held.sessionId !== sessionId) {
      // 排队中的会话被停掉（abort / 关会话）：把它的等待撤掉，否则它会一直占着队列名额
      const queued = lane.queue.find((waiter) => waiter.sessionId === sessionId);
      if (queued !== undefined) {
        removeWaiter(lane, queued);
        queued.cancelTimer();
        queued.settled = true;
        queued.settle({ ok: false, error: computerUseLeaseErrors.revoked("会话已停止") });
      }
      return;
    }
    drop(lane, lane.held, "released");
  };

  const releaseSession = (sessionId: string): void => {
    for (const key of lanes.keys()) release(key, sessionId);
  };

  const revoke = (reason: string): void => {
    let droppedWaiters = 0;
    for (const lane of lanes.values()) {
      const pending = lane.queue.splice(0, lane.queue.length);
      droppedWaiters += pending.length;
      for (const waiter of pending) {
        waiter.cancelTimer();
        waiter.settled = true;
        waiter.settle({ ok: false, error: computerUseLeaseErrors.revoked(reason) });
      }
      if (lane.held !== null) {
        const holder = lane.held;
        const heldMs = clock.now() - holder.since;
        holder.finish();
        lane.held = null;
        lane.released += 1;
        lane.holdSumMs += heldMs;
        record({
          kind: "released",
          key: lane.key,
          sessionId: holder.sessionId,
          waitedMs: holder.waitedMs,
          heldMs,
          queueDepth: 0,
          at: clock.now(),
        });
        notify({
          type: "released",
          key: lane.key,
          sessionId: holder.sessionId,
          title: holder.title,
          reason: "revoked",
          heldMs,
          waitedMs: holder.waitedMs,
        });
      }
    }
    if (lanes.size > 0) notify({ type: "revoked", reason, droppedWaiters, keys: lanes.size });
  };

  const lease: ComputerUseLease = {
    acquire,
    renew,
    release,
    releaseSession,
    revoke,
    owner: (key) => {
      const lane = lanes.get(key);
      if (lane === undefined || lane.held === null) return null;
      const holder = lane.held;
      return { sessionId: holder.sessionId, title: holder.title, since: holder.since, lastActive: holder.lastActive };
    },
    queueDepth: (key) => lanes.get(key)?.queue.length ?? 0,
    stats: () =>
      [...lanes.values()].map((lane) => ({
        key: lane.key,
        acquired: lane.acquired,
        released: lane.released,
        rejected: lane.rejected,
        averageWaitMs: lane.acquired === 0 ? 0 : lane.waitSumMs / lane.acquired,
        averageHeldMs: lane.released === 0 ? 0 : lane.holdSumMs / lane.released,
        queueDepth: lane.queue.length,
        owner: lane.held?.sessionId ?? null,
      })),
    audit: () => [...records],
  };
  return lease;
}

/** 租约下的「拿锁 → 下发 → 续期」，**下发这一步是注入的**（测试借此断言「没拿到就不下发」） */
export interface LeaseRunOptions<T> {
  lease: ComputerUseLease;
  /** 资源键：desktop:exclusive 或 browserKey(sessionId) */
  key: string;
  sessionId: string;
  /** 会话标题（只是文案素材）。读不出就传空串 */
  title: string;
  /** 拿到租约之后才调。**没拿到就一次也不调**——这是整层存在的意义 */
  run: () => Promise<T>;
  /** 拿不到租约时返回的东西（一般是 {ok:false, error} 的那种回执） */
  rejected: (error: string) => T;
}

/**
 * 把 「先拿租约再下发」 这一层顺序写成一处，而不是每条命令自己拼一遍。
 *
 * 它不吞异常：`run` 抛了就抛（调用方那条 catch 照旧把错回给 agent），但**续期不影响
 * 结果**——下发成功或失败都续（模型可能马上重试，比如选择器失效后重新 observe），
 * 不续会让 60s idle 在模型思考的中途把锁抽走。
 */
export async function runWithLease<T>(options: LeaseRunOptions<T>): Promise<T> {
  const leased = await options.lease.acquire(options.key, options.sessionId, options.title);
  if (!leased.ok) return options.rejected(leased.error);
  try {
    return await options.run();
  } finally {
    options.lease.renew(options.key, options.sessionId);
  }
}
