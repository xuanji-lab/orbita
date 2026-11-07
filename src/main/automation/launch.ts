/**
 * 自动化的一次触发（实验功能 automation）：两种去处各一个入口——
 * `launchAutomationRun`（new_session）开一条新会话并开一轮；`deliverAutomationRun`（this_session）
 * 把指令送回创建它的那条会话。
 *
 * new_session 的套路照抄 `channel/requests.ts` 的 `applyDelegate`：**先 `ensureSession` 建 meta、再 `submitTurn`
 * 开轮，开轮失败就把刚建的会话回滚掉**——失败的触发不该在侧栏之外留下一条永远打不开的会话。
 * 与 delegate 的区别：没有父会话，所以模型不「同父」，而是自己解析（见 `resolveAutomationModel`）；
 * 会话的 meta 记 `automationId`，左栏不列它、它自己的 agent 不注册 automation_* 工具（防递归）。
 *
 * 纯核 + 依赖注入：可被 `node --test` 用真 SessionStore + 假 submitTurn 直测，不 import electron。
 */
import { defaultThinkingLevel } from "../../shared/model-defaults.ts";
import {
  AUTOMATION_LAST_RESULT_MAX,
  automationWorkspaceId,
  composeAutomationHeader,
  formatAutomationStamp,
  type Automation,
  type AutomationRunTrigger,
} from "../../shared/automation.ts";
import type { SubmitAgentInput } from "../../shared/agent-ipc.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import { UNASSIGNED_MODEL_ID, UNASSIGNED_PROVIDER_ID } from "../../shared/session.ts";
import type { AppSettings } from "../../shared/settings.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { resolveSubSessionModel } from "../channel/requests.ts";
import type { SessionStore } from "../session/store.ts";

export interface LaunchDeps {
  sessions: Pick<SessionStore, "ensureSession" | "remove" | "readMeta">;
  /** 最小只读视图：模型解析只要 id 与声明的模型列表 */
  providers: { list(): Promise<ProviderDto[]> };
  settings: { read(): Promise<AppSettings> };
  workspaces: { list(): Promise<Workspace[]>; defaultPath(): string };
  /** `registerAgentIpc` 返回的那个函数——与 delegate、用户发消息共用同一套开轮装配 */
  submitTurn(input: SubmitAgentInput): Promise<void>;
}

export type AutomationModelResult =
  | { ok: true; providerId: string; modelId: string; thinkingLevel: ThinkingLevel }
  | { ok: false; error: string };

/**
 * 自动化的模型解析：复用 `resolveSubSessionModel` 那套优先级，但**不继承任何手动会话的设置**
 * （自动化没有「父会话」）。顺序：
 *   1. 自动化自己指名的 provider + 模型（卡上写着的）；
 *   2. 设置里的子会话默认模型（`subSessionModel`，思考档用 `subSessionThinking`）；
 *   3. 应用上次使用的模型（`lastUsed`，是启动恢复点，不属于哪条会话）。
 * 三条都落空就报错并写清怎么办——**不猜第一个可用模型**（渠道选择不归我们替用户做，同 delegate 的裁决）。
 * 思考档跟着模型走：自动化显式给的最优先；否则按模型怎么定下来的取设置档或该模型的默认档。
 */
export function resolveAutomationModel(input: {
  automation: Pick<Automation, "providerId" | "modelId" | "thinkingLevel">;
  settings: Pick<AppSettings, "subSessionModel" | "subSessionThinking" | "lastUsed">;
  providers: readonly ProviderDto[];
}): AutomationModelResult {
  const { automation, settings, providers } = input;
  const last = settings.lastUsed;
  const lastUsed =
    last?.providerId !== undefined &&
    last.modelId !== undefined &&
    providers.some((provider) => provider.id === last.providerId)
      ? { providerId: last.providerId, modelId: last.modelId }
      : undefined;

  if (automation.providerId !== undefined && automation.modelId !== undefined) {
    const { providerId, modelId } = automation;
    const provider = providers.find((candidate) => candidate.id === providerId);
    if (provider?.models.declared.some((model) => model.id === modelId) !== true) {
      return {
        ok: false,
        error: `The model ${providerId}/${modelId} set on this automation is no longer available. Edit the automation to pick another model.`,
      };
    }
    return {
      ok: true,
      providerId,
      modelId,
      thinkingLevel: automation.thinkingLevel ?? defaultThinkingLevel(modelId),
    };
  }

  const resolved = resolveSubSessionModel({
    requested: undefined,
    setting: settings.subSessionModel,
    // 占位只为满足签名：lastUsed 缺席时 source 落到 parent 会被下面拦成报错
    parent: lastUsed ?? { providerId: UNASSIGNED_PROVIDER_ID, modelId: UNASSIGNED_MODEL_ID },
    providers,
  });
  if (!resolved.ok || (resolved.source === "parent" && lastUsed === undefined)) {
    return {
      ok: false,
      error:
        "No model is available for this automation. Pick a model on the automation, or set a default sub-session model in Settings.",
    };
  }
  const thinkingLevel: ThinkingLevel =
    automation.thinkingLevel ??
    (resolved.source === "setting"
      ? (settings.subSessionThinking ?? defaultThinkingLevel(resolved.modelId))
      : defaultThinkingLevel(resolved.modelId));
  return { ok: true, providerId: resolved.providerId, modelId: resolved.modelId, thinkingLevel };
}

/** 截到 max 个字符，超出加省略号（按码点切，不劈开代理对） */
export function clipText(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

/**
 * new_session 发给模型的文本：首行抬头 `[定时任务「标题」第 n 次 · 时间]`（上限是 max 时写 n/max），
 * 然后是指令；有上一次成功的最终回答，附上（截到约 2KB）标成「上次结果」——
 * 让模型能说出这次**什么是新的**，而不是每次重讲一遍。
 * this_session 不附上次结果：那条会话的对话里本来就有上一次。
 */
export function composeAutomationPrompt(input: {
  title: string;
  number: number;
  max?: number;
  at: number;
  prompt: string;
  lastResult?: string;
}): string {
  const head = composeAutomationHeader({
    title: input.title,
    number: input.number,
    ...(input.max === undefined ? {} : { max: input.max }),
    at: input.at,
  });
  const last =
    input.lastResult !== undefined && input.lastResult.trim() !== ""
      ? `\n\n上次结果（供对照，说出这次有什么新的）：\n${clipText(input.lastResult.trim(), AUTOMATION_LAST_RESULT_MAX)}`
      : "";
  return `${head}\n\n${input.prompt.trim()}${last}`;
}

/** 目标会话已经不在了（被删）：调度器据此把 this_session 任务翻成 completed(sessionDeleted) */
export class SessionGoneError extends Error {
  constructor() {
    super("The session this automation is bound to no longer exists.");
    this.name = "SessionGoneError";
  }
}

/**
 * 开一条会话并开轮（target = new_session）。失败抛错（会话已回滚）；调用方把错误记进这次运行。
 * `sessionId` 由调用方预先铸好并先登记到它的事件路由里——开轮后的第一帧事件就可能到。
 */
export async function launchAutomationRun(
  deps: LaunchDeps,
  input: { automation: Automation; sessionId: string; number: number; at: number; trigger: AutomationRunTrigger },
): Promise<void> {
  const { automation } = input;
  const workspaceId = automationWorkspaceId(automation);
  const workspaces = await deps.workspaces.list();
  let cwd: string;
  if (workspaceId === null) {
    cwd = deps.workspaces.defaultPath();
  } else {
    const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace === undefined) throw new Error("The workspace of this automation no longer exists.");
    cwd = workspace.path;
  }

  const resolved = resolveAutomationModel({
    automation,
    settings: await deps.settings.read(),
    providers: await deps.providers.list(),
  });
  if (!resolved.ok) throw new Error(resolved.error);

  // 先建 meta 再开轮：ensureSession 对已存在的 meta 只校准 piSessionFile，首轮 settle 不会盖掉这份。
  // titleSource "user"：标题是「任务名 · 时间」，不走 auto-title
  await deps.sessions.ensureSession({
    id: input.sessionId,
    title: `${automation.title} · ${formatAutomationStamp(input.at)}`,
    titleSource: "user",
    cwd,
    workspaceId,
    automationId: automation.id,
    automationRun: { title: automation.title, number: input.number, at: input.at, trigger: input.trigger },
    providerId: resolved.providerId,
    modelId: resolved.modelId,
    mode: automation.mode,
    thinkingLevel: resolved.thinkingLevel,
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: input.at,
    updatedAt: input.at,
  });
  try {
    await deps.submitTurn({
      sessionId: input.sessionId,
      cwd,
      workspaceId,
      resume: null,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      mode: automation.mode,
      thinkingLevel: resolved.thinkingLevel,
      text: composeAutomationPrompt({
        title: automation.title,
        number: input.number,
        ...(automation.maxRuns === undefined ? {} : { max: automation.maxRuns }),
        at: input.at,
        prompt: automation.prompt,
        ...(automation.lastResult === undefined ? {} : { lastResult: automation.lastResult }),
      }),
    });
  } catch (cause) {
    // 失败回滚：刚建的会话不该留下
    await deps.sessions.remove(input.sessionId).catch(() => undefined);
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
}

/**
 * 把指令送回创建它的那条会话（target = this_session）：用**会话自己 meta 里**的 piSessionFile / 模型 /
 * 权限档 / 思考档 resume 一轮——它还是那条会话，不是新开的。调用方已确认这条会话此刻空闲。
 * 会话没了抛 SessionGoneError；没有 pi 本子（只读的导入会话）抛普通错误（这条会话续不了）。
 */
export async function deliverAutomationRun(
  deps: Pick<LaunchDeps, "sessions" | "submitTurn">,
  input: { automation: Automation; number: number; at: number },
): Promise<void> {
  const { automation } = input;
  if (automation.target.kind !== "this_session") throw new Error("This automation is not bound to a session.");
  const meta = await deps.sessions.readMeta(automation.target.sessionId);
  if (meta === null) throw new SessionGoneError();
  if (meta.piSessionFile === null) {
    throw new Error("This session cannot be continued (it has no saved agent state), so the task cannot be sent back into it.");
  }
  await deps.submitTurn({
    sessionId: meta.id,
    cwd: meta.cwd,
    workspaceId: meta.workspaceId,
    resume: { piSessionFile: meta.piSessionFile },
    providerId: meta.providerId,
    modelId: meta.modelId,
    // 无人值守照会话自己的档走：manual 档会停在审批上（面板上提示），不替用户改档
    mode: meta.mode,
    thinkingLevel: meta.thinkingLevel,
    text: composeAutomationPrompt({
      title: automation.title,
      number: input.number,
      ...(automation.maxRuns === undefined ? {} : { max: automation.maxRuns }),
      at: input.at,
      prompt: automation.prompt,
    }),
  });
}
