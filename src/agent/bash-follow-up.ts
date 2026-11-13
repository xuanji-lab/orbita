/**
 * 后台命令结束后要不要**自动起一轮**——三条触发条件写死在这里（纯函数，可直测）。
 *
 * 用户 2026-11-13 裁决：
 * ① 这条 Orbita 会话此刻空闲（没有正在跑的回合）——在跑的轮自己会看到结果；
 * ② 结果是自然结束（用户 stop / 寿命杀不自动起：人已经知道，不需要模型再讲一遍）；
 * ③ 同一条会话的同一个结束后继只起一次（回调本身幂等，这里再兜一道）。
 *
 * runtime 只负责「按判定结果调 startTurn」，判定与文案留在这里，测试不必拉起
 * 整个 utility 进程（runtime 被 parentPort 守卫钉死在进程里，加载即退出）。
 */
import { formatBashDuration } from "../shared/bash-session.ts";

/** 判定与文案需要的结束事实（BashSessionEnd 的子集） */
export interface BashFollowUpFacts {
  id: string;
  status: "finished" | "killed";
  exitCode: number | null;
  elapsedMs: number;
}

/** 自动起一轮那句提示：结果就在它上面那条 bashExecution 里，模型只需接着处理 */
export function bashFollowUpPrompt(result: BashFollowUpFacts): string {
  const exit = result.exitCode === null ? "unknown" : String(result.exitCode);
  return (
    `[orbita] Background command ${result.id} finished (exit ${exit}, ${formatBashDuration(result.elapsedMs)}). ` +
    "Its result is above — continue from there."
  );
}

export interface BashFollowUpDecisionInput {
  result: BashFollowUpFacts;
  /** 结束那一刻这条 Orbita 会话是否还有正在跑的回合 */
  busy: boolean;
  /** 上一次已经为哪个后台会话起过后继轮（undefined = 还没起过） */
  alreadyStartedFor: string | undefined;
  /** 有没有可重放的开轮装配（还没跑过 submit 时没有） */
  hasTemplate: boolean;
}

/** 三条触发条件（见文件头）。返回 true 才起轮。 */
export function shouldStartBashFollowUp(input: BashFollowUpDecisionInput): boolean {
  if (input.result.status !== "finished") return false;
  if (input.busy) return false;
  if (!input.hasTemplate) return false;
  return input.alreadyStartedFor !== input.result.id;
}
