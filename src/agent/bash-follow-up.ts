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

/**
 * 挂起的那批结果一起送齐的一句提示。
 *
 * **为什么可能不止一条**：上一条结果起的那一轮还没跑完，后面的命令陆续也结束了——
 * 它们的结果这一轮看不到（pi 把 bashExecution 排到 agent_end 之后才落进本子），
 * 只能等轮结束一起补一轮。**一轮盖多条**：每条各起一轮是白花的钱，而结论本来就是
 * 「这几条都结束了，一起看」。
 */
export function bashQueuedFollowUpPrompt(results: readonly BashFollowUpFacts[]): string {
  const facts = results
    .map((result) => `${result.id} (exit ${result.exitCode === null ? "unknown" : String(result.exitCode)}, ${formatBashDuration(result.elapsedMs)})`)
    .join(", ");
  const which = results.length === 1 ? "command" : "commands";
  return (
    `[orbita] Background ${which} ${facts} finished while you were busy. ` +
    "The results are above — continue from there."
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

export interface BashDrainDecisionInput {
  /** 挂起的结果条数（在跑的轮里结束、那一轮看不到的那些） */
  pending: number;
  /** 轮结束时这条 Orbita 会话是否又忙起来了（用户排队消息先到了一轮） */
  busy: boolean;
  /** 这一轮是用户按停止收尾的：不自动起轮（人刚喊停，模型不该接着说） */
  userStopped: boolean;
  hasTemplate: boolean;
}

/**
 * 轮结束时要不要为挂起的结果补一轮。四条，缺一不可：
 * 1. 真的挂着东西（没有就什么都不做）；
 * 2. 此刻空闲（新轮已经开起来的话，它开轮时已经读过那本子，结果已在它上下文里）；
 * 3. 不是用户刚按的停止（停止是人的决定，下一句由人起头）；
 * 4. 有可重放的装配模板（还没跑过 submit 就没有）。
 *
 * **第 2 条不是“丢了”**：新轮的 open 在结果落进本子之后，它读得到——
 * 挂起只是“没人起轮”时的兜底，不是唯一通路。
 */
export function shouldDrainBashFollowUp(input: BashDrainDecisionInput): boolean {
  if (input.pending <= 0) return false;
  if (input.busy) return false;
  if (input.userStopped) return false;
  return input.hasTemplate;
}
