/**
 * 「这一次记住了一个类」的**一次性审计注记**（agent 进程内，按会话）。
 *
 * 为什么需要它：审批发生在闸门（permission.ts），工具结果（details.computerUse）发生在
 * 工具定义（computer-tools / sandbox-tools）——两边隔着一层 pi，闸门回不了工具结果。
 * 而用户勾选「本会话内，这类动作不再问」的那一下，正是要能事后查的审计点。
 *
 * 做法：闸门在用户批准时写一条注记；**紧接着执行的那一件工具**在造审计载荷时取走它
 * （一次性）。这样 JSONL 里那一条 tool result 就带着 `rememberedClass`，与「谁在什么时候
 * 记住了什么」对得上。
 *
 * 纯内存、进程生命周期：持久真源是 SessionMeta 的 `computerUseRemembered`（主进程落盘），
 * 这里只是把同一个决定带进当次结果的通道，重启就没了——本来也不需要跨进程。
 */
import type { ComputerUseRememberedClass } from "../shared/permission.ts";

const pending = new Map<string, ComputerUseRememberedClass>();

/** 闸门在「勾选并批准」那一刻调用：下一次同会话的审计载荷带上它 */
export function noteRememberedClass(sessionId: string, cls: ComputerUseRememberedClass): void {
  pending.set(sessionId, cls);
}

/**
 * 取走注记（一次性）。没有返回 null——**不编造**：没记住过的调用不该带这个字段。
 * 工具在读审计的地方调用；多调一次也只是拿到 null。
 */
export function takeRememberedClass(sessionId: string): ComputerUseRememberedClass | null {
  const cls = pending.get(sessionId);
  if (cls === undefined) return null;
  pending.delete(sessionId);
  return cls;
}
