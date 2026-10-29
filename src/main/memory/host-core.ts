/**
 * MemoryServiceHost 的全部逻辑 —— **纯模块**：不 import electron，可被 `node --test`
 * 直接测（agent/host-core.ts 的同款先例）。真的 fork 在 host.ts 那层注入。
 *
 * 只做四件事：实验开关开时拉起进程（ready 后发 init）、把轮后事件转发进去、
 * 把召回请求转发进去并在超时 / 崩溃时回空命中、开关关 / 应用退出时停进程。
 *
 * 崩溃自愈：子进程退出时清掉在途的召回请求（回空命中，不拦开轮），下次
 * ensureStarted 重拉。**不自动重启**——崩溃风暴不该让主进程永远在拉进程，
 * 下一次真正要用（下一轮）时再拉。init 失败（initFailed）是例外：重拉也必然
 * 再失败，记住失败、不再拉，直到 stop()（开关关）后重开。
 *
 * llama-server 补杀：服务报来的 embedServerPid 记在这里。停服务时先发 shutdown
 * （来得及就让服务自己优雅停），再按 pid 补杀、再 kill 服务进程；服务自己崩了
 * 也补杀——Windows 上 UtilityProcess.kill() 是 TerminateProcess，服务里的退出
 * 处理一行都不会跑，这一层是唯一可靠的。
 */
import { randomUUID } from "node:crypto";
import type {
  MemoryBackfillProgress,
  MemoryChoreModel,
  MemoryDownloadProgress,
  MemoryHit,
  MemoryMutation,
  MemoryMutationOutcome,
  MemoryVectorServiceConfig,
  MemoryServiceCommand,
  MemoryServiceMessage,
} from "../../shared/memory.ts";
import type { MemoryVectorsSummary } from "../../shared/memory.ts";

/** host 对「子进程」的全部要求——Electron 的 UtilityProcess 结构上满足，测试用脚本假货顶上。 */
export interface MemoryChild {
  on(event: "message", listener: (message: MemoryServiceMessage) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: MemoryServiceCommand): unknown;
  kill(): unknown;
}

export interface MemoryServiceHostOptions {
  forkRuntime: () => MemoryChild;
  /** init 要送的数据目录（<userData>/memory） */
  dir: string;
  /** 召回转发的硬超时；超时回空命中。agent 侧还有一层自己的超时 */
  recallTimeoutMs?: number;
  /** 记忆库写操作的硬超时（按 token 互斥下通常毫秒级；宽跟 15 秒兑极端） */
  mutateTimeoutMs?: number;
  /** 服务侧任何写盘后回调一次（index.ts 里接 broadcastAgentEvent） */
  onChanged?: () => void;
  /** 模型下载进度（index.ts 里接 agent:event 的 vectorDownload） */
  onDownloadProgress?: (progress: MemoryDownloadProgress) => void;
  /** 后台补算进度（index.ts 里接 agent:event 的 vectorBackfill） */
  onBackfillProgress?: (progress: MemoryBackfillProgress) => void;
  /** vectorState 问答的硬超时（服务不在 / 卡住回 null，状态页如实显示） */
  vectorStateTimeoutMs?: number;
  log?: (message: string, ...args: unknown[]) => void;
  /** 按 pid 杀 llama-server（host.ts 注入 process.kill；已退出的 pid 由实现吞掉） */
  killPid?: (pid: number) => void;
}

/** 主进程 → 服务的一次轮后事件（主进程已做完根会话 / 快照截断的判定）。 */
export interface MemoryTurnPayload {
  sessionId: string;
  scopeId: string;
  turn: number;
  at: number;
  userText: string;
  assistantText: string;
  chore?: MemoryChoreModel;
}

const DEFAULT_RECALL_TIMEOUT_MS = 4_000;
const DEFAULT_MUTATE_TIMEOUT_MS = 15_000;

/** vectorState 的回执形状（服务消息的载荷部分）。 */
export interface VectorStateReply {
  llamaRunning: boolean;
  backfill: { state: "running" | "deferred-battery"; done: number; total: number } | null;
  vectors: MemoryVectorsSummary | null;
}

interface PendingRecall {
  resolve: (hits: MemoryHit[]) => void;
  timer: NodeJS.Timeout;
}

export class MemoryServiceHostCore {
  private readonly forkRuntime: () => MemoryChild;
  private readonly dir: string;
  private readonly recallTimeoutMs: number;
  private readonly mutateTimeoutMs: number;
  private readonly onChanged: () => void;
  private readonly onDownloadProgress: (progress: MemoryDownloadProgress) => void;
  private readonly onBackfillProgress: (progress: MemoryBackfillProgress) => void;
  private readonly vectorStateTimeoutMs: number;
  private readonly log: (message: string, ...args: unknown[]) => void;
  private readonly killPid: (pid: number) => void;
  private child: MemoryChild | null = null;
  /** 当前服务报来的 llama-server pid（没在跑 = null） */
  private embedPid: number | null = null;
  /** init 失败的原因；非 null 时 ensureStarted 不再拉起 */
  private initFailure: string | null = null;
  private ready: Promise<boolean> | null = null;
  private chore: MemoryChoreModel | undefined;
  private readonly pending = new Map<string, PendingRecall>();
  private readonly pendingMutates = new Map<
    string,
    { resolve: (outcome: MemoryMutationOutcome) => void; timer: NodeJS.Timeout }
  >();
  private readonly pendingVectorStates = new Map<
    string,
    { resolve: (state: VectorStateReply | null) => void; timer: NodeJS.Timeout }
  >();
  private seq = 0;

  constructor(options: MemoryServiceHostOptions) {
    this.forkRuntime = options.forkRuntime;
    this.dir = options.dir;
    this.recallTimeoutMs = options.recallTimeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;
    this.mutateTimeoutMs = options.mutateTimeoutMs ?? DEFAULT_MUTATE_TIMEOUT_MS;
    this.onChanged = options.onChanged ?? (() => undefined);
    this.onDownloadProgress = options.onDownloadProgress ?? (() => undefined);
    this.onBackfillProgress = options.onBackfillProgress ?? (() => undefined);
    this.vectorStateTimeoutMs = options.vectorStateTimeoutMs ?? 2_000;
    this.log = options.log ?? ((message, ...args) => console.log(message, ...args));
    this.killPid = options.killPid ?? (() => undefined);
  }

  /** 拉起（或已在跑时直接用）。false = 这次没拉起来（fork 失败 / ready 超时 /
   * 上次 init 失败还没被 stop 清掉）。 */
  ensureStarted(): Promise<boolean> {
    if (this.initFailure !== null) return Promise.resolve(false);
    if (this.child !== null) return this.ready ?? Promise.resolve(true);
    this.ready = new Promise<boolean>((resolve) => {
      let child: MemoryChild;
      try {
        child = this.forkRuntime();
      } catch (cause) {
        this.log("[memory] 记忆服务进程 fork 失败", cause);
        this.child = null;
        this.ready = null;
        resolve(false);
        return;
      }
      this.child = child;
      // ready 90 秒不出 = 这次启动失败，回收状态（下次调用重试）
      const giveUp = setTimeout(() => {
        if (this.child === child) this.dropChild("ready 超时");
        resolve(false);
      }, 90_000);
      giveUp.unref?.();
      child.on("message", (message) => {
        if (message.type === "ready") {
          clearTimeout(giveUp);
          child.postMessage({
            type: "init",
            dir: this.dir,
            ...(this.chore !== undefined ? { chore: this.chore } : {}),
          });
          resolve(true);
          return;
        }
        if (message.type === "recallResult") {
          const pending = this.pending.get(message.requestId);
          if (pending === undefined) return; // 超时后到的回执：丢弃
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
          pending.resolve(message.hits);
        }
        if (message.type === "mutateResult") {
          const pending = this.pendingMutates.get(message.requestId);
          if (pending === undefined) return; // 超时后到的回执：丢弃
          clearTimeout(pending.timer);
          this.pendingMutates.delete(message.requestId);
          if (message.ok) {
            pending.resolve({ ok: true, entry: message.entry });
          } else {
            pending.resolve({ ok: false, error: message.error });
          }
        }
        if (message.type === "vectorStateResult") {
          const pending = this.pendingVectorStates.get(message.requestId);
          if (pending === undefined) return;
          clearTimeout(pending.timer);
          this.pendingVectorStates.delete(message.requestId);
          pending.resolve({
            llamaRunning: message.llamaRunning,
            backfill: message.backfill,
            vectors: message.vectors,
          });
        }
        if (message.type === "downloadProgress") {
          this.onDownloadProgress(message.progress);
        }
        if (message.type === "backfillProgress") {
          this.onBackfillProgress(message.progress);
        }
        if (message.type === "changed") {
          this.onChanged();
        }
        // 下面两条只认当前这个子进程（被换掉的旧进程晚到的消息不能改状态）
        if (message.type === "embedServerPid" && this.child === child) {
          this.embedPid = message.pid;
        }
        if (message.type === "initFailed" && this.child === child) {
          this.initFailure = message.error;
          this.dropChild(`init 失败：${message.error}；关掉再打开实验开关后重试`);
        }
      });
      child.on("exit", () => {
        if (this.child === child) this.dropChild("进程退出", false);
      });
    });
    return this.ready;
  }

  /** 当前装配好的家务活模型（主进程每轮现读设置后更新；init 与 turnSettled 都带上）。 */
  setChore(chore: MemoryChoreModel | undefined): void {
    this.chore = chore;
  }

  /** 停进程（开关关 / 应用退出）。在途召回全部回空命中。killIt = false 用于
   * 子进程自己退出的路径（已经死了，不补刀）。主动停服务同时清掉 init 失败的
   * 记忆：开关关了再开 = 用户要重试。 */
  stop(killIt = true): void {
    if (killIt) this.initFailure = null;
    this.dropChild(killIt ? "主进程停服务" : "进程退出", killIt);
  }

  /** 服务在不在（不在时主进程直接给召回回空命中，不等超时）。 */
  isRunning(): boolean {
    return this.child !== null;
  }

  /**
   * 轮后事件转发。服务不在就丢——构建是易耗品，这一轮没有就没有了；
   * （实验开关开着时服务应该已在跑；这里只是崩溃窗口的兜底。）
   */
  turnSettled(payload: MemoryTurnPayload): void {
    if (this.child === null) return;
    this.child.postMessage({
      type: "turnSettled",
      ...payload,
      ...(payload.chore !== undefined ? { chore: payload.chore } : {}),
    });
  }

  /**
   * 召回转发：服务不在 / 转发超时 / 子进程退出 → 空命中。**任何情况都 resolve
   * 空数组而不是 reject**——调用方（主进程的 onEvent）在 agent 的轮回执路径上，
   * 记忆的失败不该变成对话的失败。
   */
  recall(input: {
    sessionId: string;
    scopeId: string;
    turn: number;
    query: string;
  }): Promise<MemoryHit[]> {
    if (this.child === null) return Promise.resolve([]);
    const requestId = `${this.seq += 1}:${randomUUID()}`;
    return new Promise<MemoryHit[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve([]);
      }, this.recallTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, timer });
      this.child?.postMessage({ type: "recall", requestId, ...input });
    });
  }

  /** 向量配置下发（设置变了 / 下载完成 / 服务拉起后同步）。服务不在就丢——
   * 服务下一次拉起时 init 后主进程会再同步一次（见 index.ts 的 syncVectorConfig）。 */
  setVectorConfig(config: MemoryVectorServiceConfig | null): void {
    this.child?.postMessage({ type: "setVectorConfig", config });
  }

  /** 电池状态转发（powerMonitor 在主进程）。 */
  setPower(onBattery: boolean): void {
    this.child?.postMessage({ type: "setPower", onBattery });
  }

  /** 服务运行态问答；不在 / 超时回 null（状态页如实显示）。 */
  vectorState(): Promise<VectorStateReply | null> {
    if (this.child === null) return Promise.resolve(null);
    const requestId = `${this.seq += 1}:${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingVectorStates.delete(requestId);
        resolve(null);
      }, this.vectorStateTimeoutMs);
      timer.unref?.();
      this.pendingVectorStates.set(requestId, { resolve, timer });
      this.child?.postMessage({ type: "vectorState", requestId });
    });
  }

  /** 模型下载触发（进度走 onDownloadProgress）。 */
  startModelDownload(input: {
    sources: readonly string[];
    targetPath: string;
    sha256: string;
    sizeBytes: number;
  }): void {
    this.child?.postMessage({ type: "startModelDownload", requestId: randomUUID(), ...input });
  }

  /**
   * 转发记忆库写操作（服务是唯一写者）。服务不在 / 超时 / 崩溃 → ok:false；
   * 调用方（IPC handler）把 error 原样给 renderer。
   */
  mutate(mutation: MemoryMutation): Promise<MemoryMutationOutcome> {
    if (this.child === null) {
      return Promise.resolve({
        ok: false,
        error:
          this.initFailure !== null
            ? `记忆服务初始化失败：${this.initFailure}（关掉再打开记忆实验开关重试）`
            : "记忆服务没在跑（先拉起或稍后再试）",
      });
    }
    const requestId = `${this.seq += 1}:${randomUUID()}`;
    return new Promise<MemoryMutationOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingMutates.delete(requestId);
        resolve({ ok: false, error: "记忆服务没在限定时间内回执（可能正在整理，稍后再试）" });
      }, this.mutateTimeoutMs);
      timer.unref?.();
      this.pendingMutates.set(requestId, { resolve, timer });
      this.child?.postMessage({ type: "mutate", requestId, mutation });
    });
  }

  private dropChild(reason: string, killIt = true): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    this.pending.clear();
    for (const [, pending] of this.pendingMutates) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "记忆服务停了" });
    }
    this.pendingMutates.clear();
    for (const [, pending] of this.pendingVectorStates) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    this.pendingVectorStates.clear();
    // llama-server 补杀：不论服务是被停还是自己死的，它的子进程都不会跟着走
    const embedPid = this.embedPid;
    this.embedPid = null;
    if (child !== null && killIt) {
      try {
        child.postMessage({ type: "shutdown" });
      } catch {
        // 通道已断：下面的按 pid 补杀兜住
      }
    }
    if (embedPid !== null) {
      try {
        this.killPid(embedPid);
      } catch (cause) {
        this.log("[memory] 按 pid 补杀 llama-server 失败", embedPid, cause);
      }
    }
    if (child !== null) {
      this.log(`[memory] 记忆服务停了（${reason}）；在途召回已回空命中`);
      if (!killIt) return;
      try {
        child.kill();
      } catch {
        // 已经死了：kill 再抛就随它去
      }
    }
  }
}
