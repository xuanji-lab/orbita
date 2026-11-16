/**
 * 计划要在一轮之内往前走（2026-11-16 用户：「一个 turn 内，agent 只有在开始的时候会改一次计划，之后每完成一步不会去更新」）。
 * 第一层：系统提醒——连续若干次工具调用没动计划，就在下一次工具结果的**末尾**附一句提醒。
 *
 * 为什么附在工具结果末尾：
 * - 不多花一次模型调用（提醒随这次工具结果一起进下一次请求，本来就要发）；
 * - 不打断提示缓存：提醒在 afterTool 里写进工具结果、随结果一起落库，之后每次请求里这条结果都是同一份字节；
 *   请求前缀（系统提示 + 之前的全部消息）一个字节都不变（kernel-session.test 的「提醒不改请求前缀」逐次比对过）。
 *   不用 beforeRequest 每次请求临时拼（那会让每次请求的尾部都不一样，且提醒不落库、回放时消失）。
 *
 * 数字怎么定（11-16 实测 266 条会话：长轮每轮中位数 65 次工具调用，一张计划通常 5–7 步，约 10 次调用一步）：
 * - NUDGE_AFTER = 12：比一步的典型用量多一点才提醒——正常推进的模型碰不到它，卡在一步上不勾的才碰到；
 * - NUDGE_MAX_PER_TURN = 3：同一轮提醒三次还不更新，说明模型在无视它，再说就是噪声；补位交给书记员（第二层，未做）。
 * - 没有计划（一问一答）或计划全部做完：不数、不提醒——没有可推进的东西。
 * 提醒之后从零重数；模型调了 update_plan 也从零重数。
 *
 * 纯模块：不 import durable，node --test 直接测。kernel-turn.ts 的 afterTool 是唯一调用点（每轮一个实例）。
 */
import { PLAN_TOOL_NAME, type PlanItem } from "../shared/plan.ts";

export const NUDGE_AFTER = 12;
export const NUDGE_MAX_PER_TURN = 3;

/** 附在工具结果末尾的那句（写给模型看，英文与其余工具说明一致） */
export function planNudgeText(calls: number): string {
  return `<system-reminder>You have made ${calls} tool calls since you last updated the plan. If you finished a step or moved on to another, call update_plan now: mark finished steps done and set the step you are working on to in_progress (with a one-line detail). If the plan is still accurate, carry on and ignore this.</system-reminder>`;
}

/** 计划里还有没做完的步（pending / in_progress / waiting）才算「有计划可推进」 */
export function planIsActive(items: readonly PlanItem[] | null): boolean {
  return items !== null && items.some((item) => item.status !== "done");
}

export class PlanNudge {
  private sincePlan = 0;
  private sent = 0;
  private readonly after: number;
  private readonly max: number;

  constructor(options: { after?: number; max?: number } = {}) {
    this.after = options.after ?? NUDGE_AFTER;
    this.max = options.max ?? NUDGE_MAX_PER_TURN;
  }

  /**
   * 一次工具调用结束（afterTool）。返回要附在这次结果末尾的提醒，或 null。
   * `currentPlan` 只在可能要提醒时才取（读一遍上下文里的最近一张计划）；`canAppend` = 这次结果能不能附（输出缺席的不附，
   * 留到下一次——计数不清零）。
   */
  afterTool(toolName: string, currentPlan: () => readonly PlanItem[] | null, canAppend = true): string | null {
    if (toolName === PLAN_TOOL_NAME) {
      this.sincePlan = 0;
      return null;
    }
    this.sincePlan += 1;
    if (this.sincePlan < this.after || this.sent >= this.max || !canAppend) return null;
    if (!planIsActive(currentPlan())) return null;
    const calls = this.sincePlan;
    this.sincePlan = 0;
    this.sent += 1;
    return planNudgeText(calls);
  }
}
