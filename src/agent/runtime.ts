/**
 * agent runtime —— 跑在 Electron utility 进程里的 pi 宿主。
 *
 * 为什么单独一个进程（guideline §二）：工具结果的大字符串处理与 JSON 序列化会和 UI
 * 抢事件循环；内核崩溃不该带走窗口与未落盘的会话；而且这是最难后补的一刀。
 *
 * 本文件只做三件事：起 pi 的 AgentSession、把它的事件经 TranscriptAdapter 翻成
 * pi-protocol 的 progress、经 parentPort 发回主进程。**不碰 UI，不碰持久化路径策略。**
 */
import { randomUUID } from "node:crypto";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../shared/permission.ts";
import {
  registerAndResolveModel,
  toBuiltinModel,
} from "./model-registration.ts";
import {
  createToolCallGate,
  describePermissionMode,
  type PiExtensionApi,
} from "./permission.ts";
import { TranscriptAdapter, type AdaptableEvent } from "./transcript-adapter.ts";
import { normalizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from "./title.ts";
import { planBranchCut } from "./branch-cut.ts";

import { preferIPv4 } from "../shared/dial-v4.ts";

// pi-ai 的模型调用与 main 同一个坑（同一台机器、同一个全局 fetch）
preferIPv4();

type ParentPortLike = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
};

const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  console.error("[agent-runtime] 没有 parentPort——本文件只能作为 Electron utility 进程运行");
  process.exit(1);
}

function send(event: AgentEvent): void {
  parentPort?.postMessage(event);
}

/**
 * 用量快照（token / 花费 / 上下文余量）推给 UI。pi 的本子从盘加载全部 usage 记录，
 * 所以唤醒的旧会话拿到的是跨重启累计值。推送粒度与 pi 的数据粒度对齐——usage
 * 跟着每次 LLM 响应落地，所以每条 assistant 消息完成（message_end）推一次；
 * 建会话后、压缩结束、整轮落定再各兜一次。单条消息流式期间 usage 还没回来，不推。
 *
 * **只搬界面要显示的那几项**（D1）：显式列出而不是整个对象透传，契约声明了搬哪几项，
 * pi 以后加字段时不该悄悄从这里漏进 renderer。
 *
 * `persist` 只在「这一轮真的告一段落」的时机带上（settled / 压缩结束 / 建会话）：
 * 界面要跟着每条消息走，而磁盘只需要上一次跑完时的快照。不分的话一轮 30 个工具就是 30 次原子写。
 *
 * 读不出来就安静跳过：用量是给人看的一行字，不该由它决定一轮对话成不成立。
 */
function pushStats(sessionId: string, session: AgentSession, persist?: true): void {
  try {
    const stats = session.getSessionStats();
    const usage = stats.contextUsage;
    send({
      type: "stats",
      sessionId,
      stats: {
        tokens: {
          input: stats.tokens.input,
          output: stats.tokens.output,
          cacheRead: stats.tokens.cacheRead,
          cacheWrite: stats.tokens.cacheWrite,
          total: stats.tokens.total,
        },
        cost: stats.cost,
        contextUsage:
          usage === undefined
            ? null
            : {
                tokens: usage.tokens ?? null,
                contextWindow: usage.contextWindow,
                percent: usage.percent ?? null,
              },
      },
      ...(persist === true ? { persist } : null),
    });
  } catch (cause) {
    console.error("[agent] 读用量失败", sessionId, cause);
  }
}

/**
 * 手动压缩的两项临时调参，完事恢复（wafo 2026-09-03 裁决：用户意愿优先）。
 *
 * 1. **思考档按到 off**。压缩本来就是全应用最重的一次请求——pi 给摘要另起
 *    sessionId 并 `cacheRetention: "none"`（compaction.ts:571），没有 prompt cache
 *    可用，要把整段历史从头 prefill；而 compaction.ts:549 又把会话当前的思考档
 *    原样带进去——模型先吐一大段 reasoning 再吐摘要。摘要是结构化提取不是推理
 *    （pi 的 system prompt 自己写着 ONLY output the structured summary），
 *    这种活儿不需要先想一想。
 *
 * 2. **keepRecentTokens 临时降到 0**。pi 的 prepareCompaction 按「保留最近
 *    20k token」找切点，找不到可摘要的消息就抛 "Nothing to compact (session
 *    too small)"。UI 已经改成两段式确认（价值不大都让用户自己决定），内核侧
 *    不该再有第二道门把用户意愿挡回去。压完恢复原值——自动压缩的节奏不受影响。
 *
 * 只盖得住手动压缩；自动压缩（threshold / overflow）走 pi 自己的循环，不经过这里。
 */
async function withManualCompactionTuning<T>(session: AgentSession, run: () => Promise<T>): Promise<T> {
  const beforeThinking = session.thinkingLevel;
  const beforeCompaction = session.settingsManager.getCompactionSettings();
  session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 0 } });
  if (beforeThinking !== "off") session.setThinkingLevel("off");
  // 思考关没关在界面上感知不出来——落一条日志给验收用
  console.error(
    `[compact] thinking ${beforeThinking} → off，keepRecentTokens → 0（原 ${beforeCompaction.keepRecentTokens ?? "默认 20000"}）`,
  );
  try {
    return await run();
  } finally {
    session.settingsManager.applyOverrides({ compaction: beforeCompaction });
    session.setThinkingLevel(beforeThinking);
    console.error(`[compact] 完成，thinking 恢复 ${beforeThinking}，keepRecentTokens 恢复原值`);
  }
}

/**
 * 生成会话标题（C-3）：一次独立的 `completeSimple` 小调用，用会话当前模型。
 * 与当前轮并发跑，不阻塞对话；成功（且模型没答 none）才发 `title` 事件。
 * 失败一律静默——标题是易耗品，不该有任何一条报错通路；门禁（meta 的
 * titleSource 仍是 derived）在主进程，这里不发事件它自然不变，下一条用户
 * 消息就再试一次。不做取消：调用几秒量级，进程退出自然带走，会话被删时
 * 主进程落盘侧读不到 meta 悄悄不做。
 * ponytail: maxTokens 1024 是硬上限不是目标——后端无视思考抑制时标记仍可达
 * （oh-my-pi issue #4355 同款）；本仓锁的 pi-ai 0.84.3 没有 disableReasoning。
 */
/** 标题调用的硬上限。标题是易耗品，宁可超时重试也不挂着占住单飞守卫。 */
const TITLE_TIMEOUT_MS = 30_000;

async function generateSessionTitle(live: LiveSession, sessionId: string, text: string): Promise<void> {
  if (live.titleInFlight) return;
  live.titleInFlight = true;
  try {
    const model = live.session.model;
    if (model === undefined) return;
    // **30 秒硬超时必须有**：标题与当前轮并发抢 provider，请求可能被网关挂住
    // 不返回——没有超时的话 titleInFlight 永远不放，这条会话之后的所有重试
    // 都被在途守卫吞掉（真实事故：一条会话 17 条消息一次标题都没成）。
    const response = await completeSimple(
      model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: text, timestamp: Date.now() }],
      },
      {
        apiKey: live.apiKey,
        maxTokens: 1024,
        timeoutMs: TITLE_TIMEOUT_MS,
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        ...(live.headers ? { headers: live.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      console.error(`[title] ${model.id} 响应错误：`, response.errorMessage);
      return;
    }
    let output = "";
    for (const block of response.content) {
      if (block.type === "text") output += block.text;
    }
    const title = normalizeGeneratedTitle(output);
    if (title !== null) {
      send({ type: "title", sessionId, title });
    } else {
      // 失败本就静默（侧栏保留首句截断），但原因必须落到 dev 终端，
      // 否则「为什么大多数会话没有标题」无从查起
      console.warn(
        `[title] ${model.id} 放弃（none/空/超长），原文前 120 字：${JSON.stringify(output.slice(0, 120))}`,
      );
    }
  } catch (cause) {
    console.error("[title] 生成失败：", cause);
  } finally {
    live.titleInFlight = false;
  }
}

/**
 * 会话内换模型（C-4）。注册 + 解析目标模型（与 createSession 同一条装配路径），
 * 然后 `session.setModel`——pi 自己校验 auth、把 model_change 落进它的本子、
 * clamp thinking。**不传 persist**：全局默认模型是 pi TUI 的概念，会话内切换
 * 不该改写用户磁盘上的全局设置。生效边界是 pi 定的：当前轮用旧模型跑完
 * （run 启动时快照），下一次 prompt 起新模型。
 */
async function setSessionModel(
  live: LiveSession,
  sessionId: string,
  provider: Extract<AgentCommand, { type: "setModel" }>["provider"],
  modelId: string,
): Promise<void> {
  try {
    const model = registerAndResolveModel(live.session.modelRuntime, provider, modelId);
    if (model === undefined) {
      throw new Error(`unknown model "${provider.id}/${modelId}"`);
    }
    await live.session.setModel(model);
    send({ type: "model", sessionId, providerId: model.provider, modelId: model.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // 操作级失败（无 key / 未知模型）：红字报给用户，chip 与 meta 都不动
    send({ type: "failed", sessionId, message });
  }
}

/** 一个 session 的运行时状态。N 个 session 共用本进程（Q8：多 session 形状从第一天就有）。 */
interface LiveSession {
  session: AgentSession;
  adapter: TranscriptAdapter;
  unsubscribe: () => void;
  mode: PermissionMode;
  /**
   * 已在本地回显（adapter.userPrompt 造过 item）的用户消息文本。pi 随后 emit 的
   * user `message_start` 是回声，命中即丢弃；**未命中**的一定是排队消息的投递
   * （正常发送永远先 userPrompt，排队发送要等投递才 message_start）。
   * ponytail: 按文本对账——两条同文本消息一正常一排队的极端场景会误判，与 pi
   * 内部的 queue 对账同款天花板。
   */
  echoed: Set<string>;
  /** 标题调用（C-3）的鉴权面——provider 的 key 与自定义头，create 命令带进来的 */
  apiKey: string;
  headers?: Record<string, string>;
  /** 标题在途标记：连发两条消息也只生成一次，失败后下一条自然重试 */
  titleInFlight: boolean;
}

const sessions = new Map<string, LiveSession>();

/** 等待用户回答的审批请求。key 是 requestId——一次工具调用一个。 */
const pendingPermissions = new Map<string, (answer: PermissionAnswer) => void>();

/**
 * 每轮重讲的工具使用指引。bash 的 schema 暴露了可选 `timeout`（秒），模型会自作主张
 * 给大扫描带上 60 秒这种小值，把 node_modules 级别的正常慢命令拦腰杀掉（实测：
 * `grep -r node_modules/` + `timeout:60` → "Command timed out after 60 seconds"）。
 * 短命令不受影响，只要求慢命令别自己设短超时。
 */
const TOOL_GUIDELINES =
  "跑可能耗时的命令（大目录/全仓搜索、依赖安装、构建、测试）时，不要给 bash/powershell 传 timeout 参数，或至少设 300 秒以上——Windows 上扫大目录本来就慢，短超时会把正常的慢命令拦腰杀掉。";

/**
 * 向 UI 请示。**没有超时**：用户可能去泡杯咖啡再回来点，
 * 而 pi 的工具执行本来就允许长时间等待（abort 走的是另一条路）。
 */
function askPermission(sessionId: string) {
  return (request: { toolCallId: string; toolName: string; input: unknown }) =>
    new Promise<PermissionAnswer>((resolve) => {
      const requestId = `${sessionId}:${request.toolCallId}`;
      pendingPermissions.set(requestId, resolve);
      send({
        type: "permission",
        sessionId,
        requestId,
        toolName: request.toolName,
        input: request.input,
      });
    });
}

/**
 * AgentSession 的事件里，需要翻给 renderer 的那几种；其余（压缩、重试、排队）等后续 slice。
 *
 * 三个 `tool_execution_*` **就在 `AgentEvent` 里**（pi-agent-core `types.d.ts`），
 * `session.subscribe()` 直接能拿到——工具结果不需要写 pi 扩展。
 * 以前不放行它们的后果是：屏幕上只看得到「调用了 bash」，看不到它返回了什么，
 * `.jsonl` 里也没有——**那是记录不完整，不只是界面少一块**。
 */
const ADAPTABLE_TYPES = new Set([
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
]);

function asAdaptable(event: { type: string }): AdaptableEvent | null {
  return ADAPTABLE_TYPES.has(event.type) ? (event as AdaptableEvent) : null;
}

async function createSession(command: Extract<AgentCommand, { type: "create" }>): Promise<void> {
  // **双开保险丝**：同 id 还活着就拒绝，绝不覆盖——覆盖会漏掉旧 session 的退订，
  // 还让两个 AgentSession 写同一份 pi JSONL（记录写坏，修不回来）。
  if (sessions.has(command.sessionId)) {
    throw new Error(`session ${command.sessionId} is already running`);
  }
  // provider 经内存注册交给 pi，不写 models.json / auth.json（提案 §2.2「内核读 Provider 不读文件」）
  const modelRuntime = await ModelRuntime.create({});
  /**
   * **选中的模型必须显式解析并传给会话**。不传的话 pi 自己挑默认模型——实测会挑到
   * 一个完全不相干的 provider（UI 里选的从来不是会话里跑的那个，存量 bug）。
   * 注册与解析的完整规则（auth 面 → 补注册兜底）抽在 model-registration，
   * 会话内换模型（C-4）走同一条路径——两处的「能不能用某个模型」必须是一套真相。
   */
  const model = registerAndResolveModel(modelRuntime, command.provider, command.modelId);
  if (model === undefined) {
    throw new Error(`unknown model "${command.provider.id}/${command.modelId}"`);
  }

  // 审批走 pi 官方的 `tool_call` 扩展钩子：block 即拒绝，原地改 input 即改写入参。
  // 内建工具默认全开，不需要我们自己装配。
  const currentMode = () => sessions.get(command.sessionId)?.mode ?? "plan";
  const gate = createToolCallGate(currentMode, askPermission(command.sessionId));
  const services = await createAgentSessionServices({
    cwd: command.cwd,
    modelRuntime,
    resourceLoaderOptions: {
      extensionFactories: [
        {
          name: "orbita-permission",
          hidden: true,
          factory: (pi: PiExtensionApi) => {
            pi.on("tool_call", (event) => gate(event));
            // **每一轮都重讲一遍当前模式**。`before_agent_start` 逐轮触发，所以中途
            // 切模式下一轮就生效；只在建会话时讲一次的话，切了模式模型还按旧的答。
            pi.on("before_agent_start", (event) => ({
              systemPrompt: `${event.systemPrompt}\n\n${describePermissionMode(currentMode())}\n\n${TOOL_GUIDELINES}`,
            }));
          },
        },
      ],
    },
  });
  /**
   * 重试节奏由本应用自持：**固定 5 秒一次、最多 3 次**（pi 的指数退避已用 patch 拍平，
   * 见 patches/README.md）。不显式覆盖的话会静默继承用户 pi TUI 的全局
   * `~/.pi/agent/settings.json`——那是另一个应用的配置，不该左右这里等多久。
   * applyOverrides 只改内存、不落盘，不会写回用户的全局设置文件。
   */
  services.settingsManager.applyOverrides({ retry: { maxRetries: 3, baseDelayMs: 5000 } });
  /**
   * **pi 存它自己的本子**（guideline §四，2026-08-26 修订）。
   * 续会话是把这份文件还给 pi，而不是我们把历史重讲一遍——
   * 被否决的反向适配方案与理由都写在那一节。
   *
   * 目录由主进程给（`piSessionDir`）：runtime 不做路径策略决定。
   * 打不开就退回新建——**宁可开一条没有前文的会话，也不要整个建不起来**：
   * 用户至少还能接着说话，而不是对着一条打不开的会话干瞪眼。
   */
  const sessionManager = openOrCreate(command);
  const { session } = await createAgentSessionFromServices({ services, sessionManager, model });
  /**
   * 排队整批投递：多条排队在一个注入点全部给模型、一次回应（Claude Code 同款）。
   * pi 默认 one-at-a-time（每条各起一轮）会把互相修正的碎片补充——「先跑」「别跑」
   * 「还是跑」——割裂成多轮回应，又慢又贵。直设内存属性而不走 setSteeringMode：
   * 那个会写用户磁盘上的 pi 全局设置（跨出本会话的副作用，不能带）。
   * 该值只在 TUI 的 reload() 里会被设置文件覆盖回来，本 runtime 不调 reload。
   */
  session.agent.steeringMode = "all";
  session.agent.followUpMode = "all";

  const adapter = new TranscriptAdapter({ newId: () => randomUUID(), now: () => Date.now() });
  const echoed = new Set<string>();
  const unsubscribe = session.subscribe((event) => {
    const adaptable = asAdaptable(event);
    if (adaptable) {
      // 排队消息在这里「迟到显形」：本地没回显过的 user message_start 一定是 pi 从
      // 队列里投递出来的，当场造 item（显示 + 落盘同步发生——排队期间两边本子都没写过）。
      if (adaptable.type === "message_start" && adaptable.message.role === "user") {
        const text = userText(adaptable.message.content);
        if (echoed.has(text)) {
          echoed.delete(text);
        } else if (text !== "") {
          for (const progress of adapter.userPrompt(text)) {
            send({ type: "progress", sessionId: command.sessionId, progress });
          }
        }
      }
      for (const progress of adapter.apply(adaptable)) {
        send({ type: "progress", sessionId: command.sessionId, progress });
      }
      // usage 与这条 LLM 响应一起落账：消息完成即推，轮内多次工具往返时数字逐条跳。
      // 一轮多推几个几百字节的小对象，比起上面每条 delta 一帧的流式转发可忽略。
      if (event.type === "message_end") pushStats(command.sessionId, session);
      return;
    }
    if (event.type === "agent_start") send({ type: "phase", sessionId: command.sessionId, phase: "turn" });
    // 排队快照原样翻译：入队 / 投递 / 清队后 pi 都重发整份，renderer 覆盖槽即可
    if (event.type === "agent_settled") {
      send({ type: "phase", sessionId: command.sessionId, phase: "idle" });
      // 整轮落定兜一次：接住最后一条消息之后落账的用量（toolResult 计费）与 abort 边角。
      // **这一帧落盘**：它就是 `SessionMeta.stats` 说的「上一次跑完时的快照」
      pushStats(command.sessionId, session, true);
    }
    // 压缩是一次真实的 LLM 调用，期间必须显示忙碌而不是「可以说话」；
    // renderer 按 phase === "compaction" 显示居中的压缩进行态。
    if (event.type === "compaction_start") {
      send({ type: "phase", sessionId: command.sessionId, phase: "compaction" });
    }
    if (event.type === "compaction_end") {
      send({ type: "phase", sessionId: command.sessionId, phase: "idle" });
      // aborted / 无 result 的压缩（用户中止、摘要失败）不留界碑——历史没有被折叠
      if (!event.aborted && event.result !== undefined) {
        send({
          type: "compaction",
          sessionId: command.sessionId,
          record: {
            role: "compacted",
            id: randomUUID(),
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            tokensAfter: event.result.estimatedTokensAfter,
            timestamp: Date.now(),
          },
        });
      }
      // 失败（手动与自动同一条路）唯一的报错出口；pi 会给消息加
      // "Compaction failed: " 前缀，翻译前剥掉
      if (!event.aborted && event.errorMessage !== undefined) {
        send({
          type: "failed",
          sessionId: command.sessionId,
          message: compactionErrorText(event.errorMessage.replace(/^Compaction failed: /, "")),
        });
      }
      // 压缩后 contextUsage.tokens 变 null（上一次 usage 反映的是压缩前的上下文，不可信），
      // 推一次让 UI 如实显示未知；token / 花费总额不受压缩影响、继续累计。
      // **落盘**：重开应用时该看到的就是「压缩过、上下文占用未知」这个真实状态
      pushStats(command.sessionId, session, true);
    }
    // 自动重试：对话主链路（auto_retry）与压缩/摘要调用（summarization_retry）共用这份翻译。
    // pi 只经事件暴露、不落盘。等待结束时 pi 会再发一次 agent_start（翻回 phase "turn"），
    // renderer 靠它清重试槽——不依赖下面 status: null 的到达，事件丢了也自愈。
    if (event.type === "auto_retry_start" || event.type === "summarization_retry_scheduled") {
      send({
        type: "retry",
        sessionId: command.sessionId,
        status: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          startedAt: Date.now(),
          errorMessage: event.errorMessage,
        },
      });
    }
    if (
      event.type === "auto_retry_end" ||
      event.type === "summarization_retry_attempt_start" ||
      event.type === "summarization_retry_finished"
    ) {
      send({ type: "retry", sessionId: command.sessionId, status: null });
      // 重试耗尽是回合级终局，沿用压缩失败的同一条报错通路（failed → 红色提示）。
      // "Retry cancelled" 是用户主动点停止（pi 固定字面量，精确锁版本稳定）：自己按的，不报。
      // turn 标记让 renderer 把它标注到对话里——挂在这轮没送出去的消息下面，
      // 而不是输入框上方的全局红字（用户裁决：失败属于那句话，不属于输入框）。
      if (
        event.type === "auto_retry_end" &&
        !event.success &&
        event.finalError !== "Retry cancelled"
      ) {
        send({
          type: "failed",
          sessionId: command.sessionId,
          message: `重试 ${event.attempt} 次后仍失败：${event.finalError ?? "未知"}`,
          turn: true,
        });
      }
    }
  });

  sessions.set(command.sessionId, {
    session,
    adapter,
    unsubscribe,
    mode: command.mode,
    echoed,
    apiKey: command.provider.apiKey,
    ...(command.provider.headers ? { headers: command.provider.headers } : {}),
    titleInFlight: false,
  });
  // 建会话即推一次：新会话给零值；唤醒的旧会话立刻给真累计——余量不用等第一轮跑完。
  // **落盘**：唤醒时 pi 给的才是跨重启的真累计，比我们上次存的快照新，当场就该校准
  pushStats(command.sessionId, session, true);
  send({
    type: "created",
    sessionId: command.sessionId,
    // 主进程要把它记进会话 meta，否则下次就找不回这本子了
    piSessionFile: sessionManager.getSessionFile() ?? null,
  });
}

function openOrCreate(command: Extract<AgentCommand, { type: "create" }>): SessionManager {
  if (command.piSessionFile !== undefined) {
    try {
      return SessionManager.open(command.piSessionFile, command.piSessionDir, command.cwd);
    } catch (error) {
      console.error("[agent-runtime] 打不开 pi 的 session 文件，退回新建", error);
    }
  }
  return SessionManager.create(command.cwd, command.piSessionDir);
}

/**
 * pi 侧分支（C-2）：开一个**一次性的** SessionManager 读源本子，对账后用 pi 自己的
 * `createBranchedSession` 裁新文件。绝不碰活着的 manager——那个方法会把实例原地
 * 换绑到新文件上，误用在活会话的 manager 上，后续追加就写进分支文件了（事故形状）。
 * 源会话正在跑也没关系：只读源文件、只写新文件，追加与读取互不干扰。
 */
async function branchPiSession(command: Extract<AgentCommand, { type: "branch" }>): Promise<void> {
  const manager = SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd);
  const targetId = planBranchCut(manager.getEntries(), command.roles);
  const branchFile = manager.createBranchedSession(targetId);
  if (branchFile === undefined) throw new Error("pi 没有产出分支文件");
  // 复用 created 事件通路：主进程对 branch 与 create 用同一条等待逻辑
  send({ type: "created", sessionId: command.sessionId, piSessionFile: branchFile });
}

/**
 * pi 内建 provider 目录 → 我们的 BuiltinProvider。
 * agentDir 指向一个不存在的路径：只要 pi 的内建目录，不去读用户的 ~/.pi/agent 配置。
 */
async function listBuiltins(): Promise<void> {
  const runtime = await ModelRuntime.create({});
  const providers = runtime.getProviders().map((provider) => {
    // 注意：models 是方法 getModels() 不是属性；api / baseUrl 也长在 Model 上而非 Provider 上。
    const models = provider.getModels();
    const first = models[0];
    return {
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl ?? first?.baseUrl ?? "",
      api: String(first?.api ?? "openai-completions"),
      models: models.map(toBuiltinModel),
    };
  });
  send({ type: "builtins", providers });
}

async function handle(command: AgentCommand): Promise<void> {
  if (command.type === "listBuiltins") {
    await listBuiltins();
    return;
  }
  if (command.type === "permissionAnswer") {
    // 回答到得比请求晚是正常的；请求早已不在（abort 等）就丢弃，不报错
    pendingPermissions.get(command.requestId)?.(command.answer);
    pendingPermissions.delete(command.requestId);
    return;
  }

  if (command.type === "create") {
    await createSession(command);
    return;
  }

  // 分支带的是「新会话的 id」，此刻还不在 sessions 表里——必须在下面的
  // unknown session 检查之前处理
  if (command.type === "branch") {
    await branchPiSession(command);
    return;
  }

  if (command.type === "dispose") {
    // 删除会话。**没建过的也走这里**（删除一条从未唤醒的会话是正常路径）——
    // 没有就没什么可释放的，静默返回，不能走下面那个「unknown session」的 throw。
    const dying = sessions.get(command.sessionId);
    if (dying) {
      dying.unsubscribe();
      // pi 的 dispose 自己会 abort 全部在飞工作（当前轮 / 重试 / 压缩 / 本会话的 bash），
      // 正在跑的会话被删也成立，无需先 abort。
      dying.session.dispose();
      sessions.delete(command.sessionId);
    }
    // 审批 resolve 函数不随会话一起删的话，会把已销毁会话的工具执行闭包整条钉在内存里
    for (const key of pendingPermissions.keys()) {
      if (key.startsWith(`${command.sessionId}:`)) pendingPermissions.delete(key);
    }
    return;
  }

  const live = sessions.get(command.sessionId);
  if (!live) throw new Error(`unknown session ${command.sessionId}`);

  if (command.type === "setMode") {
    live.mode = command.mode;
    return;
  }
  if (command.type === "setModel") {
    // 会话内换模型（C-4）。fire-and-forget：成功经 `model` 事件、失败经 `failed`
    // 事件回传，主进程与 renderer 都靠事件对齐，这一跳不等结果。
    void setSessionModel(live, command.sessionId, command.provider, command.modelId);
    return;
  }
  if (command.type === "generateTitle") {
    // 发送方（主进程）已做过 titleSource 门禁；fire-and-forget，不拖慢这一跳
    void generateSessionTitle(live, command.sessionId, command.text);
    return;
  }
  if (command.type === "submit") {
    // expandPromptTemplates 关掉：展开会改写文本，破坏下面按文本做的回声对账；
    // 且本仓没有 skill / template / 斜杠命令的 UI，展开本就无对象。
    if (live.session.isStreaming) {
      // 运行中：进 followUp 队列，本轮结束后投递。**不本地回显**——排队期间可取消，
      // 取消就当没说过（两边本子都没写过）；投递时经 user message_start 迟到显形。
      await live.session.prompt(command.text, {
        streamingBehavior: "followUp",
        expandPromptTemplates: false,
      });
      return;
    }
    // 用户消息先落地再发给模型——不等模型回，UI 立刻看得到自己刚说的话。
    // echoed 记一笔：pi 随后 emit 的 message_start 是这条的回声，别重复显示。
    live.echoed.add(command.text);
    for (const progress of live.adapter.userPrompt(command.text)) {
      send({ type: "progress", sessionId: command.sessionId, progress });
    }
    await live.session.prompt(command.text, { expandPromptTemplates: false });
    return;
  }
  if (command.type === "interrupt") {
    // 队列已经在 renderer 一侧（见 docs/plans/2026-09-06-排队队列所有权收回.md），
    // 这里只做两件事：停下正在跑的这一轮，把这句话作为新一轮发出去。
    // 不碰 pi 的 steering/followUp——那正是这次要断掉的耦合。
    if (live.session.isStreaming) await live.session.abort();
    live.echoed.add(command.text);
    for (const progress of live.adapter.userPrompt(command.text)) {
      send({ type: "progress", sessionId: command.sessionId, progress });
    }
    await live.session.prompt(command.text, { expandPromptTemplates: false });
    return;
  }
  if (command.type === "abort") {
    // 停止只停当前轮：排队消息滞留在 pi 队列（idle 下的合法状态），下次发送时
    // loop 自动带上投递。不 clearQueue——用户裁决：排队是用户的意图，停止不该替他放弃。
    live.session.abort();
    return;
  }
  if (command.type === "compact") {
    // 手动压缩。pi 的 compact() 内部先 abort 当前这一轮；忙碌态、界碑、失败提示
    // 全走 compaction_start / compaction_end 事件那条已接好的链——compact() 起来
    // 之后 compaction_end 必然到（pi 在自己的 catch 里先发事件再 rethrow），
    // 这里只吞 rejection 防 unhandled。
    // ponytail: 若 pi 未来在 compaction_start 之前抛错，这里会静默——届时补个前置标志位
    void withManualCompactionTuning(live.session, () =>
      live.session.compact(command.instructions),
    ).catch(() => {});
    return;
  }
  // 穷尽性检查：AgentCommand 加了新分支而这里没接，编译期就报——
  // 曾经这里是无 if 的兜底（新命令会静默销毁会话），那是事故的形状
  command satisfies never;
}

/**
 * 从 user 消息的 content 块提取纯文本，供回声对账用。只认 text 块——
 * 与 adapter.userPrompt 造 item 的文本同一来源（submit 只发纯文本）。
 */
function userText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * pi 的两种「压不了」是预期拒绝而不是故障（见 compaction.js prepareCompaction 的守卫），
 * 直接透传英文会让人以为系统坏了；其余报错照原样走。
 */
function compactionErrorText(raw: string): string {
  if (raw === "Already compacted") {
    return "已经压缩过了，上次压缩之后还没有新对话——继续聊一轮再压";
  }
  if (raw === "Nothing to compact (session too small)") {
    return "这个会话的内容还太少，没有值得压缩的上下文";
  }
  return raw;
}

parentPort.on("message", (event) => {
  const command = event.data as AgentCommand;
  void handle(command).catch((error: unknown) => {
    send({
      type: "failed",
      sessionId: "sessionId" in command ? command.sessionId : null,
      message: error instanceof Error ? error.message : String(error),
    });
  });
});
parentPort.start?.();
send({ type: "ready" });
// 目录不依赖任何 session，启动即报——设置面不必为了填个下拉框等一次往返
void listBuiltins().catch(() => undefined);
