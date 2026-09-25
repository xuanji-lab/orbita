/**
 * AgentHost 的全部逻辑 —— **纯模块**：不 import electron，可被 `node --test` 直接测
 * （recorder.ts 同款先例）。真的 fork 在 `host.ts` 那层注入。
 *
 * 只做三件事：懒启动进程、把命令发进去、把事件广播给窗口。业务判断全在两端，不在这里。
 */
import type {
  AgentCommand,
  AgentEvent,
  BuiltinProvider,
  ChannelSendOutcome,
  DelegateOutcome,
  ReadTaskOutcome,
} from "../../shared/agent-ipc.ts";
import type { ChannelDelivery } from "../../shared/channel.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";

/** host 对「子进程」的全部要求——Electron 的 UtilityProcess 结构上满足，测试用脚本假货顶上。 */
export interface AgentChild {
  on(event: "message", listener: (message: AgentEvent) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: AgentCommand): unknown;
  kill(): unknown;
}

export class AgentHostCore {
  private readonly forkRuntime: () => AgentChild;
  private readonly onEvent: (event: AgentEvent) => void;
  private child: AgentChild | null = null;
  private ready: Promise<void> | null = null;
  /** pi 报上来的内建目录。runtime 是**先发 ready 再异步建目录**，所以不能只等 ready
   *  就返回缓存——那一刻缓存必然是空的（下拉框不出现就是这个竞态）。 */
  private builtins: BuiltinProvider[] = [];
  private resolveBuiltins: ((providers: BuiltinProvider[]) => void) | null = null;
  private builtinsArrived: Promise<BuiltinProvider[]> | null = null;
  /**
   * 正在等待 `created` 的命令（submit / interrupt / compact 的首轮开机、branch）。
   * runtime 无状态化后每轮开机都会发 `created`：等待者拿到 pi 本子路径；
   * 没人等的（续轮）交 onEvent 转发，主进程用它把真值校准回 meta（自愈）。
   */
  private readonly pendingCreates = new Map<
    string,
    { resolve: (piSessionFile: string | null) => void; reject: (error: Error) => void }
  >();
  /**
   * 在等的 mcpReload 回执（1-1 热重载）：runtime 重连完会发一条 `mcp` 快照事件，
   * 用它把 invoke 的 promise 结掉——reload 是显式动作，调用方等着拿结果。
   * 进程退出要 reject：那量重启后状态未知，不能装作重载成功。
   */
  private pendingMcpReload: { resolve: () => void; reject: (error: Error) => void } | null = null;
  /** 在等的 classifyGreetings 回执（迁移的「只随手发了一句」检查），按 requestId；进程退出全部 reject */
  private readonly pendingGreetings = new Map<
    string,
    { resolve: (throwaway: number[]) => void; reject: (error: Error) => void }
  >();
  private greetingSeq = 0;

  constructor(forkRuntime: () => AgentChild, onEvent: (event: AgentEvent) => void) {
    this.forkRuntime = forkRuntime;
    this.onEvent = onEvent;
  }

  /** 懒启动：第一次真正要用 agent 时才付进程启动的钱。 */
  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = this.forkRuntime();
      this.child = child;

      child.on("message", (message: AgentEvent) => {
        if (message.type === "ready") {
          resolve();
          return;
        }
        if (message.type === "builtins") {
          this.builtins = message.providers;
          this.resolveBuiltins?.(message.providers);
          this.resolveBuiltins = null;
          return;
        }
        if (message.type === "mcp") {
          // reload 的回执到了：事件照常往下走（缓存 + 广播），这里只结 promise
          this.pendingMcpReload?.resolve();
          this.pendingMcpReload = null;
        }
        if (message.type === "greetingsClassified") {
          // 只回给发起的那次检查，不广播：窗口不认这个事件
          const pending = this.pendingGreetings.get(message.requestId);
          this.pendingGreetings.delete(message.requestId);
          if (message.throwaway === null) pending?.reject(new Error(message.error ?? "the model's reply couldn't be read"));
          else pending?.resolve(message.throwaway);
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
        this.pendingMcpReload?.reject(new Error(message));
        this.pendingMcpReload = null;
        for (const pending of this.pendingGreetings.values()) pending.reject(new Error(message));
        this.pendingGreetings.clear();
        reject(new Error(message));
        this.onEvent({ type: "failed", sessionId: null, message });
      });
    });
    return this.ready;
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
    await this.ensure();
    let created: Promise<string | null> | null = null;
    if (command.piSessionFile === undefined) {
      created = this.awaitCreated(command.sessionId, "agent runtime did not confirm the session in time");
    }
    this.post(command);
    return created;
  }

  /**
   * pi 侧分支（C-2）：让 runtime 把源 pi 本子裁一份新文件，等 `created` 回来。
   * sessionId 是主进程先生成好的**新会话 id**；调用方拿到文件路径后再把新会话落盘。
   */
  async branchSession(
    input: Omit<Extract<AgentCommand, { type: "branch" }>, "type" | "sessionId">,
    sessionId: string,
  ): Promise<string | null> {
    await this.ensure();
    const created = this.awaitCreated(sessionId, "agent runtime did not confirm the branch in time");
    this.post({ type: "branch", sessionId, ...input });
    return created;
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
   * 重读配置后重连（1-1）。等 runtime 的 `mcp` 快照事件回来才返回——
   * 那一刻新状态已缓存并广播。**不 ensure**：进程没起就没有连接，reload 无对象
   * （generateTitle 同款理由），配置会在下一次开轮时生效。
   */
  mcpReload(servers: Extract<AgentCommand, { type: "mcpReload" }>["servers"]): Promise<void> {
    if (!this.child) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.pendingMcpReload = { resolve, reject };
      setTimeout(() => {
        if (this.pendingMcpReload?.resolve !== resolve) return;
        this.pendingMcpReload = null;
        reject(new Error("agent runtime did not report MCP status in time"));
      }, 60_000);
      this.post({ type: "mcpReload", servers });
    });
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
    if (!this.child) return; // 进程没起：标题不重要，别为它拉起整个 runtime
    this.post({ type: "generateTitle", sessionId, text, ...(model === undefined ? {} : { model }) });
  }

  /**
   * 迁移的「只随手发了一句」检查：一批消息交给 agent 进程判，等回执（判中的下标）。与标题不同，
   * 这是用户点出来、等着看结果的动作——进程没起就拉起来，失败要让调用方知道。
   * 一批几十条的一次小调用，2 分钟没回就当失败（网关挂住时不让页面一直转）。
   */
  async classifyGreetings(
    provider: Extract<AgentCommand, { type: "classifyGreetings" }>["provider"],
    modelId: string,
    messages: string[],
  ): Promise<number[]> {
    await this.ensure();
    this.greetingSeq += 1;
    const requestId = `greetings-${this.greetingSeq}`;
    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingGreetings.has(requestId)) return;
        this.pendingGreetings.delete(requestId);
        reject(new Error("the model didn't answer in time"));
      }, 120_000);
      // 结了就撤掉计时器：不然一个早已结掉的检查还拖着进程两分钟
      this.pendingGreetings.set(requestId, {
        resolve: (throwaway) => {
          clearTimeout(timer);
          resolve(throwaway);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.post({ type: "classifyGreetings", requestId, provider, modelId, messages });
    });
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    await this.ensure();
    this.post({ type: "setMode", sessionId, mode });
  }

  /**
   * 会话内换模型（C-4）。**发完即回**：成功经 `model` 事件、失败经 `failed` 事件
   * 回传，调用方不等也不该等——切换是一次真实的注册与校验，忙碌态由事件链表达。
   */
  async setModel(
    sessionId: string,
    provider: Extract<AgentCommand, { type: "setModel" }>["provider"],
    modelId: string,
  ): Promise<void> {
    await this.ensure();
    this.post({ type: "setModel", sessionId, provider, modelId });
  }

  /** 用户的审批回答。**不需要 ensure**：进程没了的话请求也早没了。 */
  answerPermission(requestId: string, answer: PermissionAnswer): void {
    this.child?.postMessage({ type: "permissionAnswer", requestId, answer } satisfies AgentCommand);
  }

  /** 写盘请求的回执（4-3）。同 answerPermission 的理由：不 ensure、发完即回。 */
  answerSkillWrite(requestId: string, result: { ok: boolean; path?: string; error?: string }): void {
    this.child?.postMessage({
      type: "skillWriteResult",
      requestId,
      ok: result.ok,
      ...(result.path === undefined ? {} : { path: result.path }),
      ...(result.error === undefined ? {} : { error: result.error }),
    } satisfies AgentCommand);
  }

  answerMcpWrite(
    requestId: string,
    result: { ok: boolean; status?: { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string }; error?: string },
  ): void {
    this.child?.postMessage({
      type: "mcpWriteResult",
      requestId,
      ok: result.ok,
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.error === undefined ? {} : { error: result.error }),
    } satisfies AgentCommand);
  }

  /** B-1 读 task 请求的回执。同 answerSkillWrite 的理由：不 ensure、发完即回。 */
  answerReadTask(requestId: string, result: ReadTaskOutcome): void {
    this.child?.postMessage({
      type: "readTaskResult",
      requestId,
      ...(result.ok
        ? { ok: true as const, card: result.card, text: result.text }
        : { ok: false as const, error: result.error }),
    } satisfies AgentCommand);
  }

  /**
   * 子会话：父→子注入（Q2' 裁决）。**走 `post`，不 `ensure`**——调用方（requests.ts
   * 的 deliverToChild）只在目标 phase 不是 idle 时才发这条，进程没起说明状态已经
   * 失步，`post` 会抛，调用方据此按「已记入通道但没送达」处理，不静默丢。
   */
  steer(sessionId: string, text: string, delivery: ChannelDelivery): void {
    this.post({ type: "steer", sessionId, text, delivery });
  }

  /** 子会话：delegateRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerDelegate(requestId: string, outcome: DelegateOutcome): void {
    this.child?.postMessage({
      type: "delegateResult",
      requestId,
      ...(outcome.ok
        ? { ok: true as const, childId: outcome.childId, title: outcome.title, card: outcome.card }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
  }

  /** 子会话：channelSendRequest 的回执。同上。 */
  answerChannelSend(requestId: string, outcome: ChannelSendOutcome): void {
    this.child?.postMessage({
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

  async abort(sessionId: string): Promise<void> {
    await this.ensure();
    this.post({ type: "abort", sessionId });
  }

  /** 手动压缩上下文。**发完即回**（续轮）：忙碌态与界碑走 compaction 事件链。首轮开机时等 created */
  async compact(command: Extract<AgentCommand, { type: "compact" }>): Promise<string | null> {
    return this.postTurn(command);
  }

  /**
   * 释放一条会话（runtime 侧退订 + `session.dispose()` + 出 Map）。
   * **不 ensure**：进程没起的话这条会话本来就不在 runtime 里（answerPermission 同款理由），
   * 为释放去拉起一个进程才是本末倒置。发完即回，runtime 对不存在的 id 静默容忍。
   */
  disposeSession(sessionId: string): void {
    this.child?.postMessage({ type: "dispose", sessionId } satisfies AgentCommand);
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private post(command: AgentCommand): void {
    if (!this.child) throw new Error("agent runtime is not running");
    this.child.postMessage(command);
  }
}
