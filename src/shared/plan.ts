/**
 * 计划（update_plan，2026-10-30）的形状与校验：agent 的工具（src/agent/plan-tools.ts）与右栏
 * 「这条任务 › 进度」（renderer 的 task-progress.ts）用同一份规矩判「这是不是一张合法的计划」。
 *
 * 两边都要判：工具在执行时校验、坏了就拒（错误回灌给模型）；面板要在工具执行**之前**就认出
 * 这张计划——pi 的并行批次先让每个调用过审批闸门、全部过完才统一执行，手动档下 update_plan
 * 会和同批等你批准的工具一起挂着，面板若只认执行完的，就一直显示上一张计划。
 *
 * 纯模块：不 import electron / React，可被 node --test 直接加载。
 */

export const PLAN_TOOL_NAME = "update_plan";

export type PlanItemStatus = "pending" | "in_progress" | "done";

export interface PlanItem {
  text: string;
  status: PlanItemStatus;
}

/** 顺手看到、这次不做的事（update_plan 的 later）：只写新的，系统按文字去重 */
export interface PlanLater {
  text: string;
  /** 一句理由（为什么这次不做）；可缺 */
  why?: string;
}

/**
 * 一次 update_plan 的完整入参（v4：在 items 之外多了三个可选字段）。
 * - why：结构变了（加 / 删 / 拆 / 合 / 改说法 / 调顺序）时的一句理由，只打勾时不写；
 * - later：以后再做，追加语义（旧的不会因为这次没重发就消失）；
 * - confirm：模型拿不准、要用户先回答的 1–3 个具体问题；非空 = 这一轮写完计划就停下等回答。
 */
export interface PlanCall {
  items: PlanItem[];
  why: string | null;
  later: PlanLater[];
  confirm: string[];
}

/** later 每次最多收几条、confirm 最多几个问题（超出的丢掉，不拒——可选字段写多了不值得让模型重调） */
export const PLAN_MAX_LATER = 5;
export const PLAN_MAX_CONFIRM = 3;
/** why / later / confirm 里单条文字的上限（字符），超长截断 */
export const PLAN_NOTE_MAX_CHARS = 200;

/**
 * update_plan 的结果 details（随转录落盘，只给界面、不进模型上下文）。
 * awaiting = 这一次调用让这一轮停下来等用户确认（plan 档写完计划 / 带了 confirm 问题 / 「先给我看计划」）；
 * confirm 同入参，界面据此在对话里画计划卡。
 */
export interface PlanToolDetails {
  plan: PlanItem[];
  awaiting?: boolean;
  confirm?: string[];
}

/** 一张计划的上限：再多就不是计划，是流水账 */
export const PLAN_MAX_ITEMS = 12;

export const PLAN_STATUSES: readonly PlanItemStatus[] = ["pending", "in_progress", "done"];

/**
 * 入参 → 计划清单。坏入参抛错（错误文案回灌给模型，让它改了重调）：
 * - items 必须是 1–12 条；text 去空白后不能为空；status 只认三个值；
 * - **最多一条 in_progress**：同时「在做」两件事，界面上的「当前一步」就说不清了。
 */
export function parsePlan(params: unknown): PlanItem[] {
  return parsePlanCall(params).items;
}

/**
 * 入参 → 一次完整的 update_plan 调用。items 的校验同 parsePlan（坏了抛错）；
 * why / later / confirm 是可选字段，**写坏了丢掉、不拒**：类型不对、空白、超出条数一律静默收敛——
 * 弱模型对可选字段的格式最容易写歪，为它整调用重来是更大的浪费。
 */
export function parsePlanCall(params: unknown): PlanCall {
  const raw = (params as { items?: unknown } | null)?.items;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('update_plan requires "items": a list of 1-12 steps, each { text, status }.');
  }
  if (raw.length > PLAN_MAX_ITEMS) {
    throw new Error(`A plan has at most ${PLAN_MAX_ITEMS} steps (got ${raw.length}). Merge smaller steps.`);
  }
  const items = raw.map((item, index): PlanItem => {
    const record = (item ?? {}) as Record<string, unknown>;
    const text = typeof record["text"] === "string" ? record["text"].trim() : "";
    if (text === "") throw new Error(`Step ${index + 1} has no text.`);
    const status = record["status"];
    if (typeof status !== "string" || !(PLAN_STATUSES as readonly string[]).includes(status)) {
      throw new Error(`Step ${index + 1} has status "${String(status)}"; use pending, in_progress or done.`);
    }
    return { text, status: status as PlanItemStatus };
  });
  if (items.filter((item) => item.status === "in_progress").length > 1) {
    throw new Error("Only one step can be in_progress at a time.");
  }
  return { items, ...parsePlanNotes(params) };
}

/**
 * 三个可选字段单独解析：面板对「已落盘的旧入参」宽松读 items 时，why / later / confirm 也要读——
 * 它们从不抛错，所以不论 items 是否过得了严格校验都能取。
 */
export function parsePlanNotes(params: unknown): Pick<PlanCall, "why" | "later" | "confirm"> {
  const record = (params ?? {}) as Record<string, unknown>;
  return { why: cleanNote(record["why"]), later: parseLater(record["later"]), confirm: parseConfirm(record["confirm"]) };
}

/** 一句说明：只认非空字符串，去空白、折叠换行、超长截断 */
function cleanNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > PLAN_NOTE_MAX_CHARS ? `${text.slice(0, PLAN_NOTE_MAX_CHARS - 1)}…` : text;
}

function parseLater(raw: unknown): PlanLater[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanLater[] = [];
  for (const entry of raw) {
    // 容忍模型直接写字符串
    const record = typeof entry === "string" ? { text: entry } : ((entry ?? {}) as Record<string, unknown>);
    const text = cleanNote(record["text"]);
    if (text === null || out.some((item) => item.text === text)) continue;
    const why = cleanNote(record["why"]);
    out.push(why === null ? { text } : { text, why });
    if (out.length >= PLAN_MAX_LATER) break;
  }
  return out;
}

function parseConfirm(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const text = cleanNote(entry);
    if (text !== null && !out.includes(text)) out.push(text);
    if (out.length >= PLAN_MAX_CONFIRM) break;
  }
  return out;
}
