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
import type { McpStatus } from "../../shared/mcp.ts";
import type { BrowserToolOutcome } from "../../shared/browser.ts";
import type { TerminalToolOutcome } from "../../shared/terminal.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import type { IntentConfirmDecision } from "../../shared/intent-confirm.ts";

/** host 对「子进程」的全部要求——Electron 的 UtilityProcess 结构上满足，测试用脚本假货顶上。 */
export interface AgentChild {
  on(event: "message", listener: (message: AgentEvent) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: AgentCommand): unknown;
  kill(): unknown;
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
  /** 在等的 classifyGreetings 回执（迁移的「只随手发了一句」检查），按 requestId；进程退出全部 reject */
  private readonly pendingGreetings = new Map<
    string,
    { resolve: (throwaway: number[]) => void; reject: (error: Error) => void }
  >();
  private greetingSeq = 0;
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
  constructor(forkRuntime: () => AgentChild, onEvent: (event: AgentEvent) => void, catalogScope?: CatalogScope) {
    this.forkRuntime = forkRuntime;
    this.onEvent = onEvent;
    this.catalogScope = catalogScope;
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
          // 每次拉起（含崩溃后重拉）都送一份全量：agent 进程不记得上一个自己听过什么
          this.syncCatalogScope();
          return;
        }
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
        if (message.type === "greetingsClassified") {
          // 只回给发起的那次检查，不广播：窗口不认这个事件
          const pending = this.pendingGreetings.get(message.requestId);
          this.pendingGreetings.delete(message.requestId);
          if (message.throwaway === null) pending?.reject(new Error(message.error ?? "the model's reply couldn't be read"));
          else pending?.resolve(message.throwaway);
          return;
        }
        if (message.type === "focusSummarized") {
          // 同 greetingsClassified：只结发起方，不广播
          const pending = this.pendingFocusSummaries.get(message.requestId);
          this.pendingFocusSummaries.delete(message.requestId);
          if (message.bullets === null) pending?.reject(new Error(message.error ?? "the model's reply couldn't be read"));
          else pending?.resolve(message.bullets);
          return;
        }
        if (message.type === "providerProbed") {
          // 同 greetingsClassified：只结发起方，不广播
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
        for (const pending of this.pendingGreetings.values()) pending.reject(new Error(message));
        this.pendingGreetings.clear();
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

  /**
   * pi 本子的原地编辑（回退 / 撤销）：等 runtime 的 `piBookEdited` 回执。
   * ensure：回退可以在冷启动后、第一次开轮前发生（用户打开旧会话直接回退），
   * 那时 runtime 还没起——裁本子不需要会话活着，只需要进程在。
   */
  async editPiBook(
    command: Extract<AgentCommand, { type: "revertPiBook" | "undoPiBook" }>,
  ): Promise<void> {
    await this.ensure();
    return new Promise<void>((resolve, reject) => {
      this.pendingPiEdits.set(command.sessionId, { resolve, reject });
      setTimeout(() => {
        if (!this.pendingPiEdits.delete(command.sessionId)) return;
        reject(new Error("agent runtime did not confirm the pi book edit in time"));
      }, 30_000);
      this.post(command);
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

  /**
   * 专注模式的收工小结：素材正文交给 agent 进程里的家务活模型，等回执（bullets）。
   * 素材比问候检查大、生成 3–5 条要点可能到分钟量级，兑底放宽到 220 秒（agent 侧
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

  /** 意图确认卡的回答（实验功能 intent-system）。同 answerPermission：不 ensure、发完即回。 */
  answerIntentConfirm(requestId: string, decision: IntentConfirmDecision): void {
    this.child?.postMessage({ type: "intentConfirmResult", requestId, decision } satisfies AgentCommand);
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
    result: { ok: boolean; status?: McpStatus; error?: string },
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

  /** 受管浏览器：browserRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerBrowser(requestId: string, outcome: BrowserToolOutcome): void {
    this.child?.postMessage({
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

  /** 终端：terminalRequest 的回执。同 answerReadTask 的理由：不 ensure、发完即回。 */
  answerTerminal(requestId: string, outcome: TerminalToolOutcome): void {
    this.child?.postMessage({
      type: "terminalResult",
      requestId,
      ...(outcome.ok
        ? { ok: true as const, text: outcome.text, ...(outcome.terminal === undefined ? {} : { terminal: outcome.terminal }) }
        : { ok: false as const, error: outcome.error }),
    } satisfies AgentCommand);
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
