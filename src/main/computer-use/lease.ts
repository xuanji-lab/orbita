/**
 * 沙箱租约 —— 一个沙箱桌面同一时间只归一个会话。
 *
 * 为什么要有这一层：沙箱是**应用级一份**（SandboxController 是单例，guest 桥一条命令
 * 通道，CDP 里一页 Edge），而会话可以是**多个**——主会话和它派出的子会话真并发。消息在
 * 桥里串行，但两条动作序列会任意交错，而且交错的时候**两边都收到成功**：A 点了输入框、
 * B 点了另一个框、A 的 `computer_type` 落进 B 的框；A 拿自己那张截图的坐标去点、屏幕
 * 已经换成 B 的页面；B 的 `sandbox_navigate` 换掉 A 正在读的那一页。这些都不是偶发的
 * 竞态，是「零归属」的必然结果（上面三种在 #289 栈里都是能复现的）。
 *
 * 所以下发之前先要一张**独占租约**：拿到才下发，拿不到就回一句人话给模型。
 *
 * 状态转移（一个持有者 + 一条 FIFO 队列）：
 *   idle ──acquire(A)──▶ held(A) ──release(A) / idle 60s / 15min 硬上限──▶ idle
 *   held(A) ──acquire(B)──▶ held(A) + queue[B…]（最多 8 个，满了当场拒绝）
 *   held(A) / queue ──revoke(reason)──▶ idle，持有者与全部等待者立刻拿到终态错误
 *
 * 三条纪律，各自对应一类踩过的坑：
 *   1. **抢占的是「等待」，不是「持有」**：已有占用者时后来者排队等（有界 30s），不把
 *      持有者踢下来。踢下来就会让 A 的下一句 type 落进 B 的框——正是这一层要消灭的事。
 *   2. **硬上限不看续期**：只有 idle 线的话，一个不停截图（每张都续期）的会话能饿死别人。
 *   3. **revoke 是终态**：沙箱被停 / 进 error 时，排队者**立刻**失败，而不是等满 30s
 *      才发现沙箱没了（那时它们会拿到一句讲「被占用」的错，指向一个不存在的原因）。
 *
 * **状态只在内存里，不落 meta**：沙箱本身不跨应用存活（每次启动都从 off 开始），
 * 把租约写进会话文件只会在崩溃后留下一把没人能放掉的死锁——重启后磁盘上有持有者、
 * 内存里没有沙箱。内存态随进程消失，正是想要的性质。
 *
 * 纯逻辑：时钟与定时器由外部注入（测试用假时钟推进 30s / 60s / 15min，不真等），
 * 不引 electron、不碰文件、不知道会话标题从哪来（标题只是文案素材）。
 */
import {
  COMPUTER_USE_LEASE,
  computerUseLeaseErrors,
  type ComputerUseLeaseResult,
} from "../../shared/computer-use.ts";

/** 租约看到的时钟。测试注入一个推进用的假表；生产直接用 Date.now */
export interface LeaseClock {
  now(): number;
  /** 一次性定时器。返回取消函数 */
  setTimeout(callback: () => void, ms: number): () => void;
}

/** 观察事件：只做日志 / 后续 UI 用，不参与判定 */
export type LeaseEvent =
  | { type: "acquired"; sessionId: string; title: string; waitedMs: number; queueDepth: number }
  | {
      type: "released";
      sessionId: string;
      title: string;
      /** 谁让出来的：主动释放 / idle 到点 / 硬上限 / 沙箱被关 */
      reason: LeaseReleaseReason;
      heldMs: number;
    }
  | { type: "queued"; sessionId: string; title: string; queueDepth: number }
  | { type: "rejected"; sessionId: string; title: string; cause: "timeout" | "queueFull" | "revoked" }
  | { type: "revoked"; reason: string; droppedWaiters: number };

export type LeaseReleaseReason = "released" | "idle" | "holdExpired" | "revoked";

export interface SandboxLease {
  /**
   * 要沙箱的操作权。拿到（立刻或排队等到了）→ `{ok:true}`；超时 / 队列满 / 沙箱被关 →
   * `{ok:false, error}`，error 可以直接交给模型。
   * **同一个会话重复 acquire 是幂等的**（它已经持有，直接续期）——agent 每条命令都问一次，
   * 不能因为「已经在手」就报错。
   */
  acquire(sessionId: string, title: string): Promise<ComputerUseLeaseResult>;
  /** 续期：每成功下发一条命令就调一次。非持有者调用是 no-op（日志里留痕） */
  renew(sessionId: string): void;
  /** 主动释放（轮次结束 / abort / 会话关闭 / 急停）。非持有者调用是 no-op */
  release(sessionId: string, reason?: string): void;
  /**
   * 沙箱被停 / 进 error：把持有者与**全部**等待者清掉。等待者立刻拿到终态错误。
   * 不这么做的话，等满 30s 的会话会收到一句「被某个会话占着」——那时沙箱已经没了。
   */
  revoke(reason: string): void;
  /** 观测：当前持有者（没有就是 null） */
  owner(): LeaseOwner | null;
  /** 观测：队列深度（不含持有者） */
  queueDepth(): number;
}

export interface LeaseOwner {
  sessionId: string;
  title: string;
  /** acquire 成功的时刻 */
  since: number;
  /** 最近一次续期 / 初次持有的时刻（idle 线从这里算） */
  lastActive: number;
}

export interface SandboxLeaseOptions {
  clock: LeaseClock;
  onEvent?: (event: LeaseEvent) => void;
}

interface Holder extends LeaseOwner {
  /** 取消两根定时器 */
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

export function createSandboxLease(options: SandboxLeaseOptions): SandboxLease {
  const { clock, onEvent } = options;
  let held: Holder | null = null;
  const queue: Waiter[] = [];

  const notify = (event: LeaseEvent): void => {
    onEvent?.(event);
  };

  /** 把所有权交给 sessionId：清掉旧定时器、重启两根时钟 */
  const take = (sessionId: string, title: string, waitedMs: number): void => {
    const now = clock.now();
    const holder: Holder = {
      sessionId,
      title,
      since: now,
      lastActive: now,
      finish: () => undefined,
    };
    held = holder;
    arm(holder);
    notify({ type: "acquired", sessionId, title, waitedMs, queueDepth: queue.length });
  };

  /**
   * 挂两根时钟：idle 线（60s 无命令）与硬上限（15min，从 acquire 算，续期不动它）。
   * 每次续期 = 重新挂一次，硬上限那根按 `since` 的余量重算，所以续期不会把上限推后。
   */
  const arm = (holder: Holder): void => {
    holder.finish();
    const idleTimer = clock.setTimeout(() => {
      if (held !== holder) return;
      drop(holder, "idle");
    }, COMPUTER_USE_LEASE.idleMs);
    const remaining = holder.since + COMPUTER_USE_LEASE.holdMaxMs - clock.now();
    const capTimer = clock.setTimeout(
      () => {
        if (held !== holder) return;
        drop(holder, "holdExpired");
      },
      Math.max(0, remaining),
    );
    holder.finish = () => {
      idleTimer();
      capTimer();
    };
  };

  /**
   * 让持有者下去，并把操作权交给队列里的下一个。写进**每个**等待者的终结函数：
   * 等待者被唤醒后拿到 ok，调用方接着 acquire 的那条命令就会下发。
   */
  const drop = (holder: Holder, reason: LeaseReleaseReason): void => {
    if (held !== holder) return;
    holder.finish();
    held = null;
    notify({
      type: "released",
      sessionId: holder.sessionId,
      title: holder.title,
      reason,
      heldMs: clock.now() - holder.since,
    });
    // idle 与硬上限都只是「持有者下去了」，沙箱还在——队列头部直接接手。
    // revoke（沙箱没了）不走这里：它自己清队，不会让任何人接一把不存在的锁。
    promote();
  };

  /** 队列头部拿锁 */
  const promote = (): void => {
    while (held === null && queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      next.cancelTimer();
      next.settled = true;
      take(next.sessionId, next.title, clock.now() - next.since);
      next.settle({ ok: true });
    }
  };

  const removeWaiter = (waiter: Waiter): void => {
    const index = queue.indexOf(waiter);
    if (index >= 0) queue.splice(index, 1);
  };

  const acquire = async (sessionId: string, title: string): Promise<ComputerUseLeaseResult> => {
    // 已经持有：续期即可。agent 的每条命令都会走到这里，不能因为「锁本来就在我手上」报错
    if (held !== null && held.sessionId === sessionId) {
      held.title = title;
      renew(sessionId);
      return { ok: true };
    }
    // 已经在排队：不重复排（同一个会话的两条命令不会分到两个位置），拿原来那个等待
    const queued = queue.find((waiter) => waiter.sessionId === sessionId);
    if (queued !== undefined) {
      queued.title = title;
      // 等的时候也跟着续一次 id：排队超过 30s 的那条自己会超时，与持有者无关
      return await queued.pending;
    }
    if (held === null) {
      take(sessionId, title, 0);
      return { ok: true };
    }
    // 有占用者：排队等它。**队列满就直接拒绝**——无限排队等于把失败推给未来
    if (queue.length >= COMPUTER_USE_LEASE.queueLimit) {
      const ownerTitle = held.title;
      notify({ type: "rejected", sessionId, title, cause: "queueFull" });
      return { ok: false, error: computerUseLeaseErrors.queueFull(ownerTitle, COMPUTER_USE_LEASE.queueLimit) };
    }
    const ownerTitle = held.title;
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
      removeWaiter(waiter);
      notify({ type: "rejected", sessionId, title, cause: "timeout" });
      waiter.settle({ ok: false, error: computerUseLeaseErrors.timeout(ownerTitle) });
    }, COMPUTER_USE_LEASE.waitMs);
    queue.push(waiter);
    notify({ type: "queued", sessionId, title, queueDepth: queue.length });
    return await pending;
  };

  const renew = (sessionId: string): void => {
    if (held === null || held.sessionId !== sessionId) return;
    held.lastActive = clock.now();
    arm(held);
  };

  const release = (sessionId: string, reason?: string): void => {
    if (held === null || held.sessionId !== sessionId) {
      // 排队中的会话被停掉（abort / 关会话）：把它的等待撤掉，否则它会一直占着队列名额
      const queued = queue.find((waiter) => waiter.sessionId === sessionId);
      if (queued !== undefined) {
        removeWaiter(queued);
        queued.cancelTimer();
        queued.settled = true;
        queued.settle({ ok: false, error: computerUseLeaseErrors.revoked("会话已停止") });
      }
      return;
    }
    drop(held, "released");
  };

  const revoke = (reason: string): void => {
    const droppedWaiters = queue.length;
    const pending = queue.splice(0, queue.length);
    for (const waiter of pending) {
      waiter.cancelTimer();
      waiter.settled = true;
      waiter.settle({ ok: false, error: computerUseLeaseErrors.revoked(reason) });
    }
    if (held !== null) {
      const holder = held;
      const heldMs = clock.now() - holder.since;
      holder.finish();
      held = null;
      notify({
        type: "released",
        sessionId: holder.sessionId,
        title: holder.title,
        reason: "revoked",
        heldMs,
      });
    }
    notify({ type: "revoked", reason, droppedWaiters });
  };

  const lease: SandboxLease = {
    acquire,
    renew,
    release,
    revoke,
    owner: () => {
      if (held === null) return null;
      return { sessionId: held.sessionId, title: held.title, since: held.since, lastActive: held.lastActive };
    },
    queueDepth: () => queue.length,
  };
  return lease;
}

/** 租约下的「拿锁 → 下发 → 续期」，**下发这一步是注入的**（测试借此断言「没拿到就不下发」） */
export interface LeaseRunOptions<T> {
  lease: SandboxLease;
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
  const leased = await options.lease.acquire(options.sessionId, options.title);
  if (!leased.ok) return options.rejected(leased.error);
  try {
    return await options.run();
  } finally {
    options.lease.renew(options.sessionId);
  }
}
