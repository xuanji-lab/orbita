/**
 * 子会话：派出 / 通道发信 / 代父发言的落地（子会话 2026-09-23 裁决）。
 *
 * 分层与 `session/read-task.ts` 的 `applyReadTask`、`agent/write-requests.ts` 同款：
 * **纯核 + 依赖注入**（`ChannelDeps`），可被 `node --test` 用真 SessionStore /
 * ChannelStore + 假 submitTurn/steer/broadcast 直测，不 import electron。
 *
 * 三个入口：
 *   applyDelegate    —— 父模型的 delegate 工具请求（agent 进程 → delegateRequest 事件）
 *   applyChannelSend —— 父的 reply_subsession / 子的 report_to_parent（channelSendRequest 事件）
 *   applySpeak       —— 用户在通道 composer 里代父发言（channel:speak IPC）
 */
import { randomUUID } from "node:crypto";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import type {
  AgentEvent,
  ChannelEvent,
  ChannelSendOutcome,
  ChannelSpeakInput,
  DelegateOutcome,
  SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import {
  allowedKinds,
  channelStatus,
  composeChannelPrompt,
  type ChannelDelivery,
  type ChannelKey,
  type ChannelMessage,
} from "../../shared/channel.ts";
import { defaultThinkingLevel } from "../../shared/model-defaults.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import { deriveSessionTitle, type SessionMeta } from "../../shared/session.ts";
import type { AppSettings, TitleModel } from "../../shared/settings.ts";
import { isThinkingLevel, type ThinkingLevel } from "../../shared/thinking.ts";
import type { ChannelStore } from "./store.ts";
import type { SessionStore } from "../session/store.ts";

/** applyDelegate / applyChannelSend / applySpeak 对外部世界的全部所需——纯核 + 注入。 */
export interface ChannelDeps {
  sessions: SessionStore;
  channels: ChannelStore;
  /** 最小只读视图：resolveSubSessionModel 只要 id 与声明的模型列表 */
  providers: { list(): Promise<ProviderDto[]> };
  settings: { read(): Promise<AppSettings> };
  /** 开一轮（`registerAgentIpc` 返回的那个函数，子首轮与父→子空闲投递共用它） */
  submitTurn(input: SubmitAgentInput): Promise<void>;
  /** 父→子注入（`AgentHostCore.steer`）：目标在跑时用它，抛错 = 投递失败 */
  steer(sessionId: string, text: string, delivery: ChannelDelivery): void;
  /** 主进程按 phase 事件维护的活会话状态；用来判断目标此刻是不是空闲 */
  phases: Map<string, SessionPhase>;
  broadcast(event: ChannelEvent): void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ── 子会话模型解析 ──

export type SubSessionModelResult =
  | {
      ok: true;
      providerId: string;
      modelId: string;
      /**
       * 这个模型是怎么定下来的——applyDelegate 按它决定思考档的解析路（同一刀
       * 「思考档跟着模型走」）：`requested` = delegate 参数指名；`setting` =
       * `AppSettings.subSessionModel`；`parent` = 同父（含两条都没给、或
       * setting 指的 provider 已删退回同父）。
       */
      source: "requested" | "setting" | "parent";
    }
  | { ok: false; error: string };

/**
 * 子会话的模型解析（纯函数）。优先级：`requested`（delegate 参数）>
 * `setting`（`AppSettings.subSessionModel`）> `parent`（同父）。
 *
 * requested 有值时：先看父的 provider 是否声明了这个模型 id（多半如此——模型
 * 通常只是换一个同 provider 下的型号），否则取第一个声明了它的 provider；
 * 两条都没有 → error，附全部可用模型 id（去重）方便模型改道重试。
 */
export function resolveSubSessionModel(input: {
  requested: string | undefined;
  setting: TitleModel | undefined;
  parent: { providerId: string; modelId: string };
  providers: readonly ProviderDto[];
}): SubSessionModelResult {
  if (input.requested !== undefined) {
    const requestedId = input.requested;
    const parentProvider = input.providers.find((provider) => provider.id === input.parent.providerId);
    if (parentProvider?.models.declared.some((model) => model.id === requestedId) === true) {
      return { ok: true, providerId: parentProvider.id, modelId: requestedId, source: "requested" };
    }
    const owner = input.providers.find((provider) =>
      provider.models.declared.some((model) => model.id === requestedId),
    );
    if (owner !== undefined) return { ok: true, providerId: owner.id, modelId: requestedId, source: "requested" };
    const available = [
      ...new Set(input.providers.flatMap((provider) => provider.models.declared.map((model) => model.id))),
    ];
    return {
      ok: false,
      error: `Model "${requestedId}" is not configured. Available models: ${
        available.length > 0 ? available.join(", ") : "(none configured)"
      }`,
    };
  }
  if (input.setting !== undefined) {
    const provider = input.providers.find((candidate) => candidate.id === input.setting?.providerId);
    if (provider !== undefined) {
      return { ok: true, providerId: provider.id, modelId: input.setting.modelId, source: "setting" };
    }
    // 易耗品处理，同 readTitleModel（agent/ipc.ts）：设置指的 provider 被删了不该
    // 拦住派出，退回同父；但原因要落到 dev 终端，否则「为什么没用我设的模型」无从查起。
    console.error(
      `[main] 子会话默认模型 ${input.setting.providerId}/${input.setting.modelId} 的 provider 已删，退回同父`,
    );
  }
  return { ok: true, providerId: input.parent.providerId, modelId: input.parent.modelId, source: "parent" };
}

// ── 派出（delegate）──

export async function applyDelegate(
  deps: ChannelDeps,
  event: Extract<AgentEvent, { type: "delegateRequest" }>,
): Promise<DelegateOutcome> {
  const parent = await deps.sessions.readMeta(event.sessionId);
  if (parent === null) return { ok: false, error: `Session ${event.sessionId} was not found.` };
  if (parent.parentId !== undefined) {
    return {
      ok: false,
      error:
        "This session is itself a sub-session, and sub-sessions cannot delegate further — only one level is supported today.",
    };
  }

  const title = deriveSessionTitle(event.title);
  const task = event.task.trim();
  if (title === "") return { ok: false, error: "title must not be empty." };
  if (task === "") return { ok: false, error: "task must not be empty." };
  if (event.thinkingLevel !== undefined && !isThinkingLevel(event.thinkingLevel)) {
    return { ok: false, error: `"${event.thinkingLevel}" is not a valid thinking level.` };
  }

  const settings = await deps.settings.read();
  const providers = await deps.providers.list();
  const resolved = resolveSubSessionModel({
    requested: event.modelId,
    setting: settings.subSessionModel,
    parent: { providerId: parent.providerId, modelId: parent.modelId },
    providers,
  });
  if (!resolved.ok) return resolved;
  // 思考档跟着模型走（用户裁决 wafo 2026-09-23）：delegate 显式给的档最优先；
  // 否则按模型是怎么定下来的（resolved.source）分流——模型来自 delegate 参数
  // 就落它的默认档（不是父的档，父可能跑着完全不同的型号）；模型来自设置就
  // 用设置里的子会话思考档，缺席也是落它的默认档；同父才真正继承父的档。
  // 主进程拿不到目录，defaultThinkingLevel 不传 supported——pi 发送前按同一
  // 规则夹，结果与 renderer 算的一致（见 defaultThinkingLevel 的注释）。
  const thinkingLevel: ThinkingLevel =
    event.thinkingLevel ??
    (resolved.source === "requested"
      ? defaultThinkingLevel(resolved.modelId)
      : resolved.source === "setting"
        ? (settings.subSessionThinking ?? defaultThinkingLevel(resolved.modelId))
        : parent.thinkingLevel);

  const childId = randomUUID();
  const taskMessage: ChannelMessage = {
    id: randomUUID(),
    from: "parent",
    author: "model",
    kind: "task",
    text: task,
    delivery: "followUp",
    createdAt: Date.now(),
  };

  // 先建子 meta 再开轮：ensureSession 对已存在的 meta 只校准 piSessionFile
  // （见 SessionStore.ensureSession），所以首轮 settle 不会把这份初始 meta 盖掉。
  // titleSource "user"：模型起的名就是最终名，不走 auto-title（SessionMeta.parentId 注释）。
  const now = Date.now();
  await deps.sessions.ensureSession({
    id: childId,
    title,
    titleSource: "user",
    cwd: parent.cwd,
    workspaceId: parent.workspaceId,
    parentId: parent.id,
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    mode: parent.mode,
    thinkingLevel,
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: now,
    updatedAt: now,
  });
  await deps.channels.append({ parentId: parent.id, childId }, taskMessage);

  // 乐观占位：防止 phase 事件到达前的第二次投递撞 already running
  deps.phases.set(childId, "turn");
  try {
    await deps.submitTurn({
      sessionId: childId,
      cwd: parent.cwd,
      workspaceId: parent.workspaceId,
      resume: null,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      mode: parent.mode,
      thinkingLevel,
      text: composeChannelPrompt(taskMessage, { id: parent.id, title: parent.title }),
    });
  } catch (cause) {
    // 失败回滚：占位、子 meta、通道文件（remove 级联）都不该留下
    deps.phases.delete(childId);
    await deps.sessions.remove(childId);
    return { ok: false, error: `Failed to start the sub-session: ${errorMessage(cause)}` };
  }

  // 不写父侧标记：父流里 delegate 工具的结果卡就是它的投影（下一刀的 renderer PR 画）。
  // 子侧的 task 标记由 recorder 在子首轮的 user item_started 出现时落（Commit C）。
  deps.broadcast({ type: "message", parentId: parent.id, childId, message: taskMessage });
  deps.broadcast({ type: "status", parentId: parent.id, childId, status: channelStatus([taskMessage]) });

  return {
    ok: true,
    childId,
    title,
    card: {
      childId,
      title,
      modelId: resolved.modelId,
      thinkingLevel,
      workbench: deps.sessions.workbenchPath(childId),
    },
  };
}

// ── 发信（reply_subsession / report_to_parent）──

export async function applyChannelSend(
  deps: ChannelDeps,
  event: Extract<AgentEvent, { type: "channelSendRequest" }>,
): Promise<ChannelSendOutcome> {
  const sender = await deps.sessions.readMeta(event.sessionId);
  if (sender === null) return { ok: false, error: `Session ${event.sessionId} was not found.` };
  const text = event.text.trim();
  if (text === "") return { ok: false, error: "Message text must not be empty." };

  if (event.to === "parent") {
    if (sender.parentId === undefined) {
      return {
        ok: false,
        error: "This session has no parent session — report_to_parent has nothing to report to.",
      };
    }
    const parent = await deps.sessions.readMeta(sender.parentId);
    if (parent === null) return { ok: false, error: "The parent session no longer exists." };
    if (!allowedKinds("child").includes(event.kind)) {
      return {
        ok: false,
        error: `"${event.kind}" is not valid for a sub-session → parent message; use question, progress, done or failed.`,
      };
    }
    const key: ChannelKey = { parentId: parent.id, childId: sender.id };
    // 子→父恒 followUp：进父的 renderer 队列，本 PR 不为它开轮、不 steer父——
    // 那是后续 PR 的事，主进程这里只落账 + 广播。
    const message: ChannelMessage = {
      id: randomUUID(),
      from: "child",
      author: "model",
      kind: event.kind,
      text,
      delivery: "followUp",
      createdAt: Date.now(),
    };
    await deps.channels.append(key, message);
    await broadcastAfterAppend(deps, key, message);
    return { ok: true, messageId: message.id };
  }

  const child = await deps.sessions.readMeta(event.to.childId);
  if (child === null || child.parentId !== sender.id) {
    return { ok: false, error: `Session ${event.to.childId} is not a sub-session of this session.` };
  }
  if (event.kind !== "reply") {
    return {
      ok: false,
      error: `"${event.kind}" is not valid for a parent → sub-session message; only "reply" is allowed (a new task can only be created with delegate).`,
    };
  }
  const key: ChannelKey = { parentId: sender.id, childId: child.id };
  const message: ChannelMessage = {
    id: randomUUID(),
    from: "parent",
    author: "model",
    kind: "reply",
    text,
    delivery: event.delivery ?? "steer",
    createdAt: Date.now(),
  };
  await deps.channels.append(key, message);
  await broadcastAfterAppend(deps, key, message);
  try {
    await deliverToChild(deps, child, sender, message);
  } catch (cause) {
    return {
      ok: false,
      error: `The message was recorded in the channel, but delivery failed: ${errorMessage(cause)}`,
    };
  }
  return { ok: true, messageId: message.id };
}

// ── 代父发言（channel:speak）──

/** 用户在通道 composer 里代父发的那句话。校验失败抛错——preload 的 invoke 会把它翻成 IPC reject。 */
export async function applySpeak(deps: ChannelDeps, input: ChannelSpeakInput): Promise<ChannelMessage> {
  const parent = await deps.sessions.readMeta(input.parentId);
  if (parent === null) throw new Error(`Session ${input.parentId} was not found.`);
  const child = await deps.sessions.readMeta(input.childId);
  if (child === null || child.parentId !== parent.id) {
    throw new Error(`Session ${input.childId} is not a sub-session of ${input.parentId}.`);
  }
  const text = input.text.trim();
  if (text === "") throw new Error("Message text must not be empty.");

  const key: ChannelKey = { parentId: parent.id, childId: child.id };
  const message: ChannelMessage = {
    id: randomUUID(),
    from: "parent",
    author: "user",
    kind: "reply",
    text,
    delivery: input.delivery,
    createdAt: Date.now(),
  };
  await deps.channels.append(key, message);
  // 不写父侧标记（子会话 2026-09-23 不变量修正）：ChannelMarkRecord 顶替的是 pi
  // 本子里的一条 user 消息（接收侧标记）——代父发言没有对应的接收方，父的 pi
  // 本子里没有多出一条 user 消息，这里写一条标记就会破坏「每条标记都顶替一条
  // user 消息」的不变量，按位对账（branchRoles）会失真。用户代父说的话在通道列
  // 里可见（下一个 PR），父的对话流不需要它。
  await broadcastAfterAppend(deps, key, message);
  await deliverToChild(deps, child, parent, message);
  return message;
}

// ── 内部：投递给子 + 落账后的通用广播 ──

async function broadcastAfterAppend(deps: ChannelDeps, key: ChannelKey, message: ChannelMessage): Promise<void> {
  deps.broadcast({ type: "message", parentId: key.parentId, childId: key.childId, message });
  deps.broadcast({
    type: "status",
    parentId: key.parentId,
    childId: key.childId,
    status: channelStatus(await deps.channels.load(key)),
  });
}

/**
 * 把一条父→子消息真正送进子会话：正在跑就 steer 注入，空闲就当普通开轮。
 *
 * **已知限制**（不在本 PR 解决）：子这一轮恰好在 steer 到达前收尾，runtime 会
 * 回 failed（`runtime.ts` 的 steer 处理，目标不在跑就说明状态失步）。消息已经
 * 落在通道里，只是没有真正送达模型——用户能在通道里看到它，重发即可。
 */
async function deliverToChild(
  deps: ChannelDeps,
  child: SessionMeta,
  parent: SessionMeta,
  message: ChannelMessage,
): Promise<void> {
  const text = composeChannelPrompt(message, { id: parent.id, title: parent.title });
  const phase = deps.phases.get(child.id);
  if (phase !== undefined && phase !== "idle") {
    deps.steer(child.id, text, message.delivery);
    return;
  }
  // 空闲：delivery 对开轮无意义（没有正在跑的轮可注入），一律当普通开轮。
  deps.phases.set(child.id, "turn");
  try {
    await deps.submitTurn({
      sessionId: child.id,
      cwd: child.cwd,
      workspaceId: child.workspaceId,
      resume: child.piSessionFile === null ? null : { piSessionFile: child.piSessionFile },
      providerId: child.providerId,
      modelId: child.modelId,
      mode: child.mode,
      thinkingLevel: child.thinkingLevel,
      text,
    });
  } catch (cause) {
    deps.phases.delete(child.id);
    throw cause;
  }
}
