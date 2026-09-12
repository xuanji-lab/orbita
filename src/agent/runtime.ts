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
  toBuiltinModel,
} from "./model-registration.ts";
import {
  createToolCallGate,
  describePermissionMode,
  type PiExtensionApi,
} from "./permission.ts";
import { TranscriptAdapter, type AdaptableEvent } from "./transcript-adapter.ts";
import { abortCycle, killCycle, startCycle, type CycleSlot } from "./turn-cycle.ts";
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
): Promise<void> {
  if (note.titleInFlight) return;
  note.titleInFlight = true;
  try {
    const model = session.model;
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
        apiKey: note.apiKey,
        maxTokens: 1024,
        timeoutMs: TITLE_TIMEOUT_MS,
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        ...(note.headers ? { headers: note.headers } : {}),
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
}

/** 运行态表：sessionId → 正在跑的那一轮。「在不在跑」的唯一真值。 */
const running = new Map<string, CycleSlot<TurnParts>>();

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
    resolve({ behavior: "deny", message: "已停止" });
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

  // 审批走 pi 官方的 `tool_call` 扩展钩子：block 即拒绝，原地改 input 即改写入参。
  // 内建工具默认全开，不需要我们自己装配。
  // **模式读账本**：跨轮的 mode 在 ledger，不在 pi 对象上——对象这轮结束就销毁了。
  const currentMode = () => ledgerNote(command.sessionId).mode;
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
            // 切模式下一轮就生效；只在开机时讲一次的话，切了模式模型还按旧的答。
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

  const adapter = new TranscriptAdapter({ newId: () => randomUUID(), now: () => Date.now() });
  const echoed = note.echoed;
  const unsubscribe = session.subscribe((event) => {
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
      for (const progress of adapter.apply(adaptable)) {
        send({ type: "progress", sessionId: command.sessionId, progress });
      }
      // usage 与这条 LLM 响应一起落账：消息完成即推，轮内多次工具往返时数字逐条跳。
      // 一轮多推几个几百字节的小对象，比起上面每条 delta 一帧的流式转发可忽略。
      if (event.type === "message_end") pushStats(command.sessionId, session);
      return;
    }
    if (event.type === "agent_start") send({ type: "phase", sessionId: command.sessionId, phase: "turn" });
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

  return { session, adapter, unsubscribe };
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
function startTurn(command: OpenInput, run: (opened: OpenedTurn) => Promise<void>): Promise<void> {
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
      };
    },
    async (parts) => run({ session: parts.session, adapter: parts.adapter, unsubscribe: parts.unsubscribe }),
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
 */
async function branchPiSession(command: Extract<AgentCommand, { type: "branch" }>): Promise<void> {
  const manager = SessionManager.open(command.sourcePiSessionFile, undefined, command.cwd);
  const targetId = planBranchCut(manager.getEntries(), command.roles);
  const branchFile = manager.createBranchedSession(targetId);
  if (branchFile === undefined) throw new Error("pi 没有产出分支文件");
  // 复用 created 事件通路：主进程对 branch 与开机用同一条等待逻辑
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

  // 分支带的是「新会话的 id」，此刻账本里还没有——不依赖任何表，直接裁文件
  if (command.type === "branch") {
    await branchPiSession(command);
    return;
  }

  if (command.type === "submit") {
    await startTurn(command, async (opened) => {
      const note = ledgerNote(command.sessionId);
      // 用户消息先落地再发给模型——不等模型回，UI 立刻看得到自己刚说的话。
      // echoed 记一笔：pi 随后 emit 的 message_start 是这条的回声，别重复显示。
      // expandPromptTemplates 关掉：展开会改写文本，破坏按文本做的回声对账；
      // 且本仓没有 skill / template / 斜杠命令的 UI，展开本就无对象。
      note.echoed.add(command.text);
      for (const progress of opened.adapter.userPrompt(command.text)) {
        send({ type: "progress", sessionId: command.sessionId, progress });
      }
      await opened.session.prompt(command.text, { expandPromptTemplates: false });
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
        const note = ledgerNote(command.sessionId);
        note.echoed.add(command.text);
        for (const progress of opened.adapter.userPrompt(command.text)) {
          send({ type: "progress", sessionId: command.sessionId, progress });
        }
        await opened.session.prompt(command.text, { expandPromptTemplates: false });
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
      await startTurn(command, (opened) =>
        withManualCompactionTuning(opened.session, () => opened.session.compact(command.instructions)),
      );
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
      void generateSessionTitle(note, current.opened.session, command.sessionId, command.text);
    }
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
