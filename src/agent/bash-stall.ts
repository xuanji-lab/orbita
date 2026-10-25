/**
 * 「疑似停滞」判定与提示文案——**只提示，绝不杀**。
 *
 * 判据（两段式，避免一直采样）：
 * 1. 命令仍在跑、且静默满 `STALL_QUIET_MS`(30s) → 取第一次进程树 CPU 采样 S0；
 * 2. 再隔 `STALL_CONFIRM_MS`(60s) → 取第二次采样 S1；
 * 3. `S1 - S0 < STALL_CPU_DELTA_MS`(100ms) → 疑似停滞，追加一行提示。
 *
 * **为什么两个信号必须联合**：只静默 → `sleep 60` / 等输入 / 等网络这类合法静默全
 * 误报；只 CPU → 只写 stdout 的命令 CPU 几乎不涨，同样误报。详见 `./proc-tree.ts` 头注释。
 *
 * **为什么绝不据此杀进程**：Win10 实测「合法静默」与「阻塞读 stdin」的线程状态逐项
 * 相同（WaitReason 也区分不出来），停机判据与真卡住在系统层面无法区分。杀错了会打断
 * 用户的构建 / 部署。所以判据只能落到「提示模型与用户」，中止由他们决定。
 *
 * **为什么最多采样两次**：Windows 一次进程表快照约 700ms。常态零成本（只挂 data
 * 事件），两次采样只在「已经静默 30 秒」这条稀有路径上发生；S0 之后一旦又来输出，
 * 就说明它在动——直接放弃这条命令的观察，不再采样，也就不会出现第三条。
 */
import { readTreeCpuMs } from "./proc-tree.ts";

/** 静默多久开始第一次采样。30 秒：短于常见构建的静默间隙，长于普通快命令。 */
export const STALL_QUIET_MS = 30_000;
/** 两次采样之间的确认窗口。60 秒：够长到足以看见一个真正在干活的命令推进 CPU。 */
export const STALL_CONFIRM_MS = 60_000;
/** 确认窗口内 CPU 增长低于这个值才算「没在干活」。100ms 是噪声之上的量级（7200 帧 @60fps）。 */
export const STALL_CPU_DELTA_MS = 100;

/** 判定的输入：两次采样 + 静默时长 + 「命令是不是已经结束」。 */
export interface StallSamples {
  /** 判定时刻的静默总时长（毫秒）。 */
  quietMs: number;
  /** 两次采样的实际间隔（毫秒）——写进文案，别写死 60。 */
  confirmMs: number;
  s0CpuMs: number | null;
  s1CpuMs: number | null;
  /** 命令在确认窗口内结束：它就不是停滞，什么都不做。 */
  ended?: boolean;
  quietThresholdMs?: number;
  cpuDeltaMs?: number;
}

export interface StallVerdict {
  /** 静默总时长（秒，四舍五入）——「本命令有 N 秒无输出」。 */
  quietSeconds: number;
  /** 采样窗口（秒）——「采样 60 秒」。 */
  confirmSeconds: number;
  /** 判据阈值（毫秒）——「CPU 增长 < 100ms」说的是阈值，不是实测差值。 */
  cpuLimitMs: number;
  /** 实测差值（毫秒），只进日志与测试断言，不进给模型的文案。 */
  cpuDeltaMs: number;
}

/**
 * 纯判定。返回 `null` 表示「不停滞 / 判不了」，两种情况都不该产生任何提示。
 *
 * 采样为 null（进程表读不到、root 已退出）**直接放弃**：判不了就说判不了，不猜。
 */
export function judgeStall(samples: StallSamples): StallVerdict | null {
  if (samples.ended === true) return null;
  if (samples.s0CpuMs === null || samples.s1CpuMs === null) return null;
  const quietLimit = samples.quietThresholdMs ?? STALL_QUIET_MS;
  if (!(samples.quietMs >= quietLimit)) return null;
  const delta = samples.s1CpuMs - samples.s0CpuMs;
  // 负数只可能来自「两次读到的不是同一棵树」（pid 复用 / 中间层退出），不是事实，不猜
  if (!(delta >= 0)) return null;
  const cpuLimit = samples.cpuDeltaMs ?? STALL_CPU_DELTA_MS;
  if (delta >= cpuLimit) return null;
  return {
    quietSeconds: Math.round(samples.quietMs / 1000),
    confirmSeconds: Math.round(samples.confirmMs / 1000),
    cpuLimitMs: cpuLimit,
    cpuDeltaMs: Math.round(delta),
  };
}

/**
 * 提示文案：与后代存活提示同一个通道（`onData`）、同一种 `[orbita]` 契约。
 * `cpu_delta` 是**实测**差值（毫秒），散文里说的 `< cpuLimitMs` 是**阈值**——
 * 两个数字都保留，模型才分得清「离阈值有多远」与「阈值是多少」。
 * 不说「已卡死」——判据证明不了；能做的事写清（停掉 / 改用 terminal_*）。
 */
export function stallNotice(verdict: StallVerdict): string {
  return (
    `\n[orbita] kind=stalled quiet=${verdict.quietSeconds}s sampled=${verdict.confirmSeconds}s ` +
    `cpu_delta=${verdict.cpuDeltaMs}ms | ` +
    `No output for ${verdict.quietSeconds}s, and the process tree used less than ${verdict.cpuLimitMs}ms ` +
    `of CPU over a ${verdict.confirmSeconds}s sample. It may be waiting for input or the network, ` +
    "deadlocked, or just slow. If it is not making progress, stop it or use the terminal_* tools.\n"
  );
}

export interface StallWatchOptions {
  quietMs?: number;
  confirmMs?: number;
  cpuDeltaMs?: number;
  /** 采样实现（测试注入用）；默认整棵进程树累计 CPU。 */
  sampleCpuMs?: (pid: number) => Promise<number | null>;
}

export interface StallWatcher {
  /** 每来一块输出调用：静默计时归零；S0 之后来输出则彻底放弃观察。 */
  noteData(): void;
  /** 命令结束（`finally`）必须调用：清掉定时器，否则 Node 进程不退出。 */
  stop(): void;
  /**
   * 最近一次成功的进程树 CPU 采样（毫秒），一次都没采到返回 `null`。
   *
   * 只读快照，**不改变观察器语义**：到点延长（见 `./bash-observe.ts`）需要一个
   * 「此前某个时刻的 CPU」作基线，而观察器在静默 30s/90s 时已经采过两次——
   * 复用它，就不必为了拿一次基线在每条命令上额外付一次进程表快照（Windows 约 1s）。
   */
  lastCpuMs(): number | null;
}

/**
 * 观察器：只在「静默超阈值」这条路径上花成本，自身不持有子进程、不改命令行文。
 *
 * 定时器全部挂在 `StallWatcher.stop()` 上清；提示只在**命令仍在跑**时发出——结束时
 * 它就不是停滞，这是本模块唯一允许的「事实校验」，其余一律交给纯函数。
 */
export function createStallWatcher(
  pid: number,
  emit: (notice: string) => void,
  options: StallWatchOptions = {},
): StallWatcher {
  const quietMs = options.quietMs ?? STALL_QUIET_MS;
  const confirmMs = options.confirmMs ?? STALL_CONFIRM_MS;
  const cpuDeltaMs = options.cpuDeltaMs ?? STALL_CPU_DELTA_MS;
  const sampleCpuMs = options.sampleCpuMs ?? readTreeCpuMs;

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastDataAt = Date.now();
  /** 最近一次成功的采样值，只给 `lastCpuMs()` 读，不参与判定。 */
  let lastSampleMs: number | null = null;
  /** S0 已取：此后任何输出都说明它在动，放弃整条命令的观察（也保证最多两次采样）。 */
  let armed = false;

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const stop = () => {
    stopped = true;
    clearTimer();
  };

  const scheduleQuiet = () => {
    clearTimer();
    // 不重挂「每秒看一次」的轮询：一个 setTimeout 直接排到 lastDataAt + quietMs
    timer = setTimeout(() => {
      void onQuiet();
    }, Math.max(0, lastDataAt + quietMs - Date.now()));
  };

  const sample = async (): Promise<number | null> => {
    try {
      const value = await sampleCpuMs(pid);
      if (value !== null) lastSampleMs = value;
      return value;
    } catch {
      // 采样失败 = 判不了；绝不让它影响命令本身
      return null;
    }
  };

  const onQuiet = async () => {
    timer = undefined;
    if (stopped) return;
    // 定时器早醒（时钟粒度）就再等一会儿，不为它改成轮询
    if (Date.now() - lastDataAt < quietMs) {
      scheduleQuiet();
      return;
    }
    armed = true;
    const s0 = await sample();
    if (stopped) return;
    const s0At = Date.now();
    timer = setTimeout(() => {
      void onConfirm(s0, s0At);
    }, confirmMs);
  };

  const onConfirm = async (s0: number | null, s0At: number) => {
    timer = undefined;
    if (stopped) return;
    const s1 = await sample();
    const s1At = Date.now();
    const verdict = judgeStall({
      quietMs: Date.now() - lastDataAt,
      confirmMs: s1At - s0At,
      s0CpuMs: s0,
      s1CpuMs: s1,
      ended: stopped,
      quietThresholdMs: quietMs,
      cpuDeltaMs,
    });
    // 采样期间命令结束（stop）或来输出（stopped 由 noteData 置位）→ 不发
    if (verdict !== null && !stopped) emit(stallNotice(verdict));
  };

  scheduleQuiet();

  return {
    noteData() {
      if (stopped) return;
      lastDataAt = Date.now();
      if (armed) {
        // S0 之后还有输出：它在干活。放弃观察，免得一条慢但正常的命令被反复采样
        stop();
        return;
      }
      scheduleQuiet();
    },
    stop,
    lastCpuMs() {
      return lastSampleMs;
    },
  };
}
