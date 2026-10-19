/**
 * 子会话：派出 / 通道发信 / 代父发言 / 终止的落地（子会话 2026-09-23 裁决）。
 *
 * 分层与 `session/read-task.ts` 的 `applyReadTask`、`agent/write-requests.ts` 同款：
 * **纯核 + 依赖注入**（`ChannelDeps`），可被 `node --test` 用真 SessionStore /
 * ChannelStore + 假 submitTurn/steer/broadcast 直测，不 import electron。
 *
 * 四个入口：
 *   applyDelegate    —— 父模型的 delegate 工具请求（agent 进程 → delegateRequest 事件）
 *   applyChannelSend —— 父的 reply_subsession / 子的 report_to_parent（channelSendRequest 事件）
 *   applySpeak       —— 用户在通道 composer 里代父发言（channel:speak IPC）
 *   applyStop        —— 用户终止一个子会话（channel:stop IPC；中止在跑的轮 +
 *     结掉挂着的浏览器交接 + 账本落 stop，状态翻 stopped）
 */
import { randomUUID } from "node:crypto";
import type { SessionPhase } from "@earendil-works/pi-protocol";
import type {
  AgentEvent,
  ChannelEvent,
  ChannelSendOutcome,
  ChannelSpeakInput,
  ChannelStopInput,
  DelegateOutcome,
  SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import { usableSubSessionSetting } from "../../shared/available-models.ts";
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
import { deriveSessionTitle, childSessions, isSessionDone, type SessionMeta } from "../../shared/session.ts";
import type { AppSettings, ModelPair } from "../../shared/settings.ts";
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
  /** 停掉一条会话正在跑的这一轮（`agent:abort` 的 host.abort）——终止子会话三步的第一步 */
  abort(sessionId: string): Promise<void>;
  /** 按取消结掉这条会话挂着的浏览器交接（`BrowserSandbox.cancelSessionHandoff`，幂等）——第二步 */
  cancelBrowserHandoff(sessionId: string): void;
  /** 主进程按 phase 事件维护的活会话状态；用来判断目标此刻是不是空闲 */
  phases: Map<string, SessionPhase>;
  broadcast(event: ChannelEvent): void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * 同时在跑的直系子会话上限（2026-10-18 第三轮验收）。
 *
 * 提示词里写了「最多 3 个同时跑、其余排队」，但实测一条消息派 4 个照样全部起
 * （四个子会话 meta 的 createdAt 落在同一毫秒段）——只靠自律不稳。这里给硬闸：
 * 只数 phase 还活着的直系子会话；applyDelegate 在 submitTurn 前就先占位，
 * 同一批 4 个 delegate 依次进来时计数是准的。
 */
const MAX_RUNNING_CHILDREN = 3;

/**
 * 计入上限的 phase：**非 idle 才算在跑**。
 *
 * 轮结束会写入 `idle`（main/index.ts 的 phase 事件），键留在 map 里是正常的——
 * 判 `phases.has()` 会把所有跑过的子会话永远算成在跑，名额永不释放。
 * 2026-10-19 真机验收踩到：3 个子会话全部完成 / 被终止后，第 4 个仍被拒。
 */
function isRunningPhase(phase: SessionPhase | undefined): boolean {
  return phase !== undefined && phase !== "idle";
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
  setting: ModelPair | undefined;
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
  // 设置里的子会话模型只在它的 provider 还在时才算数：判据与提示词侧
  // （agent/ipc.ts 的 readSubSessionModel → delegation-prompt 的默认落点）同源。
  const setting = usableSubSessionSetting(input.setting, input.providers);
  if (setting !== undefined) {
    return { ok: true, providerId: setting.providerId, modelId: setting.modelId, source: "setting" };
  }
  if (input.setting !== undefined) {
    // 易耗品处理，同 readChoreModel（agent/ipc.ts）：设置指的 provider 被删了不该
    // 拦住派出，退回同父；但原因要落到 dev 终端，否则「为什么没用我设的模型」无从查起。
    console.error(
      `[main] 子会话默认模型 ${input.setting.providerId}/${input.setting.modelId} 的 provider 已删，退回同父`,
    );
  }
  // 同父的前提是父的 provider 还在注册表里。两种情况拿不到：导入的会话 meta 落的是
  // 占位 provider（orbita:unassigned，导入与模型解耦），或父的 provider 已被删。
  // 不猜第一个可用模型——渠道选择不归我们替用户做（同导入不映射模型的裁决），
  // 把可用模型列出来让 delegate 带上 modelId 重试。
  const parentProvider = input.providers.find((provider) => provider.id === input.parent.providerId);
  if (parentProvider === undefined) {
    const available = [
      ...new Set(input.providers.flatMap((provider) => provider.models.declared.map((model) => model.id))),
    ];
    return {
      ok: false,
      error: `The parent session has no usable model assigned, so the sub-session cannot inherit one. Retry with an explicit modelId. Available models: ${
        available.length > 0 ? available.join(", ") : "(none configured)"
      }`,
    };
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

  const runningChildren = childSessions(await deps.sessions.list(), parent.id).filter((child) =>
    isRunningPhase(deps.phases.get(child.id)),
  );
  if (runningChildren.length >= MAX_RUNNING_CHILDREN) {
    const titles = runningChildren
      .slice(0, MAX_RUNNING_CHILDREN)
      .map((child) => `"${child.title}"`)
      .join(", ");
    return {
      ok: false,
      error:
        `You already have ${runningChildren.length} sub-sessions running (${titles}). ` +
        "Wait for one to report, or stop one, before delegating another — start the rest after a report.",
    };
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

  // 派完之后手上还开着的直系子会话（含刚派出的这个，所以在建完子会话之后算）：
  // count 是真实总数（不受 ids 的 8 条上限影响），ids 按 createdAt 倒序取前 8。
  // 工具结果用它告诉模型「你现在有 N 个开着的、它们是谁」——台账路由的
  // 提示而非法闸（硬闸只有上面的 MAX_RUNNING_CHILDREN）。
  const open = childSessions(await deps.sessions.list(), parent.id).filter((child) => !isSessionDone(child));
  open.sort((a, b) => b.createdAt - a.createdAt);

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
    openChildren: { count: open.length, ids: open.slice(0, 8).map((child) => child.id) },
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
    // 用户终止过的通道是关着的：子的回报也拒（窗口期只有终止在途的那几毫秒——
    // abort 已经把正在跑的轮砍了，之后的 report_to_parent 不该再落账）。
    if (channelStatus(await deps.channels.load(key)) === "stopped") {
      return {
        ok: false,
        error:
          "This sub-session was stopped by the user; its channel is closed. Only the user can re-open it by speaking as the parent in the channel.",
      };
    }
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
  // 投递**之前**的目标通道状态：父→子的 reply 一落账就把状态翻回 running，
  // 事后读不到「它曾经交付过」。done = 已交付——工具结果据此提醒模型新任务走
  // delegate（提示而非硬拦：改它自己写的东西仍然合法）。
  const statusBefore = channelStatus(await deps.channels.load(key));
  // **核心语义（用户裁决）**：被用户终止的子会话，父模型的 reply 不能重开它——
  // 否则父会话通过回信绕过用户的决定。只有用户在通道里代父发言
  // （applySpeak，author user）能重开。错误文本写给模型看，把路指给用户。
  if (statusBefore === "stopped") {
    return {
      ok: false,
      error:
        "This sub-session was stopped by the user and cannot receive messages. Only the user can re-open it by speaking as the parent in the channel — end this turn and tell the user if they need it running again.",
    };
  }
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
  return { ok: true, messageId: message.id, targetStatus: statusBefore };
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

// ── 终止（channel:stop）──

/**
 * 用户终止一个子会话（`channel:stop` IPC，子会话面板会话层的入口）。三步：
 *
 * 1. 在跑就中止这一轮（`agent:abort` 的同一条路）。只在 phase 显示在跑时才发——
 *    host.abort 会 ensure 拉起 agent 进程，对一个空闲的子会话这么做是末倒置。
 * 2. 挂着的浏览器交接按取消结掉（`BrowserSandbox.cancelSessionHandoff`，幂等）。
 *    phase 回 idle 时主进程也会结（index.ts），这里显式再结一次：不依赖事件时序，
 *    也覆盖「子空闲但交接还挂着」的在等子会话。
 * 3. 账本落一条 parent 侧的 stop（author user），状态翻 stopped。此后的硬拦在
 *    `applyChannelSend`（父模型的 reply 被拒）、重开只在 `applySpeak`（用户代父发言）。
 *
 * 不给父会话新开一轮通知它（用户裁决：默认不为此花一次模型调用）——父模型
 * 下次调 reply_subsession 会拿到明确的错误文本，那就是它知道这件事的时刻。
 *
 * 校验失败抛错（同 applySpeak）：preload 的 invoke 会把它翻成 IPC reject。
 */
export async function applyStop(deps: ChannelDeps, input: ChannelStopInput): Promise<void> {
  const parent = await deps.sessions.readMeta(input.parentId);
  if (parent === null) throw new Error(`Session ${input.parentId} was not found.`);
  const child = await deps.sessions.readMeta(input.childId);
  if (child === null || child.parentId !== parent.id) {
    throw new Error(`Session ${input.childId} is not a sub-session of ${input.parentId}.`);
  }
  const key: ChannelKey = { parentId: parent.id, childId: child.id };
  if (channelStatus(await deps.channels.load(key)) === "stopped") {
    // 幂等护栏（正常进不了这里：面板在 stopped 态禁用入口）：再终止一次没有意义，
    // 但也不静默成功——静默会让「我以为停的是另一条」无从察觉。
    throw new Error("This sub-session is already stopped. Speak as the parent in the channel to re-open it.");
  }
  const phase = deps.phases.get(child.id);
  if (phase !== undefined && phase !== "idle") await deps.abort(child.id);
  // 终止是终态：把 phase 键也清掉，别让上限把这条件算成「在跑」（abort 不保证
  // 一定再回来一个 idle 事件）。
  deps.phases.delete(child.id);
  deps.cancelBrowserHandoff(child.id);
  const message: ChannelMessage = {
    id: randomUUID(),
    from: "parent",
    author: "user",
    kind: "stop",
    text: "",
    delivery: "followUp",
    createdAt: Date.now(),
  };
  await deps.channels.append(key, message);
  await broadcastAfterAppend(deps, key, message);
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
