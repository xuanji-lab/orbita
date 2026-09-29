/**
 * 回合以「不重试的模型错误」收场时，给出要报给用户的错误串 —— 纯模块，node --test 直接加载。
 *
 * 为什么需要它：pi 在模型返回错误（400 Model is not available、401、参数被拒……）时，
 * 只产出一条 `stopReason: "error"`、内容为空的 assistant。这条我们刻意不落盘也不渲染
 * （recorder.ts 的「空 error 回答」），而回合级失败的出口原来只接了「自动重试耗尽」一条路。
 * 于是**不可重试的错误整条消失**：界面上发出去的话下面什么都没有，像是还在等。
 *
 * 判定按 pi 的事件时序（agent-session.ts）：
 *   message_end … → agent_end{willRetry} → [auto_retry_end | compaction_*] → agent_settled
 * - agent_end 且 willRetry 为假、最后一条 assistant 是 error → 记下它的 errorMessage；
 * - auto_retry_end：重试路径自己收尾（耗尽由 runtime 另报一条），这里清掉，不报第二遍；
 * - compaction_start：上下文溢出由压缩接手续跑，结局看后面的事件，先清掉；
 * - agent_settled：还记着就是这一轮的终局，交出去并清空。
 */

/** 只取判定要用的那几个形状（结构匹配 pi 的 AgentSessionEvent，不引它的联合类型） */
export type TurnFailureEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry: boolean; messages: readonly TurnMessage[] }
  | { type: "auto_retry_end" }
  | { type: "compaction_start" }
  | { type: "agent_settled" }
  | { type: string };

interface TurnMessage {
  role: string;
  stopReason?: string;
  errorMessage?: string;
}

/** 返回 observe：喂每一个 pi 事件；只有 agent_settled 且本轮以错误收场时返回错误串。 */
export function createTurnFailureTracker(): (event: TurnFailureEvent) => string | null {
  let pending: string | null = null;
  return (event) => {
    switch (event.type) {
      case "agent_end": {
        if (!("willRetry" in event) || event.willRetry) {
          pending = null;
          return null;
        }
        const last = [...event.messages].reverse().find((message) => message.role === "assistant");
        pending =
          last?.stopReason === "error" ? (last.errorMessage?.trim() || "The model returned an error") : null;
        return null;
      }
      case "agent_start":
      case "auto_retry_end":
      case "compaction_start":
        pending = null;
        return null;
      case "agent_settled": {
        const message = pending;
        pending = null;
        return message;
      }
      default:
        return null;
    }
  };
}
