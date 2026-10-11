/**
 * TerminalService —— 主进程侧的终端管家：持有全部终端的现状与快照重放缓冲，
 * 管与 terminal utility 进程的 MessagePort 连接。PTY 本体与输出批处理在 runtime；
 * renderer 可以随时整页刷新，这里的缓冲保证重挂载后先画历史再接续事件流。
 *
 * 生命周期裁决（设计共识）：收起面板 / 切面板 / 切 tab 都**不杀** PTY——PTY 与
 * 缓冲活在这里，renderer 的 xterm 实例只是视图；关 tab（kill）才杀；应用退出
 * （dispose）全杀。
 */
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from "electron";
import { join } from "node:path";
import {
  appendReplay,
  isTerminalId,
  TERMINAL_INPUT_LIMIT,
  terminalChannels,
  type TerminalCreateRequest,
  type TerminalEvent,
  type TerminalInfo,
  type TerminalOutputEvent,
  type TerminalSnapshot,
} from "../../shared/terminal.ts";
import type { TerminalRuntimeMessage, TerminalRuntimeRequest } from "../../shared/terminal-runtime.ts";
import { resolveTerminalCwd } from "../../terminal/env.ts";
import { pathTail } from "../../shared/path.ts";
import { mainWindows } from "../window/main-windows.ts";

/** 每终端快照重放缓冲的容量（字符数）。尾留 1MB，与输出管线的积压上限同量级 */
export const REPLAY_BUFFER_LIMIT = 1024 * 1024;

/** 开一个终端的等待上限：shell 探测 + PTY spawn 正常在毫秒级，10s 还没回就是挂了 */
const CREATE_TIMEOUT_MS = 10_000;

/** runtime 启动握手的等待上限 */
const STARTUP_TIMEOUT_MS = 10_000;

/** Windows 上 utilityProcess.fork 同步抛 ENOTCONN 时的一次重试间隔（Electron 老毛病，调研 1.2 节） */
const FORK_RETRY_DELAY_MS = 150;

/** 应用退出时给 runtime 留的收尾窗口：taskkill 是异步的，掐太早会留孤儿进程树 */
const DISPOSE_GRACE_MS = 600;

interface PendingCreate {
  promise: Promise<TerminalInfo>;
  resolve: (info: TerminalInfo) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TerminalService {
  private runtimeProcess: UtilityProcess | null = null;
  private port: MessagePortMain | null = null;
  private starting: Promise<void> | null = null;
  /** 连接代际：runtime 挂掉重连后，旧握手里的迟到回调靠它自认过期 */
  private generation = 0;
  /** 现状（含已退出的），创建顺序即 Map 迭代顺序——面板的 tab 顺序 */
  private readonly terminals = new Map<string, TerminalInfo>();
  private readonly buffers = new Map<string, { output: string; sequence: number }>();
  private readonly pendingCreates = new Map<string, PendingCreate>();
  /** 创建途中被 kill 的 id：created 回来后补杀，防泄漏（Proma 的同款竞态修复） */
  private readonly cancelledCreates = new Set<string>();

  /**
   * 开一个终端。幂等：id 已知直接回现状。cwd 只是意愿（失效回退 homedir）；
   * shell 由 runtime 探测。title 按解析后的 cwd 末段铸（tab 上显示的文件夹名）。
   */
  create(request: TerminalCreateRequest): Promise<TerminalInfo> {
    if (!isTerminalId(request.terminalId)) throw new Error(`终端 id 不合法：${String(request.terminalId)}`);
    const existing = this.terminals.get(request.terminalId);
    if (existing !== undefined) return Promise.resolve(existing);
    // 并发 create 同一 id（手快双击）共享同一个 promise
    const inFlight = this.pendingCreates.get(request.terminalId);
    if (inFlight !== undefined) return inFlight.promise;
    return this.startCreate(request);
  }

  private async startCreate(request: TerminalCreateRequest): Promise<TerminalInfo> {
    await this.ensureRuntime();
    // ensureRuntime 期间 kill 已经到过：不再创建（created 回执里的补杀兜同一意图）
    if (this.cancelledCreates.has(request.terminalId)) throw new Error("终端已在启动完成前关闭");
    const terminalId = request.terminalId;
    const cwd = resolveTerminalCwd(request.cwd);
    // 缓冲先于 create 落位：runtime 的第一声输出不能因为缓冲未建而被丢
    this.buffers.set(terminalId, { output: "", sequence: 0 });
    let resolvePromise!: (info: TerminalInfo) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<TerminalInfo>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      const pending = this.pendingCreates.get(terminalId);
      if (pending !== undefined) {
        this.pendingCreates.delete(terminalId);
        pending.reject(new Error("终端启动超时"));
      }
    }, CREATE_TIMEOUT_MS);
    this.pendingCreates.set(terminalId, {
      promise,
      resolve: (info) => resolvePromise(info),
      reject: (error) => {
        this.buffers.delete(terminalId);
        rejectPromise(error);
      },
      timer,
    });
    this.post({ type: "create", terminalId, cols: request.cols, rows: request.rows, cwd });
    return promise;
  }

  /** 现存终端清单（创建顺序）。renderer 重挂载 / 整页刷新后照它收养孤儿 tab */
  list(): TerminalInfo[] {
    return [...this.terminals.values()];
  }

  /** 快照重放材料。终端不存在（tab 已关）时明确报错——renderer 拿空快照没有意义 */
  snapshot(terminalId: string): TerminalSnapshot {
    if (!isTerminalId(terminalId)) throw new Error(`终端 id 不合法：${String(terminalId)}`);
    const buffer = this.buffers.get(terminalId);
    if (buffer === undefined) throw new Error(`终端不存在：${terminalId}`);
    return { terminalId, output: buffer.output, sequence: buffer.sequence };
  }

  /** 键入（用户敲的字符，含控制字符，原样透传） */
  input(terminalId: string, data: string): void {
    if (!isTerminalId(terminalId)) throw new Error(`终端 id 不合法：${String(terminalId)}`);
    if (typeof data !== "string" || data.length === 0) return;
    if (data.length > TERMINAL_INPUT_LIMIT) throw new Error("终端输入过长");
    if (!this.terminals.has(terminalId)) throw new Error(`终端不存在：${terminalId}`);
    this.post({ type: "input", terminalId, data });
  }

  /** 行列变化。终端已不存在就当作没听见（tab 刚关、ResizeObserver 迟到一拍的竞态） */
  resize(terminalId: string, cols: number, rows: number): void {
    if (!isTerminalId(terminalId)) throw new Error(`终端 id 不合法：${String(terminalId)}`);
    if (!this.terminals.has(terminalId)) return;
    this.post({ type: "resize", terminalId, cols, rows });
  }

  /** 一批输出画完了（背压放行下一批）。序号语义由 runtime 的管线裁决，这里只转发 */
  acknowledge(terminalId: string, sequence: number): void {
    if (!isTerminalId(terminalId)) throw new Error(`终端 id 不合法：${String(terminalId)}`);
    if (typeof sequence !== "number" || !Number.isFinite(sequence) || sequence < 0) return;
    this.post({ type: "ack", terminalId, sequence });
  }

  /** 关 tab：杀 PTY（runtime 侧 Windows 杀进程树）并丢弃缓冲。对已退出 / 不存在的 id 静默 */
  kill(terminalId: string): void {
    if (!isTerminalId(terminalId)) throw new Error(`终端 id 不合法：${String(terminalId)}`);
    // 创建还在途：记下来，created 回来后补杀（startCreate 的守卫兜同一意图）
    if (this.pendingCreates.has(terminalId)) this.cancelledCreates.add(terminalId);
    this.terminals.delete(terminalId);
    this.buffers.delete(terminalId);
    this.post({ type: "kill", terminalId });
  }

  /**
   * 应用退出：让 runtime 把全部 PTY 杀干净（Windows 上是逐个 taskkill 进程树），
   * 再收掉进程。不等待——taskkill 是异步的，退出路径上阻塞它反而拖慢关窗。
   */
  dispose(): void {
    this.generation += 1;
    const port = this.port;
    const runtimeProcess = this.runtimeProcess;
    this.port = null;
    this.runtimeProcess = null;
    this.starting = null;
    for (const pending of this.pendingCreates.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("应用正在退出"));
    }
    this.pendingCreates.clear();
    if (port !== null) {
      port.postMessage({ type: "shutdown" } satisfies TerminalRuntimeRequest);
      // close 不能紧跟 postMessage：会把还没排空的消息掐死。宽限窗结束时一并收
      setTimeout(() => {
        try {
          port.close();
        } catch {
          // 已随进程退出
        }
      }, DISPOSE_GRACE_MS);
    }
    if (runtimeProcess !== null) {
      setTimeout(() => {
        try {
          runtimeProcess.kill();
        } catch {
          // 已在退出，无事可做
        }
      }, DISPOSE_GRACE_MS);
    }
  }

  // ------------------------------------------------------------------
  // 连接管理
  // ------------------------------------------------------------------

  private async ensureRuntime(): Promise<void> {
    if (this.port !== null) return;
    if (this.starting !== null) return this.starting;
    const starting = this.startRuntime(++this.generation);
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startRuntime(generation: number): Promise<void> {
    const runtimeProcess = await forkTerminalRuntime(resolveTerminalRuntimePath(__dirname));
    // 先登记再判代际：等创建期间又来了一轮启动（dispose / 重连），这一轮就作废——
    // 拿还没登记的进程比 current 会永远不等，把正常启动全判成「已取消」
    this.runtimeProcess = runtimeProcess;
    if (generation !== this.generation) {
      try {
        runtimeProcess.kill();
      } catch {
        // 代际已过期，进程另有人管
      }
      throw new Error("终端运行时启动已取消");
    }
    runtimeProcess.on("exit", () => {
      if (this.runtimeProcess !== runtimeProcess) return;
      // runtime 死了：全部 PTY 随它而去（exit code 未知，如实标 -1）。
      // 缓冲留着——用户切回面板还能看到死前的输出与退场提示
      this.port = null;
      this.runtimeProcess = null;
      for (const pending of this.pendingCreates.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("终端运行时已退出"));
      }
      this.pendingCreates.clear();
      for (const [terminalId, info] of this.terminals) {
        if (info.exited === null) {
          this.terminals.set(terminalId, { ...info, exited: -1 });
          this.broadcast({ type: "exit", terminalId, exitCode: -1 });
        }
      }
    });

    await new Promise<void>((resolve, reject) => {
      const channel = new MessageChannelMain();
      const port = channel.port2;
      const timeout = setTimeout(() => reject(new Error("终端运行时启动超时")), STARTUP_TIMEOUT_MS);
      const isCurrentPort = (): boolean => generation === this.generation && this.port === port;
      port.on("message", (event) => {
        const message = event.data as TerminalRuntimeMessage;
        if (message.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
        if (isCurrentPort()) this.handleRuntimeMessage(message);
      });
      port.start();
      this.port = port;
      // port1 移交出去；本进程这边只留 port2
      runtimeProcess.postMessage({ type: "orbita-terminal-port" }, [channel.port1]);
    });
  }

  private handleRuntimeMessage(message: TerminalRuntimeMessage): void {
    switch (message.type) {
      case "ready":
        return; // 握手在 startRuntime 里已消费
      case "created": {
        const pending = this.pendingCreates.get(message.terminalId);
        if (pending === undefined) return;
        this.pendingCreates.delete(message.terminalId);
        clearTimeout(pending.timer);
        if (this.cancelledCreates.delete(message.terminalId)) {
          // tab 在创建完成前被关了：补杀，不让刚出生的 PTY 变孤儿
          this.buffers.delete(message.terminalId);
          this.post({ type: "kill", terminalId: message.terminalId });
          pending.reject(new Error("终端已在启动完成前关闭"));
          return;
        }
        const tail = pathTail(message.cwd);
        const info: TerminalInfo = {
          terminalId: message.terminalId,
          title: tail === "" ? message.cwd : tail,
          shell: message.shell,
          cwd: message.cwd,
          pid: message.pid,
          exited: null,
        };
        this.terminals.set(message.terminalId, info);
        pending.resolve(info);
        return;
      }
      case "output":
        this.appendReplayBuffer(message.event);
        this.broadcast({ type: "output", event: message.event });
        return;
      case "exit": {
        const info = this.terminals.get(message.terminalId);
        if (info !== undefined) this.terminals.set(message.terminalId, { ...info, exited: message.exitCode });
        this.broadcast({ type: "exit", terminalId: message.terminalId, exitCode: message.exitCode });
        return;
      }
      case "error": {
        const pending = this.pendingCreates.get(message.terminalId);
        if (pending === undefined) return;
        this.pendingCreates.delete(message.terminalId);
        clearTimeout(pending.timer);
        pending.reject(new Error(message.message));
        return;
      }
      case "stopped":
        return; // dispose 路径自会收进程
    }
  }

  private appendReplayBuffer(event: TerminalOutputEvent): void {
    // 不认识的 id（创建失败后的残响、kill 后的迟到批）直接丢
    const buffer = this.buffers.get(event.terminalId);
    if (buffer === undefined) return;
    this.buffers.set(event.terminalId, appendReplay(buffer, event, REPLAY_BUFFER_LIMIT));
  }

  private post(request: TerminalRuntimeRequest): void {
    // port 没起来时只有 kill 可能到达（面板在 runtime 启动完成前关 tab）；
    // cancelledCreates 已记录这个意图，请求本身丢弃即可
    this.port?.postMessage(request);
  }

  private broadcast(event: TerminalEvent): void {
    for (const window of mainWindows.list()) {
      window.webContents.send(terminalChannels.event, event);
    }
  }
}

/**
 * Windows 上 `utilityProcess.fork` 会同步抛 ENOTCONN（Electron 的老毛病，调研 1.2 节）。
 * 冷却后重试一次，两次都挂才把错误交出去。
 */
async function forkTerminalRuntime(entryPath: string): Promise<UtilityProcess> {
  const fork = (): UtilityProcess =>
    utilityProcess.fork(entryPath, [], { serviceName: "Orbita Terminal Runtime", stdio: "inherit" });
  try {
    return fork();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, FORK_RETRY_DELAY_MS));
    return fork();
  }
}

/** 打包产物里 runtime 与主进程同目录（electron.vite.config 的 main 多入口，agent-runtime 同款） */
export function resolveTerminalRuntimePath(dirname: string): string {
  return join(dirname, "terminal-runtime.js");
}
