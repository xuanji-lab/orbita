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
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../shared/permission.ts";
import {
  createToolCallGate,
  describePermissionMode,
  type PiExtensionApi,
} from "./permission.ts";
import { TranscriptAdapter, type AdaptableEvent } from "./transcript-adapter.ts";

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

/** 一个 session 的运行时状态。N 个 session 共用本进程（Q8：多 session 形状从第一天就有）。 */
interface LiveSession {
  session: AgentSession;
  adapter: TranscriptAdapter;
  unsubscribe: () => void;
  mode: PermissionMode;
}

const sessions = new Map<string, LiveSession>();

/** 等待用户回答的审批请求。key 是 requestId——一次工具调用一个。 */
const pendingPermissions = new Map<string, (answer: PermissionAnswer) => void>();

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
 * 模型能力字段的保守默认（Q2）：pi 的 ProviderConfigInput.models[] 这些字段必填，
 * 而我们的 ModelDecl 全是可选。**内建 provider（zai / deepseek…）不会走到这里**——
 * pi 的目录（每 4 小时从 pi.dev 刷新）已有官方参数，我们注册的同名条目只补 apiKey/baseUrl。
 * 这些默认只服务于自建网关这条逃生路径：填错影响的是压缩时机与用量统计，不影响能不能跑。
 */
const FALLBACK_MODEL = {
  reasoning: false,
  input: ["text"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function toProviderConfig(provider: Extract<AgentCommand, { type: "create" }>["provider"]) {
  return {
    apiKey: provider.apiKey,
    baseUrl: provider.baseUrl,
    api: provider.api,
    ...(provider.headers ? { headers: provider.headers } : {}),
    models: provider.models.map((id) => ({ id, name: id, ...FALLBACK_MODEL })),
  };
}

/** AgentSession 的事件里，只有这三种需要翻给 renderer；其余（工具、压缩、重试）等后续 slice。 */
function asAdaptable(event: { type: string }): AdaptableEvent | null {
  if (event.type === "message_start" || event.type === "message_update" || event.type === "message_end") {
    return event as AdaptableEvent;
  }
  return null;
}

async function createSession(command: Extract<AgentCommand, { type: "create" }>): Promise<void> {
  // provider 经内存注册交给 pi，不写 models.json / auth.json（提案 §2.2「内核读 Provider 不读文件」）
  const modelRuntime = await ModelRuntime.create({});
  modelRuntime.registerProvider(command.provider.id, toProviderConfig(command.provider));

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
              systemPrompt: `${event.systemPrompt}\n\n${describePermissionMode(currentMode())}`,
            }));
          },
        },
      ],
    },
  });
  const { session } = await createAgentSessionFromServices({ services });

  const adapter = new TranscriptAdapter({ newId: () => randomUUID(), now: () => Date.now() });
  const unsubscribe = session.subscribe((event) => {
    const adaptable = asAdaptable(event);
    if (adaptable) {
      for (const progress of adapter.apply(adaptable)) {
        send({ type: "progress", sessionId: command.sessionId, progress });
      }
      return;
    }
    if (event.type === "agent_start") send({ type: "phase", sessionId: command.sessionId, phase: "turn" });
    if (event.type === "agent_settled") send({ type: "phase", sessionId: command.sessionId, phase: "idle" });
  });

  sessions.set(command.sessionId, { session, adapter, unsubscribe, mode: command.mode });
  send({ type: "created", sessionId: command.sessionId });
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
      models: models.map((model) => model.id),
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

  const live = sessions.get(command.sessionId);
  if (!live) throw new Error(`unknown session ${command.sessionId}`);

  if (command.type === "setMode") {
    live.mode = command.mode;
    return;
  }
  if (command.type === "submit") {
    // 用户消息先落地再发给模型——不等模型回，UI 立刻看得到自己刚说的话
    for (const progress of live.adapter.userPrompt(command.text)) {
      send({ type: "progress", sessionId: command.sessionId, progress });
    }
    await live.session.prompt(command.text);
    return;
  }
  if (command.type === "abort") {
    live.session.abort();
    return;
  }
  live.unsubscribe();
  live.session.dispose();
  sessions.delete(command.sessionId);
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
