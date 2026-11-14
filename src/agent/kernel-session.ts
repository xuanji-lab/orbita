/**
 * 新内核里一条会话的生命周期：旧内核 runtime.ts 的 handle()（submit / interrupt / compact / abort / steer / setMode /
 * setModel / generateTitle / dispose）在 durable 上的对位。不 import electron，`node --test` 直接测
 * （库池用 MemoryStorage、模型用 faux）；进程壳在 kernel-runtime.ts。
 *
 * 守住的是旧内核的**时序契约**，用的是旧内核**同一份**骨架与函数：
 * - 占坑 → 开 → 跑 → 收尾：turn-cycle.ts 的 startCycle / abortCycle / killCycle（同一个模块）。phase idle 只在
 *   收尾的最后一步发——renderer 收到 idle 时这一轮一定完全结束，投递排队消息不会撞 already running。
 * - 停止（abort）只停当前轮：`harness.abortTask(run)`，不用 `Conversation.abort()`（它会撤掉 inbox 里排着的插话）。
 *   队列在 renderer 的槽里，idle 到了照常投下一条——「停止不替用户清队」。
 * - 抢跑（interrupt「立即发送」/ 手动压缩）：停旧轮、等它收尾（不发 idle：preempt），紧接着开新的一轮。
 * - 手动压缩独占一轮（phase compaction，期间新消息进 renderer 的队列）：与旧内核一致；durable 本身允许压缩与对话
 *   并行（方案 §2.2 第 11 行），这一步不改界面的压缩语义。
 * - 父→子插话（steer）：交给 durable 的 inbox（whenBusy: steer / followUp，whenIdle: reject），这一轮等到会话空闲才算完
 *   （kernel-turn.ts 的 runTurn），所以插话开出的后续 run 仍在这一轮里；用户排队的消息不进 inbox，两条路互不相交。
 * - 中途切档：账本里的 mode 现读（闸门的 currentMode），对正在跑的这一轮的下一个工具调用立刻生效。
 */
import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import { calculateContextTokens, estimateTokens } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { ConversationIdle, LiveDoc, type Conversation, type EntryRecord, type Harness } from "@earendil-works/pi-durable";
import type { AgentCommand, AgentEvent, AgentStats, ProviderSecrets } from "../shared/agent-ipc.ts";
import { composeIntentPrompt } from "../shared/intent-recall.ts";
import { durableBookRef, kernelLibraryName, type KernelContinueCommand, type KernelSessionCommand, type KernelTurnResult } from "../shared/kernel.ts";
import type { PermissionMode } from "../shared/permission.ts";
import { attachmentBlocks, splitEchoBlocks } from "../shared/prompt-attachments.ts";
import { COMPACTION_DEFAULT } from "../shared/settings.ts";
import { compactionBoundaryTimestamp, compactionErrorText, type TurnTiming } from "./compaction-settings.ts";
import { TurnFileTracker } from "./file-tracker.ts";
import type { IntentConfirmWaiter } from "./intent-confirm-wait.ts";
import { runIntentGate } from "./intent-gate.ts";
import type { KernelPool, KernelTarget } from "./kernel.ts";
import { runTurn, ToolRounds, type KernelTurnRuntime, type TurnOutcome } from "./kernel-turn.ts";
import { KernelView } from "./kernel-view.ts";
import type { PiModel } from "./model-registration.ts";
import { generateTitle } from "./session-title.ts";
import { TranscriptAdapter } from "./transcript-adapter.ts";
import type { preparePromptImages } from "./prompt-images.ts";
import { abortCycle, killCycle, startCycle, type CycleParts, type CycleSlot } from "./turn-cycle.ts";
import { reportFileTurn, type WebArtifactWatch } from "./turn-files.ts";
import { webScanRoots } from "./web-artifacts.ts";
import { withOpencodeSession } from "./opencode-session.ts";

type TurnCommand = Extract<AgentCommand, { type: "submit" | "interrupt" }>;
type CompactCommand = Extract<AgentCommand, { type: "compact" }>;
type OpenCommand = TurnCommand | CompactCommand | KernelContinueCommand;

/** 跨轮账本里的一条（旧内核 runtime.ts 的 LedgerNote 的对位）：不持有 durable 对象，会话不在跑时也活着 */
interface SessionNote {
  mode: PermissionMode;
  titleInFlight: boolean;
  apiKey: string;
  headers?: Record<string, string>;
  /** 最近一轮用的模型（标题与 setModel 校验用） */
  model: PiModel | undefined;
}

/** 正在跑的一轮的对象面（turn-cycle 的 CycleParts） */
interface KernelParts extends CycleParts {
  target: Extract<KernelTarget, { ok: true }>;
  view: KernelView;
  tracker: TurnFileTracker;
  webWatch: WebArtifactWatch;
  timing: TurnTiming;
  intentAbort: AbortController;
  /** 本轮被停止 / 抢跑过（turn-failure 不报、提交前不再提交） */
  aborted: () => boolean;
  stats: KernelStats;
  /** 这一轮的工具准备 / 执行节奏（kernel-turn.ts 的 ToolRounds） */
  rounds: ToolRounds;
}

/** 外面给的进程级依赖 */
export interface KernelSessionsDeps {
  pool: KernelPool;
  runtime: KernelTurnRuntime;
  intentConfirm: IntentConfirmWaiter;
  /** 一轮落定（phase idle 之前到）：主进程据此清「在跑」标记、记迁移失败 */
  settled: (sessionId: string, result: KernelTurnResult) => void;
  /** setModel 的校验：注册并解析型号（与旧内核 setLedgerModel 同一条路径）；解析不到返回 undefined */
  resolveModel: (provider: ProviderSecrets, modelId: string) => Promise<PiModel | undefined>;
  now?: () => number;
}

/**
 * 用量快照（旧内核 pushStats 读 AgentSession.getSessionStats 的对位）：token 与花费累计本会话全部回答与工具结果的
 * usage（pi 的 getSessionStats 同口径：本子里每条消息的 usage 加总），上下文占用按 pi 同一个估算法
 * （最后一条有效回答的 usage + 其后消息的 estimateTokens；压缩之后还没有新回答 = 未知）。
 */
export class KernelStats {
  private readonly totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  private lastEntry = 0;
  /** 最近一次算出的上下文占用（压缩界碑的 tokensBefore 用） */
  lastContextTokens: number | null = null;

  async refresh(conversation: Conversation): Promise<void> {
    let cursor: Parameters<Conversation["entries"]>[2];
    for (;;) {
      const page = await conversation.entries({ minEntryId: (this.lastEntry + 1) as EntryRecord["id"], order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        this.lastEntry = Math.max(this.lastEntry, entry.id);
        for (const message of entry.model ?? []) {
          const usage = (message as { role: string; usage?: Usage }).usage;
          if ((message.role === "assistant" || message.role === "toolResult") && usage !== undefined) this.add(usage);
        }
      }
      if (page.next === undefined) return;
      cursor = page.next;
    }
  }

  private add(usage: Usage): void {
    this.totals.input += usage.input ?? 0;
    this.totals.output += usage.output ?? 0;
    this.totals.cacheRead += usage.cacheRead ?? 0;
    this.totals.cacheWrite += usage.cacheWrite ?? 0;
    this.totals.cost += usage.cost?.total ?? 0;
  }

  async snapshot(conversation: Conversation, contextWindow: number | undefined): Promise<AgentStats> {
    await this.refresh(conversation);
    const view = await conversation.context(BACKGROUND_CONTEXT);
    const context = contextUsage(view.messages, view.head?.kind === "pi.compaction", contextWindow);
    this.lastContextTokens = context?.tokens ?? null;
    const { input, output, cacheRead, cacheWrite, cost } = this.totals;
    return { tokens: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite }, cost, contextUsage: context };
  }
}

function validUsage(message: Message): Usage | undefined {
  if (message.role !== "assistant") return undefined;
  const assistant = message as AssistantMessage;
  if (assistant.stopReason === "aborted" || assistant.stopReason === "error") return undefined;
  return calculateContextTokens(assistant.usage) > 0 ? assistant.usage : undefined;
}

/** pi 的 getContextUsage + estimateContextTokens，对 durable 的模型上下文算一遍 */
export function contextUsage(messages: readonly Message[], compacted: boolean, contextWindow: number | undefined): AgentStats["contextUsage"] {
  const window = contextWindow ?? 0;
  if (window <= 0) return null;
  let index = -1;
  for (let at = messages.length - 1; at >= 0; at--) {
    if (validUsage(messages[at] as Message) !== undefined) {
      index = at;
      break;
    }
  }
  if (index === -1 && compacted) return { tokens: null, contextWindow: window, percent: null };
  let tokens = index === -1 ? 0 : calculateContextTokens(validUsage(messages[index] as Message) as Usage);
  for (let at = index + 1; at < messages.length; at++) tokens += estimateTokens(messages[at] as Parameters<typeof estimateTokens>[0]);
  return { tokens, contextWindow: window, percent: (tokens / window) * 100 };
}

const SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const SUMMARY_SUFFIX = "\n</summary>";

/** durable 的压缩条目 → 摘要原文（durable 包了一层固定的前后缀，旧内核的界碑存的是摘要本身） */
export function compactionSummary(entry: EntryRecord): string {
  const message = entry.model?.[0];
  const text =
    message === undefined
      ? ""
      : typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const start = text.startsWith(SUMMARY_PREFIX) ? SUMMARY_PREFIX.length : 0;
  const end = text.endsWith(SUMMARY_SUFFIX) ? text.length - SUMMARY_SUFFIX.length : text.length;
  return text.slice(start, end);
}

export class KernelSessions {
  private readonly deps: KernelSessionsDeps;
  private readonly running = new Map<string, CycleSlot<KernelParts>>();
  private readonly notes = new Map<string, SessionNote>();
  /** 应用正常退出中（shutdown）：这时停下的轮报 interrupted */
  private shuttingDown = false;
  /** 会话 → 用量累计（跨轮保留：增量读条目） */
  private readonly stats = new Map<string, KernelStats>();

  constructor(deps: KernelSessionsDeps) {
    this.deps = deps;
  }

  private send(event: AgentEvent): void {
    this.deps.runtime.send(event);
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private note(sessionId: string): SessionNote {
    let note = this.notes.get(sessionId);
    if (note === undefined) {
      note = { mode: "plan", titleInFlight: false, apiKey: "", model: undefined };
      this.notes.set(sessionId, note);
    }
    return note;
  }

  /** 这条会话现在有没有一轮在跑（测试与 shutdown 用） */
  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** 一条会话的命令。root：这棵会话树的根会话 id（决定库） */
  async handle(root: string, command: KernelSessionCommand): Promise<void> {
    const library = kernelLibraryName(root);
    if (command.type === "submit" || command.type === "continueRun") {
      await this.startTurn(library, command);
      return;
    }
    if (command.type === "interrupt" || command.type === "compact") {
      // 抢跑：停旧轮、等它收尾（不发 idle），紧接着开新的一轮。中间没有「空闲」——否则 renderer 收到 idle 就投递队首，
      // 撞上新轮的 already running（与旧内核同一条理由）
      abortCycle(this.running, command.sessionId, { preempt: true });
      this.deps.intentConfirm.settle(command.sessionId);
      await this.running.get(command.sessionId)?.lifecycle;
      try {
        await this.startTurn(library, command);
      } catch (cause) {
        this.send({ type: "phase", sessionId: command.sessionId, phase: "idle" });
        throw cause;
      }
      return;
    }
    if (command.type === "abort") {
      // 只停当前轮；排队在 renderer，idle 到了照常投（停止不替用户清队）。挂着的审批随 abort 的 context 结掉
      abortCycle(this.running, command.sessionId);
      this.deps.intentConfirm.settle(command.sessionId);
      return;
    }
    if (command.type === "dispose") {
      await killCycle(this.running, command.sessionId);
      this.notes.delete(command.sessionId);
      this.stats.delete(command.sessionId);
      this.deps.intentConfirm.settle(command.sessionId);
      return;
    }
    if (command.type === "setMode") {
      // 账本字段：正在跑的轮的闸门现读它，下一个工具调用立刻按新档判；不在跑也合法，下一轮开轮时被命令里的档覆盖
      this.note(command.sessionId).mode = command.mode;
      return;
    }
    if (command.type === "setModel") {
      await this.setModel(command.sessionId, command.provider, command.modelId);
      return;
    }
    if (command.type === "generateTitle") {
      // 与旧内核同：只在这一轮还在跑时生成（用当轮的模型与鉴权面），迟到就跳过——下一条消息自然重试
      const note = this.notes.get(command.sessionId);
      if (!this.running.has(command.sessionId) || note === undefined || note.titleInFlight) return;
      note.titleInFlight = true;
      void generateTitle({
        sessionModel: note.model,
        auth: { apiKey: note.apiKey, ...(note.headers ? { headers: note.headers } : {}) },
        sessionId: command.sessionId,
        text: command.text,
        ...(command.model === undefined ? {} : { choreModel: command.model }),
        send: (event) => this.send(event),
      }).finally(() => {
        note.titleInFlight = false;
      });
      return;
    }
    if (command.type === "steer") {
      await this.steer(command.sessionId, command.text, command.delivery ?? "steer");
      return;
    }
    command satisfies never;
  }

  /**
   * 父→子插话：交给 durable 的 inbox。steer = 当前工具轮结束后、下一次请求之前放进来；followUp = 这一轮回答之后再处理。
   * 只在会话忙时收（whenIdle: reject）：到达时这一轮刚结束，回旧内核同一句话让人重发（主进程先看 phase 再分流）。
   */
  private async steer(sessionId: string, text: string, delivery: "steer" | "followUp"): Promise<void> {
    const parts = this.running.get(sessionId)?.opened ?? null;
    const failed = (): void =>
      this.send({ type: "failed", sessionId, message: "steer 到达时这一轮已结束（或刚开机还没接上），注入没送进去——请重发" });
    if (parts === null) {
      failed();
      return;
    }
    try {
      await parts.target.conversation.submit({ type: "input", content: [{ type: "text", text }], whenBusy: delivery, whenIdle: "reject" }, BACKGROUND_CONTEXT);
    } catch (cause) {
      if (cause instanceof ConversationIdle) {
        failed();
        return;
      }
      throw cause;
    }
  }

  private async setModel(sessionId: string, provider: ProviderSecrets, modelId: string): Promise<void> {
    try {
      const scoped = withOpencodeSession(provider, sessionId);
      const model = await this.deps.resolveModel(scoped, modelId);
      if (model === undefined) throw new Error(`unknown model "${scoped.id}/${modelId}"`);
      const note = this.note(sessionId);
      note.apiKey = scoped.apiKey;
      if (scoped.headers === undefined) delete note.headers;
      else note.headers = scoped.headers;
      this.send({ type: "model", sessionId, providerId: model.provider, modelId: model.id });
    } catch (cause) {
      this.send({ type: "failed", sessionId, message: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  private startTurn(library: string, command: OpenCommand): Promise<void> {
    const id = command.sessionId;
    let settledResult: KernelTurnResult = { ok: false, reason: "turn did not start" };
    return startCycle(
      this.running,
      id,
      async () => {
        try {
          return await this.open(library, command);
        } catch (cause) {
          const reason = cause instanceof MigrationFailed ? cause.message : cause instanceof Error ? cause.message : String(cause);
          settledResult = { ok: false, reason, ...(cause instanceof MigrationFailed ? { migrationFailed: true as const } : {}) };
          this.send({ type: "failed", sessionId: id, message: reason });
          throw cause;
        }
      },
      async (parts) => {
        settledResult = await this.run(parts, command);
      },
      () => {
        // 应用退出时被停下的：报 interrupted，主进程留着「在跑」标记（下次打开是「上次被中断」）
        if (this.shuttingDown) settledResult = { ok: false, reason: "shutdown", interrupted: true };
        // 落定先报主进程（清「在跑」标记），再发 idle：renderer 收到 idle 时主进程的账已经结了
        this.deps.settled(id, settledResult);
        this.send({ type: "phase", sessionId: id, phase: "idle" });
      },
    ).catch((cause: unknown) => {
      // open 的失败已经报过 failed：吞掉，不让命令循环再报一遍
      if (cause instanceof MigrationFailed || cause instanceof OpenFailed) return;
      throw cause;
    });
  }

  private async open(library: string, command: OpenCommand): Promise<KernelParts> {
    const note = this.note(command.sessionId);
    note.mode = command.mode;
    const provider = withOpencodeSession(command.provider, command.sessionId);
    note.apiKey = provider.apiKey;
    if (provider.headers === undefined) delete note.headers;
    else note.headers = provider.headers;
    const turnForm = command.type === "continueRun" ? ({ ...command, type: "submit", text: "" } as const) : command;
    const target = await this.deps.pool.target({
      library,
      command: turnForm,
      compaction: {
        enabled: command.compaction?.enabled ?? true,
        reservePercent: command.compaction?.reservePercent ?? COMPACTION_DEFAULT.reservePercent,
      },
    });
    if (!target.ok) throw target.migrationFailed === true ? new MigrationFailed(target.reason) : new OpenFailed(target.reason);
    note.model = target.model;
    let stats = this.stats.get(command.sessionId);
    if (stats === undefined) {
      stats = new KernelStats();
      this.stats.set(command.sessionId, stats);
    }
    const timing: TurnTiming = { echoedAt: null, sawAssistant: false };
    const tracker = new TurnFileTracker(command.cwd);
    const webWatch: WebArtifactWatch = { roots: webScanRoots(command.cwd, command.directories), startedAt: this.now() };
    const adapter = new TranscriptAdapter({ newId: () => randomUUID(), now: () => this.now() });
    let abortRequested = false;
    const sessionId = command.sessionId;
    const statsOf = stats;
    const rounds = new ToolRounds();
    const view = new KernelView(sessionId, adapter, {
      send: (event) => this.send(event),
      now: () => this.now(),
      assistantEnd: () => void this.pushStats(sessionId, target, statsOf),
      toolEnd: (callId) => {
        // 工具结果条目到了也算「准备完」（没走到 beforeTool 就被拒的调用），见 ToolRounds
        rounds.settled(callId);
        void tracker.noteExecutionEnd(callId);
      },
      compactionPlaced: (entry) => {
        this.send({
          type: "compaction",
          sessionId,
          record: {
            role: "compacted",
            id: randomUUID(),
            summary: compactionSummary(entry),
            tokensBefore: statsOf.lastContextTokens ?? 0,
            timestamp: compactionBoundaryTimestamp({ echoedAt: timing.echoedAt, sawAssistant: view.sawAssistant }, this.now()),
          },
        });
        void this.pushStats(sessionId, target, statsOf, true);
      },
    });
    const observation = await target.harness.observeConversation(
      target.conversation.id,
      { advance: (call) => (call.kind === "value" ? view.advance(call.value) : undefined), end: () => undefined },
      BACKGROUND_CONTEXT,
    );
    view.attach(observation.value);
    const intentAbort = new AbortController();
    // 开轮即推一次思考档真值（clamp 后）与支持集：芯片显示的是事实而不是意图（旧内核每轮开机时推的同一个事件）
    this.send({
      type: "thinking",
      sessionId,
      providerId: target.model.provider,
      modelId: target.model.id,
      level: clampThinkingLevel(target.model, command.thinkingLevel),
      supported: getSupportedThinkingLevels(target.model),
    });
    void this.pushStats(sessionId, target, statsOf, true);
    // 主进程要把这条会话的「本子」记进 meta：旧会话是原件路径；新内核里新建的会话没有本子，记 durable 引用
    this.send({ type: "created", sessionId, piSessionFile: command.piSessionFile ?? durableBookRef(sessionId) });
    return {
      target,
      view,
      tracker,
      webWatch,
      timing,
      intentAbort,
      stats: statsOf,
      rounds,
      aborted: () => abortRequested,
      abort: () => {
        abortRequested = true;
        intentAbort.abort();
        void this.abortRun(target);
      },
      dispose: () => {
        abortRequested = true;
        void this.abortRun(target);
      },
      unsubscribe: () => observation.detach(),
    };
  }

  /** 停当前 run（与它的工具、阻塞式压缩）：abortTask，不撤 inbox 里排着的插话 */
  private async abortRun(target: Extract<KernelTarget, { ok: true }>): Promise<void> {
    try {
      const live = await target.harness.snapshot(LiveDoc, target.conversation.id, BACKGROUND_CONTEXT);
      const tasks = [...(live?.run === undefined ? [] : [live.run.taskId]), ...(live?.compactions ?? []).map((status) => status.taskId)];
      for (const task of tasks) await target.harness.abortTask(task, BACKGROUND_CONTEXT);
    } catch (cause) {
      console.error("[kernel] 停止失败", cause);
    }
  }

  private async pushStats(sessionId: string, target: Extract<KernelTarget, { ok: true }>, stats: KernelStats, persist?: true): Promise<void> {
    try {
      const snapshot = await stats.snapshot(target.conversation, target.model.contextWindow);
      this.send({ type: "stats", sessionId, stats: snapshot, ...(persist === true ? { persist } : null) });
    } catch (cause) {
      console.error("[kernel] 读用量失败", sessionId, cause);
    }
  }

  private async run(parts: KernelParts, command: OpenCommand): Promise<KernelTurnResult> {
    const { target, view } = parts;
    const sessionId = command.sessionId;
    const migration = target.migration;
    const outcome = await this.runBody(parts, command).finally(async () => {
      view.turnActive = false;
      await reportFileTurn(sessionId, parts.tracker, parts.webWatch, (event) => this.send(event));
      await this.pushStats(sessionId, target, parts.stats, true);
    });
    // 回合级失败（模型报错、重试耗尽）：挂到这轮没得到回答的话下面；被我们自己停下的轮不报（turn-failure.ts 的同一条规矩）
    if (outcome.status === "unanswered" && !parts.aborted()) {
      const live = await target.harness.snapshot(LiveDoc, target.conversation.id, BACKGROUND_CONTEXT);
      const failure = live?.runFailure;
      if (failure !== undefined && failure.reason !== "aborted") {
        const detail = failure.detail?.trim() || "The model returned an error";
        const message = view.retries > 0 && failure.reason === "model_error" ? `Failed after ${view.retries} retries: ${detail}` : detail;
        this.send({ type: "failed", sessionId, message, turn: true });
      }
    }
    return {
      ok: true,
      conversationId: target.conversation.id,
      migration,
      status: outcome.status === "done" ? "done" : "unanswered",
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
  }

  private async runBody(parts: KernelParts, command: OpenCommand): Promise<TurnOutcome> {
    if (command.type === "compact") return this.compact(parts, command);
    const { target, view } = parts;
    const sessionId = command.sessionId;
    return runTurn(
      command.type === "interrupt" ? { ...command, type: "submit" } : command,
      this.deps.runtime,
      target,
      target.compaction,
      {
        observer: {
          mode: () => this.note(sessionId).mode,
          toolStart: (callId, name, args) => view.toolStart(callId, name, args),
          toolUpdate: (callId, name, partial) => view.toolUpdate(callId, name, partial),
          toolAllowed: (callId, name, input) => parts.tracker.noteAllowed(callId, name, input),
          rounds: parts.rounds,
          echoContinue: (text) => {
            for (const progress of view.userPrompt(splitEchoBlocks(text))) this.send({ type: "progress", sessionId, progress });
            view.noteEcho(text);
          },
        },
        ...(command.type === "continueRun" ? { continueRun: true } : { echo: (images, promptText) => this.echo(parts, command, images, promptText) }),
        inventory: (inventory) => this.send({ type: "contextInventory", sessionId, inventory }),
        admitted: () => {
          view.turnActive = true;
          this.send({ type: "phase", sessionId, phase: "turn" });
        },
      },
    );
  }

  /**
   * 回显 → 意图闸门 → 补记两本账（旧内核 echoAndPrompt 的同一段顺序与函数）。返回实际发给模型的正文；null = 不提交
   * （停止了 / 闸门失败或取消）。
   */
  private async echo(
    parts: KernelParts,
    command: TurnCommand,
    images: Awaited<ReturnType<typeof preparePromptImages>>,
    promptText: string,
  ): Promise<string | null> {
    if (parts.aborted()) return null;
    let turnId = "";
    for (const progress of parts.view.userPrompt(splitEchoBlocks(command.text), images, attachmentBlocks(command.pasted ?? [], command.files ?? []))) {
      if (progress.type === "item_started") {
        parts.timing.echoedAt = progress.item.timestamp;
        if (turnId === "") turnId = progress.item.id;
      }
      this.send({ type: "progress", sessionId: command.sessionId, progress });
    }
    const gate = await runIntentGate(command, parts.intentAbort, turnId === "" ? randomUUID() : turnId, {
      send: (event) => this.send(event),
      confirm: this.deps.intentConfirm,
    });
    if (gate.injection === null || parts.aborted()) return null;
    const finalPrompt = composeIntentPrompt(gate.injection, promptText);
    // 两本账对齐：失败轮留下的 user 尾巴补记进库（旧内核补进 pi 本子），必须在这一句之前
    for (const text of command.backfill ?? []) {
      await parts.target.conversation.submit(
        { type: "write", entry: { kind: "orbita.backfill", model: [{ role: "user", content: [{ type: "text", text }], timestamp: this.now() }] } },
        BACKGROUND_CONTEXT,
      );
      parts.view.noteEcho(text);
    }
    parts.view.noteEcho(finalPrompt);
    return finalPrompt;
  }

  /**
   * 手动压缩（独占的一轮，phase compaction）。旧内核的两项临时调参照搬：思考档关掉（摘要是提取不是推理）、
   * keepRecentTokens 降到 0（用户要压就压，不在内核里再挡一道），压完恢复。
   */
  private async compact(parts: KernelParts, command: CompactCommand): Promise<TurnOutcome> {
    const { target } = parts;
    this.send({ type: "phase", sessionId: command.sessionId, phase: "compaction" });
    const conversation = target.conversation;
    await conversation.configure({ thinkingLevel: "off", compaction: { ...target.compaction, keepRecentTokens: 0 } }, BACKGROUND_CONTEXT);
    try {
      const task = await conversation.compact(command.instructions, BACKGROUND_CONTEXT);
      const outcome = (await target.harness.waitForTask(task, BACKGROUND_CONTEXT)).state.outcome;
      if (outcome.status === "completed") {
        const result = outcome.result as { entryId?: unknown; submissionId?: unknown };
        if (result.entryId === undefined && result.submissionId === undefined) {
          this.send({ type: "failed", sessionId: command.sessionId, message: compactionErrorText("Nothing to compact (session too small)") });
        }
        await conversation.waitForIdle(BACKGROUND_CONTEXT);
        return { status: "done" };
      }
      if (!parts.aborted()) {
        const live = await target.harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
        const reason = live?.compactionFailure?.error ?? outcome.error?.message ?? outcome.status;
        this.send({ type: "failed", sessionId: command.sessionId, message: compactionErrorText(reason) });
      }
      return { status: "unanswered", reason: outcome.status };
    } finally {
      await conversation.configure({ thinkingLevel: command.thinkingLevel, compaction: target.compaction }, BACKGROUND_CONTEXT);
    }
  }

  /**
   * 应用正常退出：停掉全部在跑的轮（保留上下文；下次打开时它们是「上次被中断」，由用户决定继续），等它们收尾。
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const lifecycles = [...this.running.entries()].map(([id, slot]) => {
      abortCycle(this.running, id);
      return slot.lifecycle.catch(() => undefined);
    });
    await Promise.all(lifecycles);
  }
}

/** 迁移旧会话失败：会话回落只读（原件不动） */
class MigrationFailed extends Error {}
/** 开库 / 注册模型失败：这一轮没开起来（已报 failed） */
class OpenFailed extends Error {}
