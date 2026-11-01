/**
 * 自动化的校验与状态转移（实验功能 automation）：两个入口，一套规则。
 *
 *   applyAutomationCreate / Update / Act / Promote —— 面板上用户的操作（automation:* IPC）
 *   applyAutomationRequest                          —— agent 的 automation_create / list / cancel 工具请求
 *                                                      （agent 进程 → automationRequest 事件 → 这里 → automationResult）
 *
 * **信任边界在这里**：IPC 载荷与工具入参都是 `unknown`，逐字段校验后才落 store（renderer 不是可信输入，
 * 模型更不是）。分层同 `channel/requests.ts`：纯核 + 依赖注入（`AutomationRequestDeps`），可被
 * `node --test` 用真 AutomationStore + 假调度器直测，不 import electron。
 *
 * 两个入口的差别：
 *   - 用户在面板里建的 → 只能新开会话（new_session），权限档自己选（plan / skip，没有 manual）；
 *   - agent 在对话里建的 → **直接生效**（用户 2026-10-31 裁决），默认投回创建它的会话（this_session），
 *     必须有终点（没给默认 maxRuns = 12）；只能管当前会话所在工作区的；自动化新开的会话与子会话
 *     的请求一律拒（防递归）；新开会话的任务落最保守的 plan 档，用户要放行去面板里改。
 * 条数护栏对两个入口一视同仁：全局 ≤ 20（所有状态都计），一条会话上活跃的 this_session 任务 ≤ 5。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  AUTOMATION_AGENT_DEFAULT_MAX_RUNS,
  AUTOMATION_AGENT_MAX_RUNS_CAP,
  AUTOMATION_MAX_ACTIVE_PER_SESSION,
  AUTOMATION_MAX_TOTAL,
  AUTOMATION_PROMPT_MAX,
  AUTOMATION_TITLE_MAX,
  AUTOMATION_USER_MAX_RUNS_CAP,
  automationCardOf,
  automationWorkspaceId,
  describeScheduleEn,
  isAutomationMode,
  nextRunAfter,
  parseSchedule,
  type Automation,
  type AutomationAction,
  type AutomationOutcome,
  type AutomationSchedule,
  type AutomationTarget,
  type AutomationToolOutcome,
} from "../../shared/automation.ts";
import type { ProviderDto } from "../../shared/provider.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { isThinkingLevel, type ThinkingLevel } from "../../shared/thinking.ts";
import type { Workspace } from "../../shared/workspace.ts";
import { resolveSubSessionModel } from "../channel/requests.ts";
import type { RunNowOutcome } from "./scheduler.ts";
import type { AutomationStore } from "./store.ts";

export interface AutomationRequestDeps {
  store: AutomationStore;
  scheduler: { runNow(automationId: string): Promise<RunNowOutcome> };
  sessions: {
    readMeta(id: string): Promise<SessionMeta | null>;
    setPromoted(id: string): Promise<boolean>;
  };
  providers: { list(): Promise<ProviderDto[]> };
  workspaces: { list(): Promise<Workspace[]> };
  /** 实验开关（每次现读） */
  enabled(): Promise<boolean>;
  now(): number;
  newId(): string;
  /** 任何一条变了：推给 renderer */
  notify(): void;
}

const OFF: { ok: false; error: string } = {
  ok: false,
  error: "Automations are turned off. Turn them on under Settings › Experimental.",
};

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/* ---------- 字段校验 ---------- */

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function parseTitle(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || raw.trim() === "") return fail("title is required.");
  const title = raw.trim().replace(/\s+/g, " ");
  if ([...title].length > AUTOMATION_TITLE_MAX) return fail(`title must be at most ${AUTOMATION_TITLE_MAX} characters.`);
  return { ok: true, value: title };
}

function parsePrompt(raw: unknown): Parsed<string> {
  if (typeof raw !== "string" || raw.trim() === "") return fail("prompt is required.");
  if ([...raw].length > AUTOMATION_PROMPT_MAX) return fail(`prompt must be at most ${AUTOMATION_PROMPT_MAX} characters.`);
  return { ok: true, value: raw.trim() };
}

function parseMaxRuns(raw: unknown, cap: number): Parsed<number> {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return fail("maxRuns must be a positive integer.");
  if (raw > cap) return fail(`maxRuns must be at most ${cap}.`);
  return { ok: true, value: raw };
}

function parseUntil(raw: unknown, now: number): Parsed<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fail("until must be a timestamp in ms.");
  if (raw <= now) return fail("until is already in the past.");
  return { ok: true, value: Math.round(raw) };
}

/** 指名的模型必须成对给，且 provider 真有这个模型（卡上写着的模型不能是空头支票） */
function parseModelPair(providerId: unknown, modelId: unknown, providers: readonly ProviderDto[]): Parsed<{ providerId: string; modelId: string }> {
  if (typeof providerId !== "string" || typeof modelId !== "string" || providerId === "" || modelId === "") {
    return fail("providerId and modelId must be given together.");
  }
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined || !provider.models.declared.some((model) => model.id === modelId)) {
    return fail(`Model ${providerId}/${modelId} is not configured.`);
  }
  return { ok: true, value: { providerId, modelId } };
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

/** 第一次到点的时间：once 就是 at；其余从现在起算。排不出（once 已过 / 越过 until）返回 null */
function firstRunAt(schedule: AutomationSchedule, now: number, until: number | undefined): number | null {
  const next = schedule.kind === "once" ? (schedule.at > now ? schedule.at : null) : nextRunAfter(schedule, now);
  if (next === null) return null;
  if (until !== undefined && next > until) return null;
  return next;
}

async function knownWorkspace(deps: AutomationRequestDeps, workspaceId: unknown): Promise<Parsed<string | null>> {
  if (workspaceId === null) return { ok: true, value: null };
  if (typeof workspaceId !== "string" || workspaceId === "") return fail("workspaceId must be a workspace id or null (Home).");
  const workspaces = await deps.workspaces.list();
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) return fail("That workspace no longer exists.");
  return { ok: true, value: workspaceId };
}

/** 一条会话上此刻活跃的 this_session 任务数（不含 exceptId 自己） */
function activeOnSession(all: readonly Automation[], sessionId: string, exceptId?: string): number {
  return all.filter(
    (automation) =>
      automation.id !== exceptId &&
      automation.status === "active" &&
      automation.target.kind === "this_session" &&
      automation.target.sessionId === sessionId,
  ).length;
}

const SESSION_LIMIT_MESSAGE = `At most ${AUTOMATION_MAX_ACTIVE_PER_SESSION} active automations can be bound to one session.`;
const TOTAL_LIMIT_MESSAGE = `At most ${AUTOMATION_MAX_TOTAL} automations can exist (finished ones count too); delete some in the Automations panel first.`;

/* ---------- 面板上的操作 ---------- */

/** 全部自动化（renderer 按工作区过滤）。开关关着回空：关着的功能不该在界面上冒数据 */
export async function listAutomations(deps: AutomationRequestDeps): Promise<Automation[]> {
  if (!(await deps.enabled())) return [];
  return deps.store.list();
}

/** 用户在面板里手建：只能新开会话；直接 active */
export async function applyAutomationCreate(deps: AutomationRequestDeps, raw: unknown): Promise<AutomationOutcome> {
  if (!(await deps.enabled())) return OFF;
  if (!isRecord(raw)) return fail("Invalid request.");
  const now = deps.now();
  const workspaceId = await knownWorkspace(deps, raw["workspaceId"]);
  if (!workspaceId.ok) return workspaceId;
  const title = parseTitle(raw["title"]);
  if (!title.ok) return title;
  const prompt = parsePrompt(raw["prompt"]);
  if (!prompt.ok) return prompt;
  const schedule = parseSchedule(raw["schedule"], now);
  if (!schedule.ok) return schedule;
  if (!isAutomationMode(raw["mode"])) return fail('mode must be "plan" or "skip" — unattended runs cannot ask for approval.');
  let model: { providerId: string; modelId: string } | undefined;
  if (raw["providerId"] !== undefined || raw["modelId"] !== undefined) {
    const parsed = parseModelPair(raw["providerId"], raw["modelId"], await deps.providers.list());
    if (!parsed.ok) return parsed;
    model = parsed.value;
  }
  let thinkingLevel: ThinkingLevel | undefined;
  if (raw["thinkingLevel"] !== undefined) {
    if (!isThinkingLevel(raw["thinkingLevel"])) return fail("thinkingLevel is not valid.");
    thinkingLevel = raw["thinkingLevel"];
  }
  let maxRuns: number | undefined;
  if (raw["maxRuns"] !== undefined) {
    const parsed = parseMaxRuns(raw["maxRuns"], AUTOMATION_USER_MAX_RUNS_CAP);
    if (!parsed.ok) return parsed;
    maxRuns = parsed.value;
  }
  let until: number | undefined;
  if (raw["until"] !== undefined) {
    const parsed = parseUntil(raw["until"], now);
    if (!parsed.ok) return parsed;
    until = parsed.value;
  }
  const nextRunAt = firstRunAt(schedule.schedule, now, until);
  if (nextRunAt === null) return fail("The end date comes before the first run.");
  if ((await deps.store.list()).length >= AUTOMATION_MAX_TOTAL) return fail(TOTAL_LIMIT_MESSAGE);
  const automation: Automation = {
    id: deps.newId(),
    title: title.value,
    prompt: prompt.value,
    schedule: schedule.schedule,
    target: { kind: "new_session", workspaceId: workspaceId.value },
    ...(model === undefined ? {} : model),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    mode: raw["mode"],
    status: "active",
    createdBy: { kind: "user" },
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(until === undefined ? {} : { until }),
    nextRunAt,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
  await deps.store.insert(automation);
  deps.notify();
  return { ok: true, automation };
}

/** 编辑表单：只改给了的字段 */
export async function applyAutomationUpdate(deps: AutomationRequestDeps, rawId: unknown, rawPatch: unknown): Promise<AutomationOutcome> {
  if (!(await deps.enabled())) return OFF;
  if (typeof rawId !== "string" || rawId === "") return fail("Invalid automation id.");
  if (!isRecord(rawPatch)) return fail("Invalid request.");
  const now = deps.now();
  const current = await deps.store.get(rawId);
  if (current === null) return fail("Automation not found.");

  // 先逐字段校验、攒成 set / unset；真正落盘在 store 的读-改-写里按**最新**状态合并
  // （校验期间调度器可能刚写过这条：用校验时那份快照整条回写会冲掉新跑的记录）
  const set: Partial<Automation> = {};
  const unset: (keyof Automation)[] = [];
  let timingChanged = false;
  if (rawPatch["title"] !== undefined) {
    const parsed = parseTitle(rawPatch["title"]);
    if (!parsed.ok) return parsed;
    set.title = parsed.value;
  }
  if (rawPatch["prompt"] !== undefined) {
    const parsed = parsePrompt(rawPatch["prompt"]);
    if (!parsed.ok) return parsed;
    set.prompt = parsed.value;
  }
  if (rawPatch["schedule"] !== undefined) {
    const parsed = parseSchedule(rawPatch["schedule"], now);
    if (!parsed.ok) return parsed;
    set.schedule = parsed.schedule;
    timingChanged = true;
  }
  if (rawPatch["mode"] !== undefined) {
    if (!isAutomationMode(rawPatch["mode"])) return fail('mode must be "plan" or "skip".');
    set.mode = rawPatch["mode"];
  }
  if (rawPatch["maxRuns"] !== undefined) {
    if (rawPatch["maxRuns"] === null) {
      unset.push("maxRuns");
    } else {
      const parsed = parseMaxRuns(rawPatch["maxRuns"], AUTOMATION_USER_MAX_RUNS_CAP);
      if (!parsed.ok) return parsed;
      set.maxRuns = parsed.value;
    }
  }
  if (rawPatch["until"] !== undefined) {
    if (rawPatch["until"] === null) {
      unset.push("until");
    } else {
      const parsed = parseUntil(rawPatch["until"], now);
      if (!parsed.ok) return parsed;
      set.until = parsed.value;
    }
    timingChanged = true;
  }
  if (rawPatch["providerId"] !== undefined || rawPatch["modelId"] !== undefined) {
    if (rawPatch["providerId"] === null && rawPatch["modelId"] === null) {
      unset.push("providerId", "modelId");
    } else {
      const parsed = parseModelPair(rawPatch["providerId"], rawPatch["modelId"], await deps.providers.list());
      if (!parsed.ok) return parsed;
      set.providerId = parsed.value.providerId;
      set.modelId = parsed.value.modelId;
    }
  }
  if (rawPatch["thinkingLevel"] !== undefined) {
    if (rawPatch["thinkingLevel"] === null) {
      unset.push("thinkingLevel");
    } else if (isThinkingLevel(rawPatch["thinkingLevel"])) {
      set.thinkingLevel = rawPatch["thinkingLevel"];
    } else {
      return fail("thinkingLevel is not valid.");
    }
  }
  if (rawPatch["deliver"] !== undefined) {
    // 只有 agent 在对话里建的才有「原会话」可投回；用户手建的只能新开会话
    if (rawPatch["deliver"] === "new_session") {
      set.target = { kind: "new_session", workspaceId: automationWorkspaceId(current) };
      unset.push("pendingDelivery");
    } else if (rawPatch["deliver"] === "this_session") {
      if (current.createdBy.kind !== "agent") return fail("Only a task created in a conversation can be sent back into it.");
      const sessionId = current.createdBy.sessionId;
      if ((await deps.sessions.readMeta(sessionId)) === null) return fail("The conversation that created this task no longer exists.");
      if (current.status === "active" && activeOnSession(await deps.store.list(), sessionId, current.id) >= AUTOMATION_MAX_ACTIVE_PER_SESSION) {
        return fail(SESSION_LIMIT_MESSAGE);
      }
      set.target = { kind: "this_session", sessionId, workspaceId: automationWorkspaceId(current) };
    } else {
      return fail('deliver must be "new_session" or "this_session".');
    }
  }

  let refusal: string | null = null;
  const saved = await deps.store.update(rawId, (existing) => {
    const merged: Automation = { ...existing, ...set, updatedAt: now };
    for (const key of unset) delete merged[key];
    // 排期或终点变了：在排期的从现在重排；暂停 / 失败 / 完成的没有 nextRunAt，等继续 / 重新启动时再排
    if (timingChanged && merged.status === "active") {
      const at = firstRunAt(merged.schedule, now, merged.until);
      if (at === null) {
        refusal = "The end date comes before the next run.";
        return null;
      }
      merged.nextRunAt = at;
      delete merged.pendingDelivery;
    }
    return merged;
  });
  if (saved === null) return fail("Automation not found.");
  if (refusal !== null) return fail(refusal);
  deps.notify();
  return { ok: true, automation: saved };
}

const ACTION_TYPES = ["pause", "resume", "restart", "runNow", "delete"] as const;

function parseAction(raw: unknown): Parsed<AutomationAction> {
  if (!isRecord(raw) || !(ACTION_TYPES as readonly unknown[]).includes(raw["type"])) return fail("Unknown action.");
  return { ok: true, value: { type: raw["type"] as AutomationAction["type"] } };
}

/** 面板上的按钮 = 状态转移。每个转移都先核对当前状态，不合法的转移回一句话而不是静默无效 */
export async function applyAutomationAct(deps: AutomationRequestDeps, rawId: unknown, rawAction: unknown): Promise<AutomationOutcome> {
  if (!(await deps.enabled())) return OFF;
  if (typeof rawId !== "string" || rawId === "") return fail("Invalid automation id.");
  const action = parseAction(rawAction);
  if (!action.ok) return action;
  const now = deps.now();
  const current = await deps.store.get(rawId);
  if (current === null) return fail("Automation not found.");
  const act = action.value;

  if (act.type === "runNow") {
    const outcome = await deps.scheduler.runNow(rawId);
    if (!outcome.ok) return outcome;
    return { ok: true, automation: await deps.store.get(rawId) };
  }
  if (act.type === "delete") {
    await deps.store.remove(rawId);
    deps.notify();
    return { ok: true, automation: null };
  }

  const all = await deps.store.list();
  let transition: (existing: Automation) => Automation | string;
  if (act.type === "pause") {
    transition = (existing) => {
      if (existing.status !== "active") return "Only a scheduled automation can be paused.";
      const next: Automation = { ...existing, status: "paused", nextRunAt: null, updatedAt: now };
      delete next.pendingDelivery;
      return next;
    };
  } else {
    // resume：暂停的继续；restart：失败 / 完成的从头再来（次数清零）
    const restart = act.type === "restart";
    transition = (existing) => {
      if (restart ? existing.status !== "failed" && existing.status !== "completed" : existing.status !== "paused") {
        return restart ? "Only a failed or completed automation can be restarted." : "Only a paused automation can be resumed.";
      }
      if (!restart && existing.maxRuns !== undefined && existing.runCount >= existing.maxRuns) {
        return "This automation has used all its runs; restart it instead.";
      }
      if (existing.target.kind === "this_session" && activeOnSession(all, existing.target.sessionId, existing.id) >= AUTOMATION_MAX_ACTIVE_PER_SESSION) {
        return SESSION_LIMIT_MESSAGE;
      }
      const nextRunAt = firstRunAt(existing.schedule, now, existing.until);
      if (nextRunAt === null) return "The scheduled time has already passed. Edit the schedule first.";
      const next: Automation = {
        ...existing,
        status: "active",
        nextRunAt,
        consecutiveFailures: 0,
        updatedAt: now,
        ...(restart ? { runCount: 0 } : {}),
      };
      delete next.endReason;
      delete next.failureReason;
      return next;
    };
  }
  if (act.type === "restart" && current.target.kind === "this_session" && (await deps.sessions.readMeta(current.target.sessionId)) === null) {
    return fail("The conversation this task is bound to no longer exists. Switch it to a new session first.");
  }

  let refusal: string | null = null;
  const apply = transition;
  const saved = await deps.store.update(rawId, (existing) => {
    const result = apply(existing);
    if (typeof result === "string") {
      refusal = result;
      return null;
    }
    return result;
  });
  if (saved === null) return fail("Automation not found.");
  if (refusal !== null) return fail(refusal);
  deps.notify();
  return { ok: true, automation: saved };
}

/** 「转成普通会话」：自动化新开的会话进左侧栏。不是自动化开的会话回「不适用」，不静默成功 */
export async function applyAutomationPromote(deps: AutomationRequestDeps, rawSessionId: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(await deps.enabled())) return OFF;
  if (typeof rawSessionId !== "string" || rawSessionId === "") return fail("Invalid session id.");
  const meta = await deps.sessions.readMeta(rawSessionId);
  if (meta === null) return fail("Session not found.");
  if (meta.automationId === undefined) return fail("This session was not started by an automation.");
  await deps.sessions.setPromoted(rawSessionId);
  deps.notify();
  return { ok: true };
}

/* ---------- agent 工具 ---------- */

/**
 * agent 的 automation_create / list / cancel。**只能管当前会话所在工作区的**；自动化新开的会话与子会话
 * 一律拒（工具不注册只是第一道，这是信任边界）。建出来直接生效。
 */
export async function applyAutomationRequest(
  deps: AutomationRequestDeps,
  event: Extract<AgentEvent, { type: "automationRequest" }>,
): Promise<AutomationToolOutcome> {
  if (!(await deps.enabled())) return OFF;
  const meta = await deps.sessions.readMeta(event.sessionId);
  if (meta === null) return fail(`Session ${event.sessionId} was not found.`);
  if (meta.automationId !== undefined) {
    return fail("This session was started by an automation. An automation run cannot create or manage automations.");
  }
  if (meta.parentId !== undefined) {
    return fail("Sub-sessions cannot create or manage automations; ask the parent session.");
  }
  const workspaceId = meta.workspaceId;
  const request = event.request;
  const now = deps.now();

  if (request.op === "list") {
    const mine = (await deps.store.list()).filter((automation) => automationWorkspaceId(automation) === workspaceId);
    return {
      ok: true,
      text: mine.length === 0 ? "No automations in this workspace." : `${mine.length} automation(s) in this workspace.`,
      automations: mine.map(automationCardOf),
    };
  }

  if (request.op === "cancel") {
    if (typeof request.automationId !== "string" || request.automationId === "") return fail('"automationId" is required.');
    const target = await deps.store.get(request.automationId);
    // 别的工作区的当作不存在：不泄露它的存在，也不让这里的 agent 去动它
    if (target === null || automationWorkspaceId(target) !== workspaceId) return fail("No such automation in this workspace.");
    if (target.status === "completed") return { ok: true, text: `Automation "${target.title}" was already finished.` };
    const saved = await deps.store.update(target.id, (existing) => {
      if (existing.status === "completed") return null;
      const next: Automation = { ...existing, status: "completed", endReason: "cancelled", nextRunAt: null, updatedAt: now };
      delete next.pendingDelivery;
      delete next.failureReason;
      return next;
    });
    deps.notify();
    return {
      ok: true,
      text: `Automation "${target.title}" is cancelled; it will not run again.`,
      ...(saved === null ? {} : { automation: automationCardOf(saved) }),
    };
  }

  // create
  const title = parseTitle(request.title);
  if (!title.ok) return title;
  const prompt = parsePrompt(request.prompt);
  if (!prompt.ok) return prompt;
  const schedule = parseSchedule(request.schedule, now);
  if (!schedule.ok) return schedule;
  const targetKind = request.target ?? "this_session";
  if (targetKind !== "this_session" && targetKind !== "new_session") return fail('target must be "this_session" or "new_session".');
  let maxRuns: number | undefined;
  if (request.maxRuns !== undefined) {
    const parsed = parseMaxRuns(request.maxRuns, AUTOMATION_AGENT_MAX_RUNS_CAP);
    if (!parsed.ok) return parsed;
    maxRuns = parsed.value;
  }
  let until: number | undefined;
  if (request.until !== undefined) {
    const parsed = parseUntil(request.until, now);
    if (!parsed.ok) return parsed;
    until = parsed.value;
  }
  // agent 建的必须有终点：什么都没给就落默认的 maxRuns
  if (maxRuns === undefined && until === undefined) maxRuns = AUTOMATION_AGENT_DEFAULT_MAX_RUNS;
  let model: { providerId: string; modelId: string } | undefined;
  if (request.model !== undefined && request.model !== "") {
    if (targetKind !== "new_session") return fail('"model" only applies when target is "new_session"; a task sent back into this session uses the session\'s own model.');
    const resolved = resolveSubSessionModel({
      requested: request.model,
      setting: undefined,
      parent: { providerId: meta.providerId, modelId: meta.modelId },
      providers: await deps.providers.list(),
    });
    if (!resolved.ok) return resolved;
    model = { providerId: resolved.providerId, modelId: resolved.modelId };
  }
  const nextRunAt = firstRunAt(schedule.schedule, now, until);
  if (nextRunAt === null) return fail("The end time comes before the first run.");
  const all = await deps.store.list();
  if (all.length >= AUTOMATION_MAX_TOTAL) return fail(TOTAL_LIMIT_MESSAGE);
  if (targetKind === "this_session" && activeOnSession(all, meta.id) >= AUTOMATION_MAX_ACTIVE_PER_SESSION) {
    return fail(`${SESSION_LIMIT_MESSAGE} Cancel one with automation_cancel first.`);
  }
  const automation: Automation = {
    id: deps.newId(),
    title: title.value,
    prompt: prompt.value,
    schedule: schedule.schedule,
    target:
      targetKind === "this_session"
        ? { kind: "this_session", sessionId: meta.id, workspaceId }
        : { kind: "new_session", workspaceId },
    ...(model === undefined ? {} : model),
    // 新开会话的无人值守运行落最保守的只读档；要放行写盘，用户在面板里改。this_session 不看这一档
    mode: "plan",
    status: "active",
    createdBy: { kind: "agent", sessionId: meta.id },
    ...(maxRuns === undefined ? {} : { maxRuns }),
    ...(until === undefined ? {} : { until }),
    nextRunAt,
    runs: [],
    runCount: 0,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  };
  await deps.store.insert(automation);
  deps.notify();
  const ends = [
    maxRuns === undefined ? null : `${maxRuns} run(s)`,
    until === undefined ? null : `the end time ${new Date(until).toISOString()}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" or ");
  return {
    ok: true,
    text:
      `Automation "${automation.title}" (id ${automation.id}) is active. ${describeScheduleEn(automation.schedule)}; ` +
      `first run ${new Date(nextRunAt).toISOString()}; ends after ${ends}. ` +
      (targetKind === "this_session"
        ? "Each time it is due, the instruction is sent back into this conversation (if this conversation is still busy then, it waits until it is idle). "
        : "Each run opens a new session in this workspace, read-only (Plan) unless the user changes the permission in the Automations panel. ") +
      "Do not wait for it or poll — end your turn when you have nothing else to do now.",
    automation: automationCardOf(automation),
  };
}
