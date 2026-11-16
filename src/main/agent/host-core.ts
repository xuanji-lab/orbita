/**
 * AgentHost 的全部逻辑 —— **纯模块**：不 import electron，可被 `node --test` 直接测
 * （recorder.ts 同款先例）。真的 fork 在 `host.ts` 那层注入。
 *
 * 只做三件事：懒启动进程、把命令发进去、把事件广播给窗口。业务判断全在两端，不在这里。
 *
 * 两个子进程：
 * - kernel 进程（kernel-runtime.ts）：对话主循环——开轮 / 停止 / 抢跑 / 压缩 / 插话 / 换模型 / 标题、工具请求、
 *   住在新内核里的会话的本子编辑与分支；
 * - agent 进程（runtime.ts）：不跑轮的家务——内建型号目录与联网刷新、连接测试、专注小结、收尾清单、还没迁的旧会话的
 *   pi 本子编辑与分支、没交给过 kernel 的会话换模型时的校验、MCP 热重载的回执。
 */
import type {
  AgentCommand,
  AgentEvent,
  AgentHouseholdCommand,
  BuiltinProvider,
  ChannelSendOutcome,
  DelegateOutcome,
  ModelCostsOutcome,
  ReadTaskOutcome,
} from "../../shared/agent-ipc.ts";
import type { ChannelDelivery } from "../../shared/channel.ts";
import type { KernelCommand, KernelContinueCommand, KernelMessage, KernelReplyCommand, KernelSessionCommand, KernelTurnResult } from "../../shared/kernel.ts";
import type { McpStatus } from "../../shared/mcp.ts";
import type { AutomationToolOutcome } from "../../shared/automation.ts";
import type { BrowserToolOutcome } from "../../shared/browser.ts";
import type { DocOutcome } from "../../shared/doc.ts";
import type { TerminalToolOutcome } from "../../shared/terminal.ts";
import type { SlidesOutcome } from "../../shared/slides-export.ts";
import type { IntentConfirmDecision } from "../../shared/intent-confirm.ts";
import type { PluginAgentInstallOutcome, PluginAgentListOutcome, PluginAgentPreviewOutcome } from "../../shared/plugin.ts";
import type { PluginBoardOutcome } from "../../shared/plugin-board.ts";
import type { MemoryAgentOutcome, MemoryRecallOutcome } from "../../shared/memory.ts";

/** host 对 agent 进程（家务）的全部要求——Electron 的 UtilityProcess 结构上满足，测试用脚本假货顶上。 */
export interface AgentChild {
  on(event: "message", listener: (message: AgentEvent) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: AgentHouseholdCommand): unknown;
  kill(): unknown;
}

/** 新内核的 kernel 进程：Electron 的 UtilityProcess 结构上满足（同 AgentChild），测试用脚本假货顶上 */
export interface KernelChild {
  on(event: "message", listener: (message: KernelMessage) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: KernelCommand): unknown;
  kill(): unknown;
}

/** 插话没送进去时的那句话（与删掉的旧内核主循环同一句） */
const STEER_MISSED_MESSAGE = "steer 到达时这一轮已结束（或刚开机还没接上），注入没送进去——请重发";

/** 开轮交给新内核时带上这棵会话树的根（决定用哪个库：子会话与父同库）；这一轮要迁的旧本子多大 */
export type KernelTurnRoute = { to: "kernel"; root: string; migrateBytes?: number };

/** 本子编辑交给谁：住在新内核里的会话 → kernel（带树根），还没迁的旧会话 → agent 进程改 pi 本子 */
export type KernelRoute = { to: "kernel"; root: string } | { to: "legacy" };

/** 这一轮要迁的旧本子有多大时，发送那一刻就说「正在迁移」（小的迁得快，不说） */
export const MIGRATION_HINT_BYTES = 16 * 1024 * 1024;

/**
 * 新内核那条道（主进程给）。
 * - fork / dir：拉起 kernel 进程、它的库目录；
 * - route：开轮命令交给 kernel（带树根；不能续的抛错），会话记上「住在新内核」；
 * - editRoute：本子编辑类操作（回退 / 撤销 / 分支的源 / 挪工作区）去哪：住在新内核里的会话 → kernel，其余（还没迁的旧会话）agent 进程改 pi 本子；不能编辑的抛错；
 * - settled：kernel 报一轮落定（清「在跑」标记、记迁移失败）；
 * - exited：kernel 进程意外退出（清孤儿 shell 进程）。running = 退出时还在跑的会话。
 */
export interface KernelLane {
  fork: () => KernelChild;
  dir: string;
  route: (command: { sessionId: string; type: string }) => Promise<KernelTurnRoute>;
  editRoute: (sessionId: string) => Promise<KernelRoute>;
  settled: (sessionId: string, result: KernelTurnResult) => void;
  exited: (running: readonly string[]) => void;
  /**
   * kernel 进程闲置多久回收（毫秒；缺席 = 不回收）。闲置 = 没有在跑的轮、没有等回执的工具请求、没有在途的
   * 编辑 / 删库 / 收尾。回收 = 先让它关库（含按墓碑清行）再结束进程；下一条命令再懒拉起。
   */
  idleRecycleMs?: number;
}

/** 已添加的服务商用到哪几份目录（主进程从 providers.json 算，catalogIdsOfProviders） */
export type CatalogScope = () => Promise<readonly string[]>;

export class AgentHostCore {
  private readonly forkRuntime: () => AgentChild;
  private readonly onEvent: (event: AgentEvent) => void;
  private readonly catalogScope: CatalogScope | undefined;
  private child: AgentChild | null = null;
  private ready: Promise<void> | null = null;
  /** pi 报上来的内建目录。runtime 是**先发 ready 再异步建目录**，所以不能只等 ready
   *  就返回缓存——那一刻缓存必然是空的（下拉框不出现就是这个竞态）。 */
  private builtins: BuiltinProvider[] = [];
  private resolveBuiltins: ((providers: BuiltinProvider[]) => void) | null = null;
  private builtinsArrived: Promise<BuiltinProvider[]> | null = null;
  /**
   * 正在等待 `created` 的命令（submit / interrupt / compact 的首轮开机、branch）。
   * 每轮开机都会发 `created`：等待者拿到本子引用；
   * 没人等的（续轮）交 onEvent 转发，主进程用它把真值校准回 meta（自愈）。
   */
  private readonly pendingCreates = new Map<
    string,
    { resolve: (piSessionFile: string | null) => void; reject: (error: Error) => void }
  >();
  /**
   * 在等的 mcpReload 回执（1-1 热重载）：runtime 重连完会发一条 `mcp` 快照事件，
   * 用它把 invoke 的 promise 结掉——reload 是显式动作，调用方等着拿结果。
   * **在飞的只有一份，并发调用共享它**：单槽时代第二次调用会把前一个等待者顶掉，
   * 被顶的 promise 永远不了结（面板点快了就冻结，2026-10-06 实测）。reset 不读配置
   * （配置随开轮现送），两次连续 reload 语义相同，共享不丢东西。
   * 进程退出要 reject：那之后状态未知，不能装作重载成功。
   */
  private mcpReloadInFlight: Promise<void> | null = null;
  private settleMcpReload: { resolve: () => void; reject: (error: Error) => void } | null = null;
  /**
   * 在等的 pi 本子编辑回执（会话回退 / 单轮撤销）：runtime 裁完发 `piBookEdited`，
   * 失败走 `failed`。按 sessionId 一条——同一会话的回退 / 撤销不可能并发。
   */
  private readonly pendingPiEdits = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  /** 在等的 probeProvider 回执（Test 的 OAuth 路由），按 requestId；进程退出全部 reject */
  private readonly pendingProbes = new Map<
    string,
    { resolve: (result: { ok: boolean; message: string }) => void; reject: (error: Error) => void }
  >();
  private probeSeq = 0;
  /** 在等的 summarizeFocus 回执（专注收工小结），按 requestId；进程退出全部 reject */
  private readonly pendingFocusSummaries = new Map<
    string,
    { resolve: (bullets: string[]) => void; reject: (error: Error) => void }
  >();
  private focusSummarySeq = 0;

  /**
   * catalogScope 缺席 = 不送目录刷新范围，agent 进程就一份目录也不联网（测试与裸跑）。
   */
  /** 新内核那条道 */
  private readonly kernel: KernelLane;
  private kernelChild: KernelChild | null = null;
  /** 闲置回收的计时器（每次与 kernel 往来都重新计时） */
  private kernelIdleTimer: ReturnType<typeof setTimeout> | null = null;
  /** 正在回收的旧 kernel 进程（关库、退出）：新命令等它退干净再拉新的——一个库同一时刻只能有一个写者 */
  private kernelRecycling: Promise<void> | null = null;
  private kernelRecycled: (() => void) | null = null;
  private kernelReady: Promise<void> | null = null;
  /** 这次运行里交给过 kernel 的会话 → 它的树根（停止 / 插话 / 标题跟着它们走） */
  private readonly kernelSessions = new Map<string, string>();
  /** 插话退回时的去处（index.ts 接到通道的「子空闲时的投递」） */
  private steerBounced: ((sessionId: string, text: string, delivery: "steer" | "followUp") => void) | null = null;
  /** 交给 kernel 还没回执的本子编辑 / 分支（会话 id；kernel 进程退出时要把等待者结掉） */
  private readonly kernelEdits = new Set<string>();
  /**
   * 这一轮由新内核建出来的全新会话（开轮命令没带本子）：标题只给它们起，起一次就划掉。与旧内核实际的门一致——旧内核只在
   * 「主进程等过 created」的那一轮（全新会话的首轮）开好之后才收到标题命令，别的轮（含分支会话的第一句）命令到时
   * 那一轮还在开，runtime 跳过；新内核开得快，不在这里拦就会给分支会话也起标题（第四步验收组 6）。
   */
  private readonly kernelTitleOnce = new Set<string>();
  /** 发送时事先报了「正在迁移」的会话：kernel 开完它（created）或这一轮落定时补一个 done */
  private readonly expectedMigrations = new Set<string>();
  /** kernel 里一轮没落定的会话（kernel 进程意外退出时它们是「被打断」） */
  private readonly kernelRunning = new Set<string>();
  /** kernel 发出的请求 id（工具请求、意图确认）：回执要回到 kernel 进程 */
  private readonly kernelRequests = new Set<string>();
  private readonly pendingKernel = new Map<string, (error?: string) => void>();
  private kernelSeq = 0;

  constructor(forkRuntime: () => AgentChild, onEvent: (event: AgentEvent) => void, kernel: KernelLane, catalogScope?: CatalogScope) {
    this.forkRuntime = forkRuntime;
    this.onEvent = onEvent;
    this.kernel = kernel;
    this.catalogScope = catalogScope;
  }

  /**
   * 懒启动 kernel 进程（第一次有会话交给新内核时）。事件流与 agent 进程的同形，走同一个 onEvent：
   * 工具请求、转录 progress 的处理一份不改；回执按请求 id 回到发出它的进程（kernelRequests）。
   */
  private ensureKernel(): Promise<void> {
    if (this.kernelReady) return this.kernelReady;
    if (this.kernelRecycling !== null) return this.kernelRecycling.then(() => this.ensureKernel());
    const lane = this.kernel;
    let child: KernelChild;
    try {
      child = lane.fork();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.kernelChild = child;
    this.kernelReady = new Promise<void>((resolve, reject) => {
      child.on("message", (message: KernelMessage) => {
        if (this.kernelChild === child) this.armKernelRecycle();
        if ((message.type === "created" || message.type === "turnSettled") && this.expectedMigrations.delete(message.sessionId)) {
          this.onEvent({ type: "migration", sessionId: message.sessionId, state: "done" });
        }
        if (message.type === "ready") {
          child.postMessage({ type: "init", dir: lane.dir });
          resolve();
          return;
        }
        if (message.type === "turnSettled") {
          this.kernelRunning.delete(message.sessionId);
          lane.settled(message.sessionId, message.result);
          return;
        }
        if (message.type === "dropped") {
          this.pendingKernel.get(message.requestId)?.(message.error);
          this.pendingKernel.delete(message.requestId);
          return;
        }
        if (message.type === "shutdownDone") {
          this.pendingKernel.get(message.requestId)?.();
          this.pendingKernel.delete(message.requestId);
          return;
        }
        if (message.type === "steerBounced") {
          // 插话到达时子刚收尾：交给通道当「子空闲时的投递」开一轮；没人接（测试夹具）就报 failed（消息没送到，要人重发）
          this.bounceSteer(message.sessionId, message.text, message.delivery);
          return;
        }
        // 请求（工具请求带 requestId）：记下来源，回执回 kernel
        if ("requestId" in message && typeof message.requestId === "string") this.kernelRequests.add(message.requestId);
        this.onChildEvent(message);
      });
      child.on("exit", (code) => {
        if (this.kernelChild !== child) {
          // 闲置回收的旧进程退干净了（它闲着：没有在跑的轮、没有等回执的东西）。会话 → 树根的账留着：
          // 下一条命令照样认得这些会话是新内核的，懒拉起新进程
          this.kernelRecycled?.();
          lane.exited([]);
          return;
        }
        this.kernelChild = null;
        this.kernelReady = null;
        if (this.kernelIdleTimer !== null) clearTimeout(this.kernelIdleTimer);
        this.kernelIdleTimer = null;
        const running = [...this.kernelRunning];
        this.kernelRunning.clear();
        this.kernelRequests.clear();
        // 交给它还没回执的本子编辑 / 分支：等待者结掉（不然调用方要等满超时）
        for (const sessionId of this.kernelEdits) {
          this.pendingPiEdits.get(sessionId)?.reject(new Error(`kernel runtime exited with code ${code}`));
          this.pendingPiEdits.delete(sessionId);
          this.pendingCreates.get(sessionId)?.reject(new Error(`kernel runtime exited with code ${code}`));
          this.pendingCreates.delete(sessionId);
        }
        this.kernelEdits.clear();
        for (const resolvePending of this.pendingKernel.values()) resolvePending(`kernel runtime exited with code ${code}`);
        this.pendingKernel.clear();
        const message = `kernel runtime exited with code ${code}`;
        for (const sessionId of running) {
          const pending = this.pendingCreates.get(sessionId);
          if (pending) {
            pending.reject(new Error(message));
            this.pendingCreates.delete(sessionId);
          }
          // 它正在跑的轮被打断了：标在那句话下面、给「继续」，然后让这条会话空闲（不自动续跑）
          this.onEvent({ type: "failed", sessionId, message, turn: true, continuable: true });
          this.onEvent({ type: "phase", sessionId, phase: "idle" });
        }
        lane.exited(running);
        reject(new Error(message));
      });
    });
    return this.kernelReady;
  }

  /**
   * 交给 kernel 的会话命令；root 缺省 = 这次运行里记下的树根（没记过就是它自己）。
   * kernel 进程不在（闲置回收了 / 崩了）时：那条会话一定没有在跑的轮——停止、换模型、标题、释放都没有对象，
   * 不为它们拉起进程；插话没有轮可插，按「插话到达时子刚收尾」退回通道开一轮。
   */
  private postKernel(command: KernelSessionCommand, root?: string): void {
    const child = this.kernelChild;
    if (child === null) {
      if (command.type === "steer" && command.userSteerId !== undefined) this.onEvent({ type: "userSteer", sessionId: command.sessionId, id: command.userSteerId, outcome: "bounced" });
      else if (command.type === "steer") this.bounceSteer(command.sessionId, command.text, command.delivery ?? "steer");
      return;
    }
    this.armKernelRecycle();
    child.postMessage({ type: "session", root: root ?? this.kernelSessions.get(command.sessionId) ?? command.sessionId, command });
  }

  private bounceSteer(sessionId: string, text: string, delivery: "steer" | "followUp"): void {
    if (this.steerBounced !== null) this.steerBounced(sessionId, text, delivery);
    else this.onEvent({ type: "failed", sessionId, message: STEER_MISSED_MESSAGE });
  }

  /** kernel 此刻是不是闲着：没有在跑的轮、没有等回执的工具请求、没有在途的编辑 / 删库 / 收尾 */
  private kernelIdle(): boolean {
    return this.kernelRunning.size === 0 && this.kernelRequests.size === 0 && this.kernelEdits.size === 0 && this.pendingKernel.size === 0;
  }

  /** 与 kernel 每往来一次都重新计时；到点还闲着就回收 */
  private armKernelRecycle(): void {
    const ms = this.kernel.idleRecycleMs;
    if (ms === undefined || this.kernelChild === null) return;
    if (this.kernelIdleTimer !== null) clearTimeout(this.kernelIdleTimer);
    this.kernelIdleTimer = setTimeout(() => this.maybeRecycleKernel(), ms);
    this.kernelIdleTimer.unref?.();
  }

  /**
   * 闲置回收：kernel 进程的常驻内存是 V8 与分配器留下的高水位（迁移 / 读大会话之后不还给系统，第三步验收实测停在 0.8 GB），
   * 进程不在就是 0。先让它关库（库关闭时按墓碑清删除会话的行），再结束进程；回收期间来的命令等它退干净再拉新的。
   */
  private maybeRecycleKernel(): void {
    this.kernelIdleTimer = null;
    const child = this.kernelChild;
    if (child === null) return;
    if (!this.kernelIdle()) {
      this.armKernelRecycle();
      return;
    }
    this.kernelChild = null;
    this.kernelReady = null;
    this.kernelRecycling = (async () => {
      await this.shutdownChild(child, 10_000);
      await new Promise<void>((resolve) => {
        this.kernelRecycled = resolve;
        child.kill();
      });
    })().finally(() => {
      this.kernelRecycling = null;
      this.kernelRecycled = null;
    });
  }

  /**
   * 工具回执 / 意图确认的回答：回到 kernel 进程（这些请求只有它发）。对不上号的（请求早已不在：停止、kernel 退出）丢掉——
   * agent 进程不跑轮，没有在途的请求可结。
   */
  private reply(command: KernelReplyCommand): void {
    if (this.kernelRequests.delete(command.requestId)) this.kernelChild?.postMessage({ type: "reply", command });
  }

  /** 懒启动：第一次真正要用 agent 时才付进程启动的钱。 */
  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    let child: AgentChild;
    try {
      child = this.forkRuntime();
    } catch (error) {
      // Windows 上 utilityProcess.fork 会同步抛 ENOTCONN（terminal/service.ts 同款老毛病）。
      // 这里的关键是不把 rejected promise 存进 ready——存了它就永远返回同一个拒绝，
      // agent 再也起不来，用户只能重启 Orbita。把错误交给这一次的调用方，ready 保持空，
      // 下一次请求自然重新拉起。不做冷却重试：那要把 fork 与事件接线抽成两步改 ensure 的
      // 结构，而「失败一次、下一次请求重试」已够用（ENOTCONN 偶发，代价只是一轮报错）。
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.child = child;
    this.ready = new Promise<void>((resolve, reject) => {
      child.on("message", (message: AgentEvent) => {
        if (message.type === "ready") {
          resolve();
          // 每次拉起（含崩溃后重拉）都送一份全量：agent 进程不记得上一个自己听过什么
          this.syncCatalogScope();
          return;
        }
        this.onChildEvent(message);
      });

      // 进程没了要让上层知道，否则 UI 会永远停在「思考中」
      child.on("exit", (code) => {
        this.child = null;
        this.ready = null;
        this.builtinsArrived = null;
        this.resolveBuiltins = null;
        const message = `agent runtime exited with code ${code}`;
        for (const pending of this.pendingCreates.values()) pending.reject(new Error(message));
        this.pendingCreates.clear();
        for (const pending of this.pendingPiEdits.values()) pending.reject(new Error(message));
        this.pendingPiEdits.clear();
        this.settleMcpReload?.reject(new Error(message));
        this.settleMcpReload = null;
        this.mcpReloadInFlight = null;
        for (const pending of this.pendingProbes.values()) pending.reject(new Error(message));
        this.pendingProbes.clear();
        for (const pending of this.pendingFocusSummaries.values()) pending.reject(new Error(message));
        this.pendingFocusSummaries.clear();
        reject(new Error(message));
        this.onEvent({ type: "failed", sessionId: null, message });
      });
    });
    return this.ready;
  }

  /** 两个子进程共用的事件处理：等待者的回执就地结掉，其余交 onEvent（录盘、广播、工具请求） */
  private onChildEvent(message: AgentEvent): void {
    if (message.type === "builtins") {
      this.builtins = message.providers;
      this.resolveBuiltins?.(message.providers);
      this.resolveBuiltins = null;
      // 也交 onEvent 广播：目录在后台联网刷新完会再报一次（model-catalog.ts），窗口里开着的
      // 菜单 / 设置页要跟着换，不然新型号的名字要用户刷新窗口才出来（2026-10-24 验收发现）
      this.onEvent(message);
      return;
    }
    if (message.type === "mcp") {
      // reload 的回执到了：事件照常往下走（缓存 + 广播），这里只结 promise
      this.settleMcpReload?.resolve();
      this.settleMcpReload = null;
      this.mcpReloadInFlight = null;
    }
    if (message.type === "piBookEdited") {
      // 回退 / 撤销的回执：只结 pending 的 promise，不广播——renderer 不消费它
      this.pendingPiEdits.get(message.sessionId)?.resolve();
      this.pendingPiEdits.delete(message.sessionId);
      return;
    }
    if (message.type === "focusSummarized") {
      // 只结发起方，不广播：窗口不认这个事件
      const pending = this.pendingFocusSummaries.get(message.requestId);
      this.pendingFocusSummaries.delete(message.requestId);
      if (message.bullets === null) pending?.reject(new Error(message.error ?? "the model's reply couldn't be read"));
      else pending?.resolve(message.bullets);
      return;
    }
    if (message.type === "providerProbed") {
      // 同 focusSummarized：只结发起方，不广播
      const pending = this.pendingProbes.get(message.requestId);
      this.pendingProbes.delete(message.requestId);
      pending?.resolve({ ok: message.ok, message: message.message });
      return;
    }
    if (message.type === "created") {
      const pending = this.pendingCreates.get(message.sessionId);
      if (pending) {
        pending.resolve(message.piSessionFile);
        this.pendingCreates.delete(message.sessionId);
        return;
      }
      // 没人等的 created（续轮）：交给主进程钩子把 pi 本子路径校准回 meta。
      // renderer 不消费 created，broadcast 面不必见它。
      this.onEvent(message);
      return;
    }
    if (message.type === "failed" && message.sessionId !== null) {
      const pendingEdit = this.pendingPiEdits.get(message.sessionId);
      if (pendingEdit) {
        this.pendingPiEdits.delete(message.sessionId);
        pendingEdit.reject(new Error(message.message));
      }
      const pending = this.pendingCreates.get(message.sessionId);
      if (pending) {
        // 创建失败要把错误交回调用方，而不是只广播一条事件——
        // 否则 renderer 会拿着一个永远不存在的 sessionId 继续发消息
        pending.reject(new Error(message.message));
        this.pendingCreates.delete(message.sessionId);
        return;
      }
    }
    this.onEvent(message);
  }

  /**
   * 开一轮（submit / interrupt / compact 共用骨架）。
   *
   * `piSessionFile` 缺席（这台会话的第一次开机，或旧会话的 pi 本子曾经缺席）时
   * **等 runtime 回 `created` 才返回**——调用方要拿真文件路径建/校准 meta；
   * 带文件（续跑）时发完即回，返回 null——续轮的 created 交给事件钩子自愈。
   */
  private async postTurn(
    command: Extract<AgentCommand, { type: "submit" | "interrupt" | "compact" }>,
  ): Promise<string | null> {
    // 先问这一轮能不能开（不能续的这里抛错），会话记上「住在新内核」
    const route = await this.kernel.route(command);
    // 事先就知道要迁一条大会话：发送那一刻就报 running（界面立刻说一句），kernel 开完这条会话（created）时补 done
    if ((route.migrateBytes ?? 0) >= MIGRATION_HINT_BYTES) {
      this.expectedMigrations.add(command.sessionId);
      this.onEvent({ type: "migration", sessionId: command.sessionId, state: "running", expected: true });
    }
    return this.postKernelTurn(command, route.root);
  }

  /** 交给 kernel 的开轮（含 continueRun）：与 postTurn 同一个 created 等待规则 */
  private async postKernelTurn(command: Extract<AgentCommand, { type: "submit" | "interrupt" | "compact" }> | KernelContinueCommand, root: string): Promise<string | null> {
    await this.ensureKernel();
    this.kernelSessions.set(command.sessionId, root);
    this.kernelRunning.add(command.sessionId);
    let created: Promise<string | null> | null = null;
    if (command.piSessionFile === undefined) {
      created = this.awaitCreated(command.sessionId, "kernel runtime did not confirm the session in time");
      this.kernelTitleOnce.add(command.sessionId);
    }
    this.postKernel(command);
    return created;
  }

  /**
   * 新内核：父→子插话到达时子刚收尾，kernel 把原文退回来（steerBounced）——由这里接到通道，按「子空闲时的投递」开一轮。
   * 旧内核在这一刻只报 failed（消息留在通道里、没送到模型，要人重发）。
   */
  onSteerBounced(handler: (sessionId: string, text: string, delivery: "steer" | "followUp") => void): void {
    this.steerBounced = handler;
  }

  /** kernel 进程此刻是否在（正常退出要不要先让它收尾） */
  kernelAlive(): boolean {
    return this.kernelChild !== null;
  }

  /** 此刻在新内核里跑着一轮的会话（交给 kernel 之后、turnSettled 之前） */
  kernelRunningSessions(): string[] {
    return [...this.kernelRunning];
  }

  /** 首轮建 meta 时要带的新内核标记：这一轮交给了 kernel 就记（since + running），否则 undefined */
  durableMark(sessionId: string, now: number): { since: number; running: true } | undefined {
    return this.kernelRunning.has(sessionId) ? { since: now, running: true } : undefined;
  }

  /** 新内核：接着跑上次被中断的那一轮（不加新消息）。只有新内核有这件事 */
  async continueRun(command: KernelContinueCommand): Promise<string | null> {
    const route = await this.kernel.route(command);
    return this.postKernelTurn(command, route.root);
  }

  /**
   * 这条会话这次运行里交给过 kernel 没有：交给过的，会话级命令（停止 / 换模型 / 插话 / 标题 / 释放）走 kernel
   * （进程被回收 / 崩了也算——那时它没有在跑的轮，postKernel 不为这些命令拉起进程）。没交给过的此刻一定没有在跑的轮：
   * 停止、标题、释放都没有对象；换模型只做校验并报 model 事件（agent 进程，见 setModel）。
   */
  private ownedByKernel(sessionId: string): boolean {
    return this.kernelSessions.has(sessionId);
  }

  /**
   * pi 侧分支（C-2）：让 runtime 把源 pi 本子裁一份新文件，等 `created` 回来。
   * sessionId 是主进程先生成好的**新会话 id**；调用方拿到文件路径后再把新会话落盘。
   */
  async branchSession(
    input: Omit<Extract<AgentCommand, { type: "branch" }>, "type" | "sessionId">,
    sessionId: string,
    /** 源会话 id：住在新内核里的会话由新内核分支（源本子在它树的库里，分出来的是新树、新库） */
    sourceSessionId?: string,
  ): Promise<string | null> {
    if (sourceSessionId !== undefined) {
      const route = await this.kernel.editRoute(sourceSessionId);
      if (route.to === "kernel") {
        await this.ensureKernel();
        const created = this.awaitCreated(sessionId, "kernel runtime did not confirm the branch in time");
        this.kernelEdits.add(sessionId);
        this.postKernel({ type: "branch", sessionId, ...input, sourceSessionId, sourceRoot: route.root }, sessionId);
        return created.finally(() => this.kernelEdits.delete(sessionId));
      }
    }
    await this.ensure();
    const created = this.awaitCreated(sessionId, "agent runtime did not confirm the branch in time");
    this.post({ type: "branch", sessionId, ...input });
    return created;
  }

  /**
   * pi 本子的原地编辑（回退 / 撤销）：等 runtime 的 `piBookEdited` 回执。
   * ensure：回退可以在冷启动后、第一次开轮前发生（用户打开旧会话直接回退），
   * 那时 runtime 还没起——裁本子不需要会话活着，只需要进程在。
   */
  async editPiBook(
    command: Extract<AgentCommand, { type: "revertPiBook" | "undoPiBook" | "movePiBook" }>,
  ): Promise<void> {
    const route = await this.kernel.editRoute(command.sessionId);
    if (route.to === "kernel") {
      await this.ensureKernel();
      this.kernelEdits.add(command.sessionId);
      return this.awaitPiEdit(command.sessionId, "kernel runtime did not confirm the edit in time", () => this.postKernel(command, route.root)).finally(() =>
        this.kernelEdits.delete(command.sessionId),
      );
    }
    await this.ensure();
    return this.awaitPiEdit(command.sessionId, "agent runtime did not confirm the pi book edit in time", () => this.post(command));
  }

  /** 等一条本子编辑的回执（piBookEdited / failed），30 秒兜底 */
  private awaitPiEdit(sessionId: string, timeoutMessage: string, send: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingPiEdits.set(sessionId, { resolve, reject });
      setTimeout(() => {
        if (!this.pendingPiEdits.delete(sessionId)) return;
        reject(new Error(timeoutMessage));
      }, 30_000);
      send();
    });
  }

  /** 等 runtime 对一条命令回 `created`（create 与 branch 共用；失败经 failed / exit 拒绝）。 */
  private awaitCreated(sessionId: string, timeoutMessage: string): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      this.pendingCreates.set(sessionId, { resolve, reject });
      setTimeout(() => {
        if (!this.pendingCreates.delete(sessionId)) return;
        reject(new Error(timeoutMessage));
      }, 60_000);
    });
  }

  /**
   * 内建 provider 目录。会顺带把 agent 进程拉起来——它是 pi 的唯一宿主。
   * 目录还没到就等它到（带超时兜底：拿不到目录只是没有下拉框，不该把设置面卡死）。
   */
  async listBuiltins(): Promise<BuiltinProvider[]> {
    await this.ensure();
    if (this.builtins.length > 0) return this.builtins;
    this.builtinsArrived ??= new Promise<BuiltinProvider[]>((resolve) => {
      this.resolveBuiltins = resolve;
      setTimeout(() => resolve(this.builtins), 15_000);
    });
    return this.builtinsArrived;
  }

  /**
   * 把「已添加服务商的目录全量」送给 agent 进程：它只联网刷新这些（审核 F-1），并当场按节流补刷。
   * 服务商列表变了（添加 / 改 / 删 / 登录）由 provider IPC 调。**不 ensure**：进程没起就不为它
   * 拉起——下次拉起时 ready 那里会送。发完即回，结果走 builtins 广播。
   */
  syncCatalogScope(): void {
    const scope = this.catalogScope;
    const ready = this.ready;
    if (scope === undefined || ready === null) return;
    void Promise.all([ready, scope()])
      .then(([, catalogIds]) => {
        // 等的这一会儿进程可能退了又起：那个新进程会在自己的 ready 里送，这里不重复
        if (this.ready !== ready || this.child === null) return;
        this.post({ type: "refreshCatalogs", scope: "added", catalogIds: [...catalogIds] });
      })
      .catch((error: unknown) => console.warn("[catalog] 目录刷新范围没送出去：", error));
  }

  /**
   * 设置页点开一张还没保存的服务商卡片：现拉一次这份目录（agent 侧节流内不拉）。
   * 要拉起进程：用户正看着这张卡，目录是给他看的。发完即回，新目录走 builtins 广播。
   */
  async peekCatalog(catalogId: string): Promise<void> {
    await this.ensure();
    this.post({ type: "refreshCatalogs", scope: "peek", catalogIds: [catalogId] });
  }

  /**
   * 热重载（1-1）：让 runtime 把 MCP 连接全拆，等它的 `mcp` 快照事件回来才返回——
   * 那一刻新状态已缓存并广播。**不送 servers**：每轮开轮本来就会送该工作区那一份。
   * **不 ensure**：进程没起就没有连接，reload 无对象（generateTitle 同款理由），
   * 配置会在下一次开轮时生效。
   */
  mcpReload(): Promise<void> {
    if (!this.child) return Promise.resolve();
    this.mcpReloadInFlight ??= new Promise<void>((resolve, reject) => {
      this.settleMcpReload = { resolve, reject };
      setTimeout(() => {
        if (this.settleMcpReload?.resolve !== resolve) return;
        this.settleMcpReload = null;
        this.mcpReloadInFlight = null;
        reject(new Error("agent runtime did not report MCP status in time"));
      }, 60_000);
      this.post({ type: "mcpReload" });
      // 新内核的 MCP 连接也拆掉重建（它有自己的一份 hub）；它的快照事件不结这个 promise——回执只认 agent 进程的
      this.kernelChild?.postMessage({ type: "mcpReload" });
    });
    return this.mcpReloadInFlight;
  }

  /** 开一轮：无状态 submit。返回见 postTurn */
  async submit(command: Extract<AgentCommand, { type: "submit" }>): Promise<string | null> {
    return this.postTurn(command);
  }

  /**
   * 生成会话标题（C-3）。**发完即回**：结果走 `title` 事件，调用方不等也不该等
   * ——它与当前轮并发，成败都不影响对话本身。门禁（titleSource 是否仍是 derived）
   * 在调用方查 meta，runtime 侧只做在途去重。
   */
  generateTitle(
    sessionId: string,
    text: string,
    /** 命名专用模型（已在调用方解好密钥面）；缺席 = 用会话当前的模型 */
    model?: Extract<AgentCommand, { type: "generateTitle" }>["model"],
  ): void {
    // 只给这次运行里由 kernel 新建的会话起一次（kernelTitleOnce）；别的会话不起
    if (!this.ownedByKernel(sessionId) || !this.kernelTitleOnce.delete(sessionId)) return;
    this.postKernel({ type: "generateTitle", sessionId, text, ...(model === undefined ? {} : { model }) });
  }

  /**
   * 专注模式的收工小结：素材正文交给 agent 进程里的家务活模型，等回执（bullets）。
   * 素材比标题请求大、生成 3–5 条要点可能到分钟量级，兑底放宽到 220 秒（agent 侧
   * 180 秒先断）——到点时卡片先出「正在整理」，转圈等它。
   */
  async summarizeFocus(
    provider: Extract<AgentCommand, { type: "summarizeFocus" }>["provider"],
    modelId: string,
    prompt: string,
  ): Promise<string[]> {
    await this.ensure();
    this.focusSummarySeq += 1;
    const requestId = `focus-summary-${this.focusSummarySeq}`;
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingFocusSummaries.has(requestId)) return;
        this.pendingFocusSummaries.delete(requestId);
        reject(new Error("the model didn't answer in time"));
      }, 220_000);
      this.pendingFocusSummaries.set(requestId, {
        resolve: (bullets) => {
          clearTimeout(timer);
          resolve(bullets);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.post({ type: "summarizeFocus", requestId, provider, modelId, prompt });
    });
  }

  /**
   * 连接探测（Test 的 OAuth 路由）：让 agent 进程用 pi 的客户端（与真会话同源）
   * 发一条小消息。1 分钟没回当失败——网关挂住时不让 Test 按钮一直转。
   */
  async probeProvider(
    provider: Extract<AgentCommand, { type: "probeProvider" }>["provider"],
    modelId: string,
  ): Promise<{ ok: boolean; message: string }> {
    await this.ensure();
    this.probeSeq += 1;
    const requestId = `probe-${this.probeSeq}`;
    return new Promise<{ ok: boolean; message: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingProbes.has(requestId)) return;
        this.pendingProbes.delete(requestId);
        reject(new Error("the model didn't answer in time"));
      }, 60_000);
      this.pendingProbes.set(requestId, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.post({ type: "probeProvider", requestId, provider, modelId });
    });
  }

  /**
   * 会话内换模型（C-4）。**发完即回**：成功经 `model` 事件、失败经 `failed` 事件
   * 回传，调用方不等也不该等——切换是一次真实的注册与校验，忙碌态由事件链表达。
   * kernel 进程在、且这次运行里交给过它的会话由 kernel 校验；其余（空闲的旧会话，或 kernel 已闲置回收 / 崩了——那时
   * 这条会话没有在跑的轮）由 agent 进程做同一套注册与校验并报 model 事件（recorder 据此把新型号落进 meta，下一轮按 meta 装配）。
   * 以前 kernel 不在时这条命令被 postKernel 丢掉：没有 model 事件，meta 不落新型号，下一轮仍用旧型号。
   */
  async setModel(
    sessionId: string,
    provider: Extract<AgentCommand, { type: "setModel" }>["provider"],
    modelId: string,
  ): Promise<void> {
    if (this.ownedByKernel(sessionId) && this.kernelChild !== null) {
      this.postKernel({ type: "setModel", sessionId, provider, modelId });
      return;
    }
    await this.ensure();
    this.post({ type: "setModel", sessionId, provider, modelId });
  }

  /** 意图确认卡的回答（实验功能 intent-system）。**不需要 ensure**：进程没了的话请求也早没了，发完即回。 */
  answerIntentConfirm(requestId: string, decision: IntentConfirmDecision): void {
    this.reply({ type: "intentConfirmResult", requestId, decision } satisfies AgentCommand);
  }

  /** 写盘请求的回执（4-3）。同 answerIntentConfirm 的理由：不 ensure、发完即回。 */
  answerSkillWrite(requestId: string, result: { ok: boolean; path?: string; error?: string }): void {
    this.reply({
      type: "skillWriteResult",
      requestId,
      ok: result.ok,
      ...(result.path === undefined ? {} : { path: result.path }),
      ...(result.error === undefined ? {} : { error: result.error }),
    } satisfies AgentCommand);
  }

  answerMcpWrite(
    requestId: string,
    result: { ok: boolean; status?: McpStatus; error?: string },
  ): void {
    this.reply({
      type: "mcpWriteResult",
      requestId,
      ok: result.ok,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.error === undefined ? {} : { error: result.error }),
    } satisfies AgentCommand);
  }

  /** B-1 读 task 请求的回执。同 answerSkillWrite 的理由：不 ensure、发完即回。 */
  answerReadTask(requestId: string, result: ReadTaskOutcome): void {
    this.reply({
      type: "readTaskResult",
      requestId,
      ...(result.ok
        ? { ok: true as const, card: result.card, text: result.text }
        : { ok: false as const, error: result.error }),
    } satisfies AgentCommand);
  }

  /** 插件：install_plugin 的回执（立即回，不等用户）。同上：不 ensure、发完即回。 */
  answerPluginInstall(requestId: string, outcome: PluginAgentInstallOutcome): void {
    this.reply({ type: "pluginInstallResult", requestId, ...outcome } satisfies AgentCommand);
  }

  /** 插件：preview_plugin 的回执。同上。 */
  answerPluginPreview(requestId: string, outcome: PluginAgentPreviewOutcome): void {
    this.reply({ type: "pluginPreviewResult", requestId, ...outcome } satisfies AgentCommand);
  }

  /** 插件：list_plugins 的回执。同上。 */
  answerPluginList(requestId: string, outcome: PluginAgentListOutcome): void {
    this.reply({ type: "pluginListResult", requestId, ...outcome } satisfies AgentCommand);
  }

  /** 插件：show_plugin_board 的回执（卡快照）。同上。 */
  answerPluginBoard(requestId: string, outcome: PluginBoardOutcome): void {
    this.reply({ type: "pluginBoardResult", requestId, ...outcome } satisfies AgentCommand);
  }

  /**
   * 记忆召回：memoryRecallRequest 的回执。同
   * answerReadTask 的理由：不 ensure、发完即回——调用方（主进程的转发层）自己
   * 兑超时，agent 侧另有一层硬超时兑底。
   */
  answerMemoryRecall(requestId: string, outcome: MemoryRecallOutcome): void {
    this.reply({
      type: "memoryRecallResult",
      requestId,
      ...(outcome.ok ? { ok: true as const, hits: outcome.hits } : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 记忆工具：memoryToolRequest 的回执。同 answerMemoryRecall：不 ensure、发完即回。 */
  answerMemoryTool(requestId: string, outcome: MemoryAgentOutcome): void {
    this.reply({
      type: "memoryToolResult",
      requestId,
      ...(outcome.ok ? { ok: true as const, entries: outcome.entries } : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /**
   * 子会话：父→子注入（Q2' 裁决）。调用方（requests.ts 的 deliverToChild）只在目标 phase 不是 idle 时才发这条——
   * 在跑的轮一定是这次运行里交给 kernel 的。没交给过 kernel 说明状态已经失步：抛错，调用方据此按「已记入通道但没送达」
   * 处理，不静默丢。
   */
  steer(sessionId: string, text: string, delivery: ChannelDelivery): void {
    if (!this.ownedByKernel(sessionId)) throw new Error("the session has no running turn to steer");
    this.postKernel({ type: "steer", sessionId, text, delivery });
  }

  /**
   * 用户的话插进这条会话正在跑的那一轮（agent:steer）。没交给过 kernel / kernel 不在：没有轮可插，当场回 bounced
   * （renderer 队列里那条退回普通排队）——不抛错，用户的话本来就还在队列里，不丢。
   */
  steerUser(sessionId: string, id: string, text: string): void {
    if (!this.ownedByKernel(sessionId) || this.kernelChild === null) {
      this.onEvent({ type: "userSteer", sessionId, id, outcome: "bounced" });
      return;
    }
    this.postKernel({ type: "steer", sessionId, text, userSteerId: id });
  }

  /** 受管浏览器：browserRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerBrowser(requestId: string, outcome: BrowserToolOutcome): void {
    this.reply({
      type: "browserResult",
      requestId,
      ...(outcome.ok
        ? {
            ok: true as const,
            text: outcome.text,
            card: outcome.card,
            ...(outcome.image === undefined ? {} : { image: outcome.image }),
          }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 演示文稿导出：slidesRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerSlides(requestId: string, outcome: SlidesOutcome): void {
    this.reply({ type: "slidesResult", requestId, ...outcome } satisfies AgentCommand);
  }

  /** 文档导出：docRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerDoc(requestId: string, outcome: DocOutcome): void {
    this.reply({ type: "docResult", requestId, ...outcome } satisfies AgentCommand);
  }

  /** 终端：terminalRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerTerminal(requestId: string, outcome: TerminalToolOutcome): void {
    this.reply({
      type: "terminalResult",
      requestId,
      ...(outcome.ok
        ? { ok: true as const, text: outcome.text, ...(outcome.terminal === undefined ? {} : { terminal: outcome.terminal }) }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 自动化：automationRequest 的回执（delegate 同款）：不 ensure、发完即回。 */
  answerAutomation(requestId: string, outcome: AutomationToolOutcome): void {
    this.reply({
      type: "automationResult",
      requestId,
      ...(outcome.ok
        ? {
            ok: true as const,
            text: outcome.text,
            ...(outcome.automation === undefined ? {} : { automation: outcome.automation }),
            ...(outcome.automations === undefined ? {} : { automations: outcome.automations }),
          }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 子会话：delegateRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerDelegate(requestId: string, outcome: DelegateOutcome): void {
    this.reply({
      type: "delegateResult",
      requestId,
      ...(outcome.ok
        ? { ok: true as const, childId: outcome.childId, title: outcome.title, card: outcome.card }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 派发参考：modelCostsRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerModelCosts(requestId: string, outcome: ModelCostsOutcome): void {
    this.reply({
      type: "modelCostsResult",
      requestId,
      ...(outcome.ok ? { ok: true as const, text: outcome.text } : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 子会话：channelSendRequest 的回执。同上。 */
  answerChannelSend(requestId: string, outcome: ChannelSendOutcome): void {
    this.reply({
      type: "channelSendResult",
      requestId,
      ...(outcome.ok
        ? { ok: true as const, messageId: outcome.messageId }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 停下当前这一轮（含工具调用），把这句话作为新一轮发出去 */
  async interrupt(command: Extract<AgentCommand, { type: "interrupt" }>): Promise<string | null> {
    return this.postTurn(command);
  }

  /** 停止只停当前轮。没交给过 kernel 的会话没有在跑的轮：「停止」对空闲会话本就是 no-op */
  async abort(sessionId: string): Promise<void> {
    if (this.ownedByKernel(sessionId)) this.postKernel({ type: "abort", sessionId });
  }

  /** 手动压缩上下文。**发完即回**（续轮）：忙碌态与界碑走 compaction 事件链。首轮开机时等 created */
  async compact(command: Extract<AgentCommand, { type: "compact" }>): Promise<string | null> {
    return this.postTurn(command);
  }

  /**
   * 释放一条会话（kernel 侧停轮、出表）。没交给过 kernel 的会话 kernel 里本来就没有它；
   * 进程不在时不为释放去拉起（postKernel 的规矩）。
   */
  disposeSession(sessionId: string): void {
    if (!this.ownedByKernel(sessionId)) return;
    this.postKernel({ type: "dispose", sessionId });
    this.kernelSessions.delete(sessionId);
  }

  /**
   * 删树里的一条会话（不是树根）：让 kernel 停它的轮、从树的库里摘掉（库关闭时清行）。kernel 没开着就为这件事拉起它——
   * 墓碑要写在库里摘掉之后，只有 kernel 进程碰得到库。
   */
  async forgetKernelSession(sessionId: string, root: string): Promise<void> {
    await this.ensureKernel();
    this.postKernel({ type: "forget", sessionId }, root);
    this.kernelSessions.delete(sessionId);
  }

  /**
   * 删一棵会话树的库：kernel 进程开着就让它停轮、关库再删（不在写者手里删文件）；没开着返回 false，
   * 调用方直接删文件（KernelHost.drop）。
   */
  async dropKernelLibrary(library: string): Promise<boolean> {
    // 正在闲置回收：等它关完库，再由调用方直接删文件
    if (this.kernelRecycling !== null) await this.kernelRecycling;
    if (this.kernelChild === null) return false;
    const child = this.kernelChild;
    this.kernelSeq += 1;
    const requestId = `drop-${this.kernelSeq}`;
    const error = await new Promise<string | undefined>((resolve) => {
      this.pendingKernel.set(requestId, resolve);
      child.postMessage({ type: "drop", requestId, library });
    });
    if (error !== undefined) throw new Error(error);
    return true;
  }

  /**
   * 应用正常退出：让 kernel 停掉在跑的轮（上下文与队列都留在库里，下次打开是「上次被中断」）、关库，再杀进程。
   * 最多等 timeoutMs（卡住也不拖住退出）。
   */
  async shutdownKernel(timeoutMs = 3000): Promise<void> {
    if (this.kernelIdleTimer !== null) clearTimeout(this.kernelIdleTimer);
    this.kernelIdleTimer = null;
    // 正在闲置回收：它自己在关库，等它退完
    if (this.kernelRecycling !== null) await this.kernelRecycling;
    const child = this.kernelChild;
    if (child === null) return;
    await this.shutdownChild(child, timeoutMs);
  }

  private async shutdownChild(child: KernelChild, timeoutMs: number): Promise<void> {
    this.kernelSeq += 1;
    const requestId = `shutdown-${this.kernelSeq}`;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        // 卡住也不拖住：等待登记一并撤掉（不然它会一直算作「在途」，闲置回收永远等不到）
        this.pendingKernel.delete(requestId);
        resolve();
      }, timeoutMs);
      this.pendingKernel.set(requestId, () => {
        clearTimeout(timer);
        resolve();
      });
      child.postMessage({ type: "shutdown", requestId });
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
    if (this.kernelIdleTimer !== null) clearTimeout(this.kernelIdleTimer);
    this.kernelIdleTimer = null;
    this.kernelChild?.kill();
    this.kernelChild = null;
    this.kernelReady = null;
  }

  private post(command: AgentHouseholdCommand): void {
    if (!this.child) throw new Error("agent runtime is not running");
    this.child.postMessage(command);
  }
}
