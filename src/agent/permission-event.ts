/**
 * 「执行前请示」（permission 事件）的唯一构造点。
 *
 * 单独一个文件只为一件事：**scope / risk 的转发要能被钉住**。runtime 是 utility 进程入口，
 * import 它就等于把整个 agent 起起来（顶层注册 parentPort、发 ready），所以拼事件这一步放在
 * 这里，测试能直接断言「闸门给的可选字段一个都没漏」。
 *
 * 上一次的坑（2026-10-26 真机验收）：askPermission 只转发 toolCallId / toolName / input，
 * `scope` 与 `risk` 半路丢了。后果不只是卡面文案——skip 档的会话授权卡（「本次会话允许
 * agent 操作沙箱？」）永远显示成普通逐次审批卡，看起来只放行一步，点「允许」实际放行了
 * 整条会话的十个写工具；破坏性确认卡（D1/D2/D3）也没有风险行，用户只是在盲点允许。
 *
 * 字段定义只认 `src/shared/agent-ipc.ts` 的契约，不在这里重抄：契约加字段时这里跟着报错，
 * 而不是悄悄丢一个新的。
 */
import type { AgentEvent } from "../shared/agent-ipc.ts";

/** 契约里那一条事件的完整形状（含 scope / risk 的原始定义） */
export type PermissionEvent = Extract<AgentEvent, { type: "permission" }>;

/**
 * 由闸门的请示入参拼出 permission 事件。
 * 可选字段**有值才带**（与仓里其它事件一致）：缺席 = 普通逐次审批，不往线上塞 undefined。
 */
export function permissionEvent(
  fields: { requestId: string } & Omit<PermissionEvent, "type" | "requestId">,
): PermissionEvent {
  const { sessionId, requestId, toolName, input, scope, risk } = fields;
  return {
    type: "permission",
    sessionId,
    requestId,
    toolName,
    input,
    ...(scope === undefined ? {} : { scope }),
    ...(risk === undefined ? {} : { risk }),
  };
}
