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

/** 一张计划的上限：再多就不是计划，是流水账 */
export const PLAN_MAX_ITEMS = 12;

export const PLAN_STATUSES: readonly PlanItemStatus[] = ["pending", "in_progress", "done"];

/**
 * 入参 → 计划清单。坏入参抛错（错误文案回灌给模型，让它改了重调）：
 * - items 必须是 1–12 条；text 去空白后不能为空；status 只认三个值；
 * - **最多一条 in_progress**：同时「在做」两件事，界面上的「当前一步」就说不清了。
 */
export function parsePlan(params: unknown): PlanItem[] {
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
  return items;
}
