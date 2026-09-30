/**
 * agent runtime —— 跑在 Electron utility 进程里的 pi 宿主。
 *
 * 为什么单独一个进程（guideline §二）：工具结果的大字符串处理与 JSON 序列化会和 UI
 * 抢事件循环；内核崩溃不该带走窗口与未落盘的会话；而且这是最难后补的一刀。
 *
 * **pi 只当无状态循环**（B2，2026-09-11）：每轮 open → 跑 → dispose，
 * 不跨轮持有 AgentSession 对象。「对象在不在」这个问题消失，只剩「在不在跑」，
 * 由 `running` 按真值回答；跨轮要记住的东西（权限档、回声对账、标题鉴权面）
 * 全在 `ledger`——它不持有任何 pi 对象。prompt cache 不受影响：缓存在 provider
 * 服务端按请求前缀命中，与客户端是否持有对象无关。
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
import type { AgentCommand, AgentEvent, ProviderSecrets } from "../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../shared/permission.ts";
import {
  registerAndResolveModel,
  toBuiltinProvider,
  type PiModel,
} from "./model-registration.ts";
import {
  createToolCallGate,
  describePermissionMode,
  type PiExtensionApi,
} from "./permission.ts";
import { TranscriptAdapter, type AdaptableEvent } from "./transcript-adapter.ts";
import { forModel, preparePromptImages } from "./prompt-images.ts";
import { attachmentBlocks, composePromptText } from "../shared/prompt-attachments.ts";
import { QUOTE_GUIDELINE } from "../shared/quote.ts";
import { abortCycle, killCycle, startCycle, type CycleSlot } from "./turn-cycle.ts";
import { createTurnFailureTracker } from "./turn-failure.ts";
import { normalizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from "./title.ts";
import { GREETING_SYSTEM_PROMPT, greetingPrompt, parseGreetingReply } from "./greeting-check.ts";
import { planBranchCut } from "./branch-cut.ts";
import { revertPiBook, undoPiBook } from "./pi-book-edit.ts";
import { TurnFileTracker } from "./file-tracker.ts";
import { gitAttributionGuideline } from "./git-attribution.ts";
import { createChannelTools, describeChannelRole } from "./channel-tools.ts";
import { describeDirectories } from "./directories-prompt.ts";
import { McpHub } from "./mcp.ts";
import { createImageTools } from "./image-tools.ts";
import { createDocxTools } from "./docx-tools.ts";
import { createPdfTools } from "./pdf-tools.ts";
import { RequestBroker } from "./request-broker.ts";
import { createStoreTools, STORE_TOOLS_GUIDELINES } from "./store-tools.ts";
import { createTaskTools } from "./task-tools.ts";
import { createBrowserTools } from "./browser-tools.ts";
import {
  COMPACTION_DEFAULT,
} from "../shared/settings.ts";
import {
  compactionBoundaryTimestamp,
  compactionKeepRecentTokens,
  compactionReserveTokens,
  type TurnTiming,
} from "./compaction-settings.ts";

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
 * 开机后、压缩结束、整轮落定再各兜一次。单条消息流式期间 usage 还没回来，不推。
 *
 * **只搬界面要显示的那几项**（D1）：显式列出而不是整个对象透传，契约声明了搬哪几项，
 * pi 以后加字段时不该悄悄从这里漏进 renderer。
 *
 * `persist` 只在「这一轮真的告一段落」的时机带上（settled / 压缩结束 / 开机）：
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
 * 轮落定的文件账上报：主进程写快照 blob、落 FileTurnRecord 并广播给轮尾卡片。
 * 没有改动的轮不发（不落空记录）；报失败只记日志——快照是回退能力的代价面，
 * 不是对话的依赖面，坏一条日志好过砸一轮对话。
 */
async function reportFileTurn(sessionId: string, tracker: TurnFileTracker): Promise<void> {
  try {
    const changes = await tracker.finalize();
    if (changes.length > 0) send({ type: "fileTurn", sessionId, changes });
  } catch (cause) {
    console.error("[agent] 轮尾文件账没报出去（回退会缺这一轮的快照）", sessionId, cause);
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
 * 家务活模型（起名等小活专用）的鉴权面。**密钥不能沿用账本里的**——账本里那把是会话当前
 * provider 的，拿它去调另一家只会 401。
 */
interface ResolvedChoreModel {
  model: PiModel;
  apiKey: string;
  headers?: Record<string, string>;
}

/**
 * 解析家务活模型（设置里的 choreModel，主进程已把密钥面装配好）。
 * 自建一次性 ModelRuntime 走同一套「注册 + 解析」（同 setLedgerModel）：
 * 「能不能用某个模型」在本仓只应该有一套真相。
 * 解不出来返回 null，由调用方退回会话模型——用户删了那家 provider 不该
 * 连带把标题停掉。
 */
async function resolveChoreModel(
  payload: NonNullable<Extract<AgentCommand, { type: "generateTitle" }>["model"]>,
): Promise<ResolvedChoreModel | null> {
  try {
    const runtime = await ModelRuntime.create({});
    const model = registerAndResolveModel(runtime, payload.provider, payload.modelId);
    if (model === undefined) {
      console.warn(`[title] 指定的 ${payload.provider.id}/${payload.modelId} 解析不到，退回会话模型`);
      return null;
    }
    return {
      model,
      apiKey: payload.provider.apiKey,
      ...(payload.provider.headers ? { headers: payload.provider.headers } : {}),
    };
  } catch (cause) {
    console.warn("[title] 指定模型装配失败，退回会话模型：", cause);
    return null;
  }
}

/** 「只随手发了一句」检查一批的硬上限（主进程那头 2 分钟兜底，这里先放手） */
const GREETING_TIMEOUT_MS = 90_000;

/**
 * 迁移的「只随手发了一句 hi / test」检查（greeting-check.ts）：一次独立的 `completeSimple`，
 * 模型与密钥面由主进程装好（子会话模型或兜底模型）。结果经 `greetingsClassified` 回执；
 * 模型解不出、调用出错、回复读不懂都回 null 并带原因——用户在页面上等着这一步，失败要说出来。
 */
async function classifyGreetings(command: Extract<AgentCommand, { type: "classifyGreetings" }>): Promise<void> {
  const fail = (error: string): void => {
    send({ type: "greetingsClassified", requestId: command.requestId, throwaway: null, error });
  };
  try {
    const runtime = await ModelRuntime.create({});
    const model = registerAndResolveModel(runtime, command.provider, command.modelId);
    if (model === undefined) {
      fail(`unknown model "${command.provider.id}/${command.modelId}"`);
      return;
    }
    const response = await completeSimple(
      model,
      {
        systemPrompt: GREETING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: greetingPrompt(command.messages), timestamp: Date.now() }],
      },
      {
        apiKey: command.provider.apiKey,
        maxTokens: 2048,
        timeoutMs: GREETING_TIMEOUT_MS,
        signal: AbortSignal.timeout(GREETING_TIMEOUT_MS),
        ...(command.provider.headers ? { headers: command.provider.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      fail(response.errorMessage ?? `${model.id} returned an error`);
      return;
    }
    let output = "";
    for (const block of response.content) {
      if (block.type === "text") output += block.text;
    }
    const throwaway = parseGreetingReply(output, command.messages.length);
    if (throwaway === null) {
      console.warn(`[greetings] ${model.id} 的回复读不懂，原文前 200 字：${JSON.stringify(output.slice(0, 200))}`);
      fail(`${model.id}'s reply couldn't be read`);
      return;
    }
    send({ type: "greetingsClassified", requestId: command.requestId, throwaway });
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * 生成会话标题（C-3）：一次独立的 `completeSimple` 小调用。默认用会话当前模型；
 * 用户在设置里指了家务活模型就用那一个（连同它自己的密钥与自定义头）。
 * 与当前轮并发跑（主进程在 submit 后立刻发本命令，轮还在 `running` 里），
 * 不阻塞对话；成功（且模型没答 none）才发 `title` 事件。
 * 失败一律静默——标题是易耗品，不该有任何一条报错通路；门禁（meta 的
 * titleSource 仍是 derived）在主进程，这里不发事件它自然不变，下一条用户
 * 消息就再试一次。不做取消：调用几秒量级，进程退出自然带走，会话被删时
 * 主进程落盘侧读不到 meta 悄悄不做。
 * ponytail: maxTokens 1024 是硬上限不是目标——后端无视思考抑制时标记仍可达
 * （oh-my-pi issue #4355 同款）；本仓锁的 pi-ai 0.84.3 没有 disableReasoning。
 */
/** 标题调用的硬上限。标题是易耗品，宁可超时重试也不挂着占住单飞守卫。 */
const TITLE_TIMEOUT_MS = 30_000;

async function generateSessionTitle(
  note: LedgerNote,
  session: AgentSession,
  sessionId: string,
  text: string,
  /** 家务活模型（设置里的 choreModel）；缺席或解析失败都退回会话模型 */
  choreModel?: Extract<AgentCommand, { type: "generateTitle" }>["model"],
): Promise<void> {
  if (note.titleInFlight) return;
  note.titleInFlight = true;
  try {
    const dedicated = choreModel === undefined ? null : await resolveChoreModel(choreModel);
    const model = dedicated?.model ?? session.model;
    if (model === undefined) return;
    // 鉴权面跟着模型走，**整个换不逐键兼**：专用模型没自定义头时继承账本里
    // 那份（另一家的），往往正是鉴权失败的来源
    const auth: { apiKey: string; headers?: Record<string, string> } =
      dedicated ?? { apiKey: note.apiKey, ...(note.headers ? { headers: note.headers } : {}) };
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
        apiKey: auth.apiKey,
        maxTokens: 1024,
        timeoutMs: TITLE_TIMEOUT_MS,
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        ...(auth.headers ? { headers: auth.headers } : {}),
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
    note.titleInFlight = false;
  }
}

/**
 * 会话内换模型（C-4），**轮在跑**的路径：注册 + 解析目标模型（与 openTurn 同一条
 * 装配路径），然后 `session.setModel`——pi 自己校验 auth、把 model_change 落进它的
 * 本子、clamp thinking。**不传 persist**：全局默认模型是 pi TUI 的概念，会话内切换
 * 不该改写用户磁盘上的全局设置。生效边界是 pi 定的：当前轮用旧模型跑完
 * （run 启动时快照），下一次 prompt 起新模型——无状态模型下就是下一次 open 时
 * 主进程装配的新 provider/modelId。
 */
async function setSessionModel(
  session: AgentSession,
  sessionId: string,
  provider: ProviderSecrets,
  modelId: string,
): Promise<void> {
  try {
    const model = registerAndResolveModel(session.modelRuntime, provider, modelId);
    if (model === undefined) {
      throw new Error(`unknown model "${provider.id}/${modelId}"`);
    }
    await session.setModel(model);
    updateLedgerAuth(sessionId, provider);
    send({ type: "model", sessionId, providerId: model.provider, modelId: model.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // 操作级失败（无 key / 未知模型）：红字报给用户，chip 与 meta 都不动
    send({ type: "failed", sessionId, message });
  }
}

/**
 * 会话内换模型，**没在跑**的路径（无状态模型的常态）：不持有 AgentSession，
 * 自建一次性 ModelRuntime 做同一套「注册 + 解析」校验——「能不能用某个模型」
 * 两条路必须是同一套真相。成功只发 `model` 事件（主进程落 meta，下一次
 * open 自然用新装配）；失败发 `failed`。pi 本子里没有 model_change 记录也
 * 成立：每轮 open 都显式解析并传入 model，不依赖本子恢复。
 */
async function setLedgerModel(
  sessionId: string,
  provider: ProviderSecrets,
  modelId: string,
): Promise<void> {
  try {
    const runtime = await ModelRuntime.create({});
    const model = registerAndResolveModel(runtime, provider, modelId);
    if (model === undefined) {
      throw new Error(`unknown model "${provider.id}/${modelId}"`);
    }
    updateLedgerAuth(sessionId, provider);
    send({ type: "model", sessionId, providerId: model.provider, modelId: model.id });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    send({ type: "failed", sessionId, message });
  }
}

/** 跨轮账本里的一条：不持有任何 pi 对象，会话「不在跑」时也活着。 */
interface LedgerNote {
  /** 三档权限模式。每轮 open 的 before_agent_start 都会重讲（中途切档下一轮生效） */
  mode: PermissionMode;
  /**
   * 已在本地回显（adapter.userPrompt 造过 item）的用户消息文本。pi 随后 emit 的
   * user `message_start` 是回声，命中即丢弃。跨轮保留：上一轮没消费完的回声
   * 留给下一轮对账（abort 边角）。
   */
  echoed: Set<string>;
  /** 标题在途标记：连发两条消息也只生成一次，失败后下一条自然重试 */
  titleInFlight: boolean;
  /** 标题调用（C-3）的鉴权面——最近一次装配进来的 provider key 与自定义头 */
  apiKey: string;
  headers?: Record<string, string>;
}

/**
 * 跨轮账本：sessionId → 不持有 pi 对象的跨轮状态。key 在首次开机时落账，
 * dispose（删除会话）时销账；进程重启自然清零（一切都可从盘上重建）。
 */
const ledger = new Map<string, LedgerNote>();

/** 取账；没有就先落一条默认（setMode 等「会话不在跑也合法」的命令用）。 */
function ledgerNote(sessionId: string): LedgerNote {
  let note = ledger.get(sessionId);
  if (note === undefined) {
    note = { mode: "plan", echoed: new Set(), titleInFlight: false, apiKey: "" };
    ledger.set(sessionId, note);
  }
  return note;
}

/** 换 provider 后把标题鉴权面对齐到最近一次装配（setModel 两条路径共用）。 */
function updateLedgerAuth(sessionId: string, provider: ProviderSecrets): void {
  const note = ledgerNote(sessionId);
  note.apiKey = provider.apiKey;
  if (provider.headers === undefined) delete note.headers;
  else note.headers = provider.headers;
}

/**
 * 一轮 open 出来的对象面：`turn-cycle` 的 CycleParts（abort / dispose /
 * unsubscribe）挂到 pi session 与退订闭包上，session / adapter 供 run 回调用。
 * 占坑-收尾的骨架与三个不变量（先占坑防双开 / open 期 abort 记账兑现 /
 * settled 晚于出表）全在 turn-cycle.ts——那里有测试。
 */
interface TurnParts {
  abort: () => void;
  dispose: () => void;
  unsubscribe: () => void;
  session: AgentSession;
  adapter: TranscriptAdapter;
  /** 本轮时间语义（A-1）：run 的回显处填 echoedAt，界碑盖戳读它 */
  turn: TurnTiming;
  /** 本轮的文件快照跟踪器（OpenedTurn.tracker 的透传） */
  tracker: TurnFileTracker;
}

/** 运行态表：sessionId → 正在跑的那一轮。「在不在跑」的唯一真值。 */
const running = new Map<string, CycleSlot<TurnParts>>();

/**
 * MCP 连接。**进程级一份**，所有会话共享——每条会话各拉一份 `npx some-server`
 * 会让子进程数量随会话线性增长，而 MCP server 本来就是无状态的工具提供方。
 */
const mcpHub = new McpHub();
/**
 * 工具请求的在途表（4-3 立，B-1 泛化）：create_skill / add_mcp_server /
 * read_task / browser_* 的回执由 handle 的命令分支结掉。进程级一份——主进程是唯一的
 * 对端，不需要按会话分。
 */
const requestBroker = new RequestBroker((event) => send(event as AgentEvent));

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
 * 向 UI 请示。**没有超时**：用户可能去泡杯咖啡再回来点。
 *
 * 但这个 promise 也**不听 abort**：pi 的 prepareToolCall 是 `await beforeToolCall(...)`
 * 之后才查 `signal.aborted`，所以卡在审批上时 AbortController 炸了也没人听。
 * 停止 / 抢跑 / 删会话都必须走 `settlePendingPermissions` 把它手动结掉，
 * 否则那一轮永远不会收尾（interrupt 还会卡在 `await lifecycle` 上）。
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
 * 把该会话挂起的审批一次结清，按拒绝放行——工具调用立刻拿到结果返回，
 * pi 的 loop 随即查到 `signal.aborted` 并收尾。
 *
 * 不结就掉引用（旧 dispose 分支的做法）的话，工具执行的闭包会挂在那里等一个
 * 永远不会到的回答。
 */
function settlePendingPermissions(sessionId: string): void {
  for (const [key, resolve] of pendingPermissions) {
    if (!key.startsWith(`${sessionId}:`)) continue;
    resolve({ behavior: "deny", message: "Stopped" });
    pendingPermissions.delete(key);
  }
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

/** 开一轮需要的装配输入：submit / interrupt / compact 命令共有的那几个字段。 */
type OpenInput = Extract<AgentCommand, { type: "submit" | "interrupt" | "compact" }>;

/** open 的产物：一轮的全部挂件（退订闭包持有订阅，别弄丢）。 */
interface OpenedTurn {
  session: AgentSession;
  adapter: TranscriptAdapter;
  unsubscribe: () => void;
  /** 本轮时间语义（A-1）：回显时间戳 + 出没出过 assistant 产物，界碑盖戳用 */
  turn: TurnTiming;
  /** 本轮的文件快照跟踪器：闸门放行记 before、执行落定读 after（file-tracker.ts） */
  tracker: TurnFileTracker;
}

/**
 * 开一轮：装配（provider → model → services → 订阅 → created 事件）。
 * 与 startTurn 分开只是为了把「纯装配」单独读——每轮都走，路径必须与旧
 * create 命令一字不差地同源（同一套注册解析、同一套审批门、同一套事件翻译）。
 *
 * @param isCompactionTurn 这一轮的生命周期就是一次手动压缩（决定 compaction_end
 *   的相位翻译：手动压缩轮什么都不发——idle 只由 startTurn 的 finally 发，
 *   与 agent_settled 同一条纪律；轮内自动压缩压完回 turn——自动压缩跑在 loop
 *   里，压完轮还在，发 idle 会让 renderer 误投递）。
 */
async function openTurn(command: OpenInput, isCompactionTurn: boolean): Promise<OpenedTurn> {
  const note = ledgerNote(command.sessionId);
  note.mode = command.mode;
  note.apiKey = command.provider.apiKey;
  if (command.provider.headers === undefined) delete note.headers;
  else note.headers = command.provider.headers;

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

  /**
   * 子会话身份（2026-09-23）：related 里有 `relation === "parent"` 的一项 → 本会话
   * 是被派出的子会话。决定注册哪些通道工具（createChannelTools）、讲哪段通道
   * 提示词（describeChannelRole）——两处判定必须同源，不能分别猜。
   */
  const role: "root" | "child" = command.directories?.related?.some(
    (entry) => entry.relation === "parent",
  )
    ? "child"
    : "root";

  // 审批走 pi 官方的 `tool_call` 扩展钩子：block 即拒绝，原地改 input 即改写入参。
  // 内建工具默认全开，不需要我们自己装配。
  // **模式读账本**：跨轮的 mode 在 ledger，不在 pi 对象上——对象这轮结束就销毁了。
  // **会话文件不可变**：protectedPaths 由主进程随每轮发，闸门在档位判定之前拦。
  const currentMode = () => ledgerNote(command.sessionId).mode;
  const gate = createToolCallGate(
    currentMode,
    askPermission(command.sessionId),
    command.protectedPaths,
    command.cwd,
  );
  // 文件快照跟踪：闸门**放行之后**才记 before（拒掉的调用不会执行，记了是假账；
  // ask 档等用户点了允许，读到的才是「这一批动手前」的内容）。prepare 阶段
  // pi 顺序跑钩子，同批并行调用的 before 互不踩。
  const tracker = new TurnFileTracker(command.cwd);
  const services = await createAgentSessionServices({
    cwd: command.cwd,
    modelRuntime,
    resourceLoaderOptions: {
      /**
       * Skills：把集合目录交给 pi，扫盘与拼 prompt 都是它的事。
       *
       * **不自己调 `loadSkillsFromDir` / `formatSkillsForPrompt`**：用了那两个就得自己拼
       * system prompt，而 pi 的 ResourceLoader 本来就在做这件事——多一份就多一份会漂的格式。
       *
       * 2-1 起 skillsDirs 是数组（global 恒在 + 当前工作区），里面的 symlink 指向
       * 中心存储，pi 的加载器跟符号链接（skills.js 对 isSymbolicLink 做 statSync，
       * 断链自动跳过）。顺序由主进程定且稳定，我们不重排——重排会作废 prefix 缓存。
       *
       * `noSkills: true` 不是「不要 skills」，而是**不要自动发现的那些**（pi 0.84.3 的
       * `resource-loader.js:330`：它只把 `enabledSkills` 排掉，`additionalSkillPaths` 照常合并）。
       * 不加这一句的后果实测过：pi 的 packageManager 会扫 `~/.agents/skills/`（Agent Skills
       * 标准的全局目录），当场多出 9 个用户用 CLI 装的 skill。那些 skill 在我们的界面里
       * 没有任何地方能解释自己从哪来，而「放进目录就能用」的对偶必须是「没放就不生效」。
       * 隔离是可逆的：以后想共享全局 skill，加个设置项就行；反过来是破坏性变更。
       */
      noSkills: true,
      additionalSkillPaths: command.skillsDirs,
      extensionFactories: [
        {
          name: "orbita-permission",
          hidden: true,
          factory: (pi: PiExtensionApi) => {
            pi.on("tool_call", async (event) => {
              const result = await gate(event);
              if (!result.block) await tracker.noteAllowed(event.toolCallId, event.toolName, event.input);
              return result;
            });
            // **每一轮都重讲一遍当前模式**。`before_agent_start` 逐轮触发，所以中途
            // 切模式下一轮就生效；只在开机时讲一次的话，切了模式模型还按旧的答。
            // 工具名单现场取（1-2）：MCP 重载后新工具集下一轮自动进这段话。
            pi.on("before_agent_start", (event) => ({
              // 空串的段要滤掉（Git 标识关了就是空串），否则提示词末尾多一个空行
              systemPrompt: [
                event.systemPrompt,
                describePermissionMode(currentMode(), [
                  ...mcpHub.currentTools().map((tool) => tool.name),
                  "create_skill",
                  "add_mcp_server",
                  "read_task",
                  // 本会话实际注册的通道工具名（同 customTools 的 role 判定，见下）
                  ...(role === "root" ? ["delegate", "reply_subsession"] : ["report_to_parent"]),
                ]),
                // 开轮目录清单（cwd / 附加目录 / 会话工作台 / 父子互见）。同样逐轮重讲：
                // 工作区挂新目录、换工作区，下一轮就生效。缺席（旧夹具）= 空串，被 filter 滤掉
                describeDirectories(command.cwd, command.directories),
                // 通道工具的使用说明（子会话 2026-09-23）：root/child 各讲各的一段
                describeChannelRole(role),
                STORE_TOOLS_GUIDELINES,
                TOOL_GUIDELINES,
                // 编号引用的读法：用户消息开头的 <quoted_context index=…> 是什么、回复怎么对号。
                // 不讲的话模型只能靠标签名猜（Proma 就是这样，2026-09-25 查证）
                QUOTE_GUIDELINE,
                // 缺席 = 开启，与设置契约同一口径；同样逐轮重讲，改设置下一轮即生效
                gitAttributionGuideline(command.gitAttribution ?? true, command.attributionLanguage ?? "en"),
              ]
                .filter((part) => part !== "")
                .join("\n\n"),
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
   * 压缩阈值（A-1）：用户设置走「剩余百分比」，按**本轮模型**的窗口换算成 pi 的
   * reserveTokens——pi 的判定（agent-session 的 shouldCompact）拿当前模型窗口比，
   * 这里必须同源。保留量不暴露、内部按窗口钳制（pi 出厂 2 万对 ≤16k 窗口的模型
   * 大于整个上下文，是退化形态）。关掉 = pi 的 enabled:false，手动 /compact 不走
   * 阈值、不受影响。applyOverrides 深合并、判定时现读——用户改设置，下一轮即生效。
   */
  services.settingsManager.applyOverrides({
    compaction: {
      enabled: command.compaction?.enabled ?? true,
      reserveTokens: compactionReserveTokens(
        command.compaction?.reservePercent ?? COMPACTION_DEFAULT.reservePercent,
        model.contextWindow,
      ),
      keepRecentTokens: compactionKeepRecentTokens(model.contextWindow),
    },
  });
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
  /**
   * MCP 工具。**连接在进程级只做一次**（`McpHub.start` 幂等：首个 start 连，后续轮直接
   * 复用）；无状态化后每轮都经过这里，但只有第一轮真的拉起连接。连不上不拦开轮——
   * MCP server 是外部程序，装错命令、缺环境变量都是常态，不该让一台坏的把会话堵死；
   * 状态经 `mcp` 事件告诉界面（每轮重报一次快照，自愈主进程缓存）。
   */
  await mcpHub.start(command.mcpServers);
  send({ type: "mcp", servers: mcpHub.describe() });
  const customTools = [
    ...mcpHub.currentTools(),
    // read_pdf 不过 broker：附件副本与工作区 PDF 都在 agent read 边界内，直读（./pdf-tools.ts）
    ...createPdfTools(command.cwd),
    // read_docx 同样直读（./docx-tools.ts）：word 文档的结构化提取，块号轴分片
    ...createDocxTools(command.cwd),
    // show_image 同样直读展示（./image-tools.ts）：模型「把图给用户看」的显式动作
    ...createImageTools(command.cwd),
    ...createStoreTools(requestBroker, command.sessionId),
    ...createTaskTools(requestBroker, command.sessionId),
    ...createBrowserTools(requestBroker, command.sessionId),
    ...createChannelTools(requestBroker, command.sessionId, role),
  ];
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    // 思考档每轮显式给：不传的话 pi 退到用户全局 ~/.pi/agent/settings.json，
    // 那是另一个应用的配置——这一刀收归己有的就是它
    thinkingLevel: command.thinkingLevel,
    ...(customTools.length > 0 ? { customTools } : {}),
  });
  // 开轮即推一次真值：模型可能把我们传的档 clamp 到就近支持档（静默），
  // 芯片必须显示 clamp 后的事实而不是用户点的意图。每轮都推也兼容
  // 「换模型后支持集变了」——芯片每次开轮自我纠真
  send({
    type: "thinking",
    sessionId: command.sessionId,
    level: session.thinkingLevel,
    supported: session.getAvailableThinkingLevels(),
  });

  const adapter = new TranscriptAdapter({ newId: () => randomUUID(), now: () => Date.now() });
  const echoed = note.echoed;
  // 本轮时间语义（A-1）：echoedAt 由 submit / interrupt 的回显处填；sawAssistant 由
  // 下面的订阅置位。预检压缩（prompt 前那一次）发生时 echoedAt 已有、sawAssistant
  // 还是 false——compaction_end 据此盖回显的时间戳，界碑落到刚发那句之前。
  const turn: TurnTiming = { echoedAt: null, sawAssistant: false };
  const observeTurnFailure = createTurnFailureTracker();
  const unsubscribe = session.subscribe((event) => {
    // 文件快照的 after：工具落定即读盘。不 await（读盘是毫秒级，不该卡事件流），
    // finalize 自己等在途读全部落定
    if (event.type === "tool_execution_end") {
      void tracker.noteExecutionEnd(event.toolCallId);
    }
    // 不重试的模型错误（400 / 401 …）只留下一条空 error 回答，我们不落盘也不渲染它——
    // 回合终局时补报一条回合级失败，让错误挂在这轮没得到回答的话下面（见 ./turn-failure.ts）
    const turnFailure = observeTurnFailure(event);
    if (turnFailure !== null) {
      send({ type: "failed", sessionId: command.sessionId, message: turnFailure, turn: true });
    }
    const adaptable = asAdaptable(event);
    if (adaptable) {
      // 排队消息的「迟到显形」留在原处：本地没回显过的 user message_start 当场造
      // item（显示 + 落盘同步发生）。无状态模型下 pi 队列不再被使用，这里是纯
      // 防御——万一 pi 再 emit user 消息，宁可显示也不丢记录。
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
      if (adaptable.type === "message_start" && adaptable.message.role === "assistant") {
        turn.sawAssistant = true;
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
    // pi 内部改档（目前只有我们自己的 setThinkingLevel 会触发，防御性放行）：
    // 档位变了芯片必须跟着真——开轮那次推送之外的第二道保险
    if (event.type === "thinking_level_changed") {
      send({
        type: "thinking",
        sessionId: command.sessionId,
        level: event.level,
        supported: session.getAvailableThinkingLevels(),
      });
    }
    // 注意：agent_settled **不在这里发 idle**——idle 只由 startTurn 的 finally 发，
    // 保证它一定晚于 dispose 与 running.delete。早发的话 renderer 的投递会在
    // 清理完成前回流，撞上「already running」（prompt resolve 与事件发射的
    // 先后没有契约保证，不能赌）。stats 落盘照旧在这里：settled 就是轮的账已结清。
    if (event.type === "agent_settled") {
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
      // 手动压缩轮不在这里发 idle——idle 只由 startTurn 的 finally 发（晚于 dispose
      // 与 running.delete），在这里发会让 renderer 的投递撞上 already running，
      // 与 agent_settled 那处同一条纪律。轮内自动压缩压完轮还在，回 turn。
      if (!isCompactionTurn) send({ type: "phase", sessionId: command.sessionId, phase: "turn" });
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
            // A-1：预检压缩盖回显的时间戳（界碑落到刚发那句之前，mergeCompactions
            // 同毫秒平局界碑排前）；轮内压缩照旧用当下时间
            timestamp: compactionBoundaryTimestamp(turn, Date.now()),
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
          message: `Failed after ${event.attempt} retries: ${event.finalError ?? "unknown"}`,
          turn: true,
        });
      }
    }
  });

  // 开机即推一次：新会话给零值；唤醒的旧会话立刻给真累计——余量不用等第一轮跑完。
  // **落盘**：唤醒时 pi 给的才是跨重启的真累计，比我们上次存的快照新，当场就该校准
  pushStats(command.sessionId, session, true);
  send({
    type: "created",
    sessionId: command.sessionId,
    // 主进程要把它记进会话 meta，否则下次就找不回这本子了。**每轮都发**：
    // open 失败退回新建时 pi 会换文件，按轮自愈比只在首轮发一次稳。
    piSessionFile: sessionManager.getSessionFile() ?? null,
  });

  return { session, adapter, unsubscribe, turn, tracker };
}

function openOrCreate(command: OpenInput): SessionManager {
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
 * 跑一轮（submit / compact 共用骨架）：占坑 → open → run → 清理。
 *
 * **占坑在最前**：open 是几百毫秒的异步，中间会让渡事件循环——不先占坑的话，
 * 同一会话的 interrupt 会在 open 期间到达、看不到坑、再开一本同样的 JSONL，
 * 两个 AgentSession 写同一份 pi 本子（记录写坏，修不回来）。
 *
 * 清理序列（finally）：退订 → dispose → 出表 → **补发 phase idle**。idle 放在
 * 这里而不是 agent_settled 的翻译处，是给 renderer 投递排队消息的时序契约：
 * 「收到 idle 时，这一轮一定已经完全收尾，submit 不会撞 already running」。
 * 正常结束、abort、异常路径都经过这里，幂等（renderer 的槽是 set 不是累加）。
 */
function startTurn(command: OpenInput, run: (opened: OpenedTurn) => Promise<unknown>): Promise<void> {
  const id = command.sessionId;
  return startCycle(
    running,
    id,
    async () => {
      const opened = await openTurn(command, command.type === "compact");
      return {
        abort: () => opened.session.abort(),
        dispose: () => opened.session.dispose(),
        unsubscribe: opened.unsubscribe,
        session: opened.session,
        adapter: opened.adapter,
        turn: opened.turn,
        tracker: opened.tracker,
      };
    },
    async (parts) =>
      run({
        session: parts.session,
        adapter: parts.adapter,
        unsubscribe: parts.unsubscribe,
        turn: parts.turn,
        tracker: parts.tracker,
      }),
    // settled 一定晚于 dispose 与出表（turn-cycle 的收尾序）——renderer 收到
    // idle 时本轮已完全收尾，排队投递不会撞 already running
    () => send({ type: "phase", sessionId: id, phase: "idle" }),
  );
}

/**
 * pi 侧分支（C-2）：开一个**一次性的** SessionManager 读源本子，对账后用 pi 自己的
 * `createBranchedSession` 裁新文件。绝不碰活着的 manager——那个方法会把实例原地
 * 换绑到新文件上，误用在活会话的 manager 上，后续追加就写进分支文件了（事故形状）。
 * 源会话正在跑也没关系：只读源文件、只写新文件，追加与读取互不干扰。
 * 对账输入是 **getBranch()（当前叶子路径）**：会话回退会在本子里留废枝，文件序
 * （getEntries）会把废枝也数进来，从第一次回退起对账必然错位。
 */
async function branchPiSession(command: Extract<AgentCommand, { type: "branch" }>): Promise<void> {
  const manager = SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd);
  const targetId = planBranchCut(manager.getBranch(), command.roles);
  const branchFile = manager.createBranchedSession(targetId);
  if (branchFile === undefined) throw new Error("pi produced no branch file");
  // 复用 created 事件通路：主进程对 branch 与开机用同一条等待逻辑
  send({ type: "created", sessionId: command.sessionId, piSessionFile: branchFile });
}

/**
 * 会话回退的 pi 侧一刀（不依赖任何表，直接裁文件）：详见 pi-book-edit.ts。
 * **会话不在跑是硬前提**——在跑的话工具还没落定，此刻裁枝会把进行中的轮
 * 写进废枝；由这里拒绝（主进程的 renderer 禁用只是第一道，这是信任边界）。
 */
function revertPiBookCommand(command: Extract<AgentCommand, { type: "revertPiBook" }>): void {
  if (running.has(command.sessionId)) {
    throw new Error("the session is still running — stop it before reverting");
  }
  const manager = SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd);
  revertPiBook(manager, command.roles, { targetMessageId: command.targetMessageId });
  send({ type: "piBookEdited", sessionId: command.sessionId, edit: "revert" });
}

/**
 * 单轮撤销的 pi 侧一刀：在当前叶子追加告知模型的 custom_message（进上下文）。
 * 同样要求会话不在跑；notice 是主进程拼好的完整句子（含文件清单）。
 */
function undoPiBookCommand(command: Extract<AgentCommand, { type: "undoPiBook" }>): void {
  if (running.has(command.sessionId)) {
    throw new Error("the session is still running — stop it before undoing");
  }
  const manager = SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd);
  undoPiBook(manager, command.notice);
  send({ type: "piBookEdited", sessionId: command.sessionId, edit: "undo" });
}

/**
 * pi 内建 provider 目录 → 我们的 BuiltinProvider。
 * agentDir 指向一个不存在的路径：只要 pi 的内建目录，不去读用户的 ~/.pi/agent 配置。
 */
async function listBuiltins(): Promise<void> {
  const runtime = await ModelRuntime.create({});
  // 映射跟注册时的跨目录推断共用一份（toBuiltinProvider）：设置页看到的目录快照
  // 必须与 agent 借参数时用的是同一份，否则两边会对同一个模型说出两个窗口。
  send({ type: "builtins", providers: runtime.getProviders().map(toBuiltinProvider) });
}

/**
 * 回显用户消息并交给 pi。submit 与 interrupt 的这一段逐字相同，抽出来是因为
 * 各写一份迟早漂移（一份改了缩放口径另一份没跟的那种事故）。
 *
 * - 用户消息先落地再发给模型——不等模型回，UI 立刻看得到自己刚说的话。
 *   echoed 记一笔：pi 随后 emit 的 message_start 是这条的回声，别重复显示。
 *   **记的是拼好的整段**（composePromptText）：pi 的回声正文是拼好的那份，
 *   对账按文本全等。
 * - expandPromptTemplates 关掉：展开会改写文本，破坏按文本做的回声对账；
 *   且本仓没有 skill / template / 斜杠命令的 UI，展开本就无对象。
 * - 附图先缩好再回显：落盘与送给模型的是同一份。缩不了就在这里抛——
 *   回显之前，转录里不会留下一条没发出去的消息。
 * - 文件引用与粘贴块组装进正文之后；回显块保留块界（粘贴块 / 文件清单各自独立
 *   text 块），显示层按块解析回 chip。
 */
async function echoAndPrompt(
  opened: OpenedTurn,
  note: LedgerNote,
  command: Extract<AgentCommand, { type: "submit" | "interrupt" }>,
): Promise<void> {
  const images = await preparePromptImages(command.images);
  const pasted = command.pasted ?? [];
  const files = command.files ?? [];
  const promptText = composePromptText(command.text, pasted, files);
  note.echoed.add(promptText);
  for (const progress of opened.adapter.userPrompt(command.text, images, attachmentBlocks(pasted, files))) {
    // A-1：回显的时间戳留给预检压缩的界碑盖戳用（compactionBoundaryTimestamp）
    if (progress.type === "item_started") opened.turn.echoedAt = progress.item.timestamp;
    send({ type: "progress", sessionId: command.sessionId, progress });
  }
  await opened.session.prompt(promptText, {
    expandPromptTemplates: false,
    ...(images.length > 0 ? { images: forModel(images) } : {}),
  });
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

  // 分支带的是「新会话的 id」，此刻账本里还没有——不依赖任何表，直接裁文件
  if (command.type === "branch") {
    await branchPiSession(command);
    return;
  }

  // 回退 / 撤销的 pi 侧一刀：同步文件操作，完成经 piBookEdited 回执
  if (command.type === "revertPiBook") {
    revertPiBookCommand(command);
    return;
  }
  if (command.type === "undoPiBook") {
    undoPiBookCommand(command);
    return;
  }

  if (command.type === "submit") {
    await startTurn(command, async (opened) => {
      try {
        await echoAndPrompt(opened, ledgerNote(command.sessionId), command);
      } finally {
        await reportFileTurn(command.sessionId, opened.tracker);
      }
    });
    return;
  }

  if (command.type === "interrupt") {
    // 队列在 renderer 一侧（docs/plans/2026-09-06-排队队列所有权收回），
    // 这里只做两件事：停下正在跑的这一轮（等它完全收尾），把这句话作为新一轮发出去。
    // 不碰 pi 的 steering/followUp——那正是要断掉的耦合。
    // **抢跑语义：中间没有「空闲」**——旧轮收尾不发 idle（preempt），否则 renderer
    // 收到 idle 就投递队首，撞上新轮的 already running，排队项丢失。
    abortCycle(running, command.sessionId, { preempt: true });
    // 旧轮可能正卡在审批上；不结掉的话下面的 await lifecycle 永远不返回
    settlePendingPermissions(command.sessionId);
    await running.get(command.sessionId)?.lifecycle;
    try {
      await startTurn(command, async (opened) => {
        try {
          await echoAndPrompt(opened, ledgerNote(command.sessionId), command);
        } finally {
          await reportFileTurn(command.sessionId, opened.tracker);
        }
      });
    } catch (cause) {
      // 抢跑的旧轮没发 idle，新轮又没开起来——renderer 会卡在 turn。这里兑底。
      send({ type: "phase", sessionId: command.sessionId, phase: "idle" });
      throw cause;
    }
    return;
  }

  if (command.type === "compact") {
    // 手动压缩。pi 的旧 compact() 内部先 abort 当前轮——无状态化沿用这个语义：
    // 在跑就先停（等收尾），再以压缩为一轮生命周期开机。忙碌态、界碑、失败提示
    // 全走 compaction_start / compaction_end 事件那条已接好的链。
    // 抢跑语义同 interrupt：旧轮收尾不发 idle（preempt），中间没有「空闲」可投递。
    abortCycle(running, command.sessionId, { preempt: true });
    // 理由同 interrupt：卡在审批的旧轮不结就等不到它收尾
    settlePendingPermissions(command.sessionId);
    await running.get(command.sessionId)?.lifecycle;
    try {
      await startTurn(command, async (opened) => {
        try {
          await withManualCompactionTuning(opened.session, () => opened.session.compact(command.instructions));
        } finally {
          // 压缩轮不跑工具，finalize 恒为空——留着这行是为了「每轮都 finalize」的
          // 不变量不被将来加的压缩内工具破坏
          await reportFileTurn(command.sessionId, opened.tracker);
        }
      });
    } catch (cause) {
      // 抢跑的旧轮没发 idle，新轮又没开起来——renderer 会卡在 turn。这里兑底。
      send({ type: "phase", sessionId: command.sessionId, phase: "idle" });
      throw cause;
    }
    return;
  }

  if (command.type === "abort") {
    // 停止只停当前轮。没在跑就静默——「停止」按钮对空闲会话本就该是 no-op。
    // 排队消息滞留在 renderer 的本地队列，idle 事件（startTurn 的 finally）到了
    // 自然逐条投递；不替用户清队（排队是用户的意图，停止不该替他放弃）。
    abortCycle(running, command.sessionId);
    // **审批不听 abort**（见 askPermission）：不在这里结掉的话，停止对「正卡在
    // 审批上的轮」完全无效——要等用户先回答审批，那个停止才生效
    settlePendingPermissions(command.sessionId);
    return;
  }

  if (command.type === "dispose") {
    // 删除会话。**没开过账的也走这里**（删除一条从未唤醒的会话是正常路径）——
    // 没有就没什么可释放的，静默返回。
    // pi 的 dispose 自己会 abort 全部在飞工作（当前轮 / 重试 / 压缩 / 本会话的
    // bash），正在跑的会话被删也成立，无需先 abort。killCycle 标记 disposed，
    // 收尾跳过二次 dispose（退订与出表仍做），并等它完全收尾。
    await killCycle(running, command.sessionId);
    ledger.delete(command.sessionId);
    // 审批 resolve 函数不随会话一起结的话，会把已销毁会话的工具执行闭包整条钉在内存里
    settlePendingPermissions(command.sessionId);
    return;
  }

  if (command.type === "setMode") {
    // 档位是账本字段：每轮 before_agent_start 都重讲，这里只改账。会话不在跑
    // 也合法（Ctrl+R 后重开，renderer 会同步当前档位）——先落账，下一轮生效。
    ledgerNote(command.sessionId).mode = command.mode;
    return;
  }
  if (command.type === "setModel") {
    // 会话内换模型（C-4）。fire-and-forget：成功经 `model` 事件、失败经 `failed`
    // 事件回传，主进程与 renderer 都靠事件对齐，这一跳不等结果。
    // 轮在跑：落 pi 本子（model_change）；不在跑：只校验 + 落账——下一次 open
    // 的装配本来就用主进程的新 provider/modelId。
    const current = running.get(command.sessionId);
    if (current?.opened != null) {
      void setSessionModel(current.opened.session, command.sessionId, command.provider, command.modelId);
    } else {
      void setLedgerModel(command.sessionId, command.provider, command.modelId);
    }
    return;
  }
  if (command.type === "generateTitle") {
    // 发送方（主进程）已做过 titleSource 门禁，且在 submit 后立刻发——轮还在跑，
    // 用当轮 session 的模型与账本里的鉴权面。fire-and-forget，不拖慢这一跳。
    // 迟到到轮已收尾（极端窗口）就跳过：标题是易耗品，下一条消息自然重试。
    const current = running.get(command.sessionId);
    const note = ledger.get(command.sessionId);
    if (current?.opened != null && note !== undefined) {
      void generateSessionTitle(
        note,
        current.opened.session,
        command.sessionId,
        command.text,
        command.model,
      );
    }
    return;
  }
  if (command.type === "skillWriteResult") {
    requestBroker.resolve(
      command.requestId,
      command.ok
        ? { ok: true, ...(command.path === undefined ? {} : { path: command.path }) }
        : { ok: false, error: command.error ?? "Write failed" },
    );
    return;
  }
  if (command.type === "mcpWriteResult") {
    requestBroker.resolve(
      command.requestId,
      command.ok
        ? { ok: true, ...(command.status === undefined ? {} : { status: command.status }) }
        : { ok: false, error: command.error ?? "Write failed" },
    );
    return;
  }
  if (command.type === "readTaskResult") {
    requestBroker.resolve(
      command.requestId,
      command.ok
        ? { ok: true, card: command.card, text: command.text }
        : { ok: false, error: command.error ?? "Read failed" },
    );
    return;
  }
  if (command.type === "browserResult") {
    requestBroker.resolve(
      command.requestId,
      command.ok
        ? {
            ok: true,
            text: command.text,
            card: command.card,
            ...(command.image === undefined ? {} : { image: command.image }),
          }
        : { ok: false, error: command.error ?? "Browser request failed" },
    );
    return;
  }
  if (command.type === "delegateResult") {
    // requestBroker 的同款胶水：回执翻给 pending 的 delegate 工具调用
    requestBroker.resolve(
      command.requestId,
      command.ok
        ? { ok: true, childId: command.childId, title: command.title, card: command.card }
        : { ok: false, error: command.error ?? "Delegate failed" },
    );
    return;
  }
  if (command.type === "channelSendResult") {
    requestBroker.resolve(
      command.requestId,
      command.ok
        ? { ok: true, messageId: command.messageId }
        : { ok: false, error: command.error ?? "Send failed" },
    );
    return;
  }
  if (command.type === "steer") {
    // 父→子注入（Q2'）：主进程只在目标在跑时发这条（空闲退化 submit），
    // 到这里不在跑、或刚占坑还没 open 出对象面（opened 尚空），都是状态失步——
    // 回 failed 说明，不静默丢（用户看得到注入没送进去，重发即可）
    const session = running.get(command.sessionId)?.opened?.session;
    if (session === undefined) {
      send({
        type: "failed",
        sessionId: command.sessionId,
        message: "steer 到达时这一轮已结束（或刚开机还没接上），注入没送进去——请重发",
      });
      return;
    }
    // 2026-09-06「不碰 steering」收回的是队列所有权（排队状态在 renderer 的槽），
    // 不是否定 steer 本身：这里只把话交给 pi 的 steer/followUp 队列（delivery 缺席 =
    // steer：下一个工具调用边界生效，不断轮；followUp：等这轮本来要停时再处理，
    // 同一个 run 里接着跑），不开新轮、不碰排队。expandPromptTemplates 关掉：同 submit 的理由。
    await session.prompt(command.text, {
      streamingBehavior: command.delivery ?? "steer",
      expandPromptTemplates: false,
    });
    return;
  }
  if (command.type === "mcpReload") {
    // 重连后把新快照报给主进程（缓存 + 广播给管理面）。
    // 已在跑的轮不受影响：它们的 customTools 在开机时已定格。
    await mcpHub.restart(command.servers);
    send({ type: "mcp", servers: mcpHub.describe() });
    return;
  }
  if (command.type === "classifyGreetings") {
    // 不 await：判定是几秒量级的独立调用，不挡住后面进来的命令（与标题同理）
    void classifyGreetings(command);
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
    return "Already compacted — nothing new since the last one. Continue the conversation, then compact again.";
  }
  if (raw === "Nothing to compact (session too small)") {
    return "This conversation is too short — not enough context worth compacting.";
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
