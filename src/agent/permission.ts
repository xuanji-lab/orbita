/**
 * 把 pi 的工具定义包一层权限门。
 *
 * pi 的循环拿到工具对象就直接调 `execute`——它不认识「审批」这个概念。
 * 但**工具定义是我们递给它的**，所以替换掉 `execute` 字段就等于插入了一个执行前的关口：
 *
 *   模型 → pi 循环 → 我们包装后的 execute
 *                     ├─ decidePermission(mode, name)
 *                     ├─ deny  → 抛错（pi 当成工具失败，把原因回灌给模型）
 *                     ├─ ask   → 等用户回答；拒绝同上，允许则继续
 *                     └─ allow → 调原装 execute
 *
 * 三档模式只是同一个包装的三种返回策略，不需要动 pi 任何东西。
 */
import {
  decidePermission,
  type PermissionAnswer,
  type PermissionMode,
} from "../shared/permission.ts";

/** 最小工具形状：只关心名字与 execute，其余字段原样透传。 */
export interface WrappableTool {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
  ) => Promise<unknown>;
}

/** 询问用户。由 runtime 实现（跨进程往返），这里只依赖它的签名。 */
export type PermissionAsk = (request: {
  toolCallId: string;
  toolName: string;
  input: unknown;
}) => Promise<PermissionAnswer>;

export class PermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionDeniedError";
  }
}

export function wrapWithPermission<T extends WrappableTool>(
  tool: T,
  getMode: () => PermissionMode,
  ask: PermissionAsk,
): T {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const decision = decidePermission(getMode(), tool.name);

      if (decision.behavior === "deny") throw new PermissionDeniedError(decision.message);

      if (decision.behavior === "ask") {
        const answer = await ask({ toolCallId, toolName: tool.name, input: params });
        if (answer.behavior === "deny") {
          throw new PermissionDeniedError(answer.message ?? "Denied by the user.");
        }
        // 用户可以改写入参后放行（把 rm -rf 改成别的路径），改写后的值优先
        const effective = answer.input === undefined ? params : answer.input;
        return tool.execute(toolCallId, effective, signal, onUpdate);
      }

      return tool.execute(toolCallId, params, signal, onUpdate);
    },
  };
}
