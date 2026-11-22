/**
 * 审批卡的形态判定（纯函数；ApprovalBar 只负责画）。测试能直接钉住按钮集合，不用起 DOM。
 *
 * 三种形态：
 *   - `session`：会话授权卡（「本次会话允许 agent 操作沙箱？」）——允许 = 整条会话放行；
 *   - `risk`：破坏性动作确认（D1 组合键 / D2 破坏词 / D3 同点连点），允许 = 这一下照常执行；
 *   - `call`：普通逐次审批（manual 档）。
 *
 * 两张卡可能同时成立（会话第一次调用的就是破坏性动作）：**会话卡优先**——那一刻用户要先
 * 决定「这条会话能不能动沙箱」，不是逐个确认那一下；风险行照样画在会话卡上。
 *
 * **会话卡不接受参数改写**：它放行的是整条会话，闸门拿到答案也只当 allow / deny 用
 * （`src/agent/permission.ts` 的 session 分支不读 `answer.input`）。卡面不摆「改参数」，
 * 免得用户以为改过的这一步会按新参数执行。
 */
import type { ComputerUseRisk } from "@shared/computer-guard";

export type ApprovalCardKind = "session" | "risk" | "call";

export interface ApprovalCardShape {
  kind: ApprovalCardKind;
  /** 卡面要不要摆「改参数」按钮 */
  canEditArgs: boolean;
}

export function approvalCardShape(approval: { scope?: "call" | "session"; risk?: ComputerUseRisk }): ApprovalCardShape {
  if (approval.scope === "session") return { kind: "session", canEditArgs: false };
  return { kind: approval.risk === undefined ? "call" : "risk", canEditArgs: true };
}
