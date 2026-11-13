/**
 * agent 记忆工具的转发（index.ts 的 onEvent 用）：agent → 主进程 → 记忆服务进程。
 * **纯模块**（不 import electron，可被 `node --test` 直接测）：会话 meta、服务拉起与
 * 转发全部注入。
 *
 * 主进程这一层做两件 agent 进程不该自己说了算的事：
 * - **子会话不写**：只有根会话注册这组工具，但「子会话读不写」不能只靠 agent 侧不注册——
 *   meta 带 parentId 的会话来的 revise / retire 一律拒（search 是读，放行）。
 *   meta 读不到按子会话处理（拒写）：宁可让一次纠错失败，也不让身份不明的会话改记忆。
 * - **作用域在主进程解析**（memoryScopeOf：workspaceId ?? cwd），与轮前召回同一口径——
 *   agent 只能看到和改「user 层 + 本会话作用域层」。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { memoryScopeOf, type MemoryAgentCall, type MemoryAgentOutcome } from "../../shared/memory.ts";

export interface MemoryToolForwardDeps {
  readMeta: (sessionId: string) => Promise<{ parentId?: string } | null>;
  /** 服务不在时先拉一把；false = 拉不起 */
  ensureStarted: () => Promise<boolean>;
  isRunning: () => boolean;
  agentTool: (input: {
    sessionId: string;
    scopeId: string;
    turn: number;
    call: MemoryAgentCall;
  }) => Promise<MemoryAgentOutcome>;
}

export async function forwardMemoryTool(
  deps: MemoryToolForwardDeps,
  event: Extract<AgentEvent, { type: "memoryToolRequest" }>,
): Promise<MemoryAgentOutcome> {
  try {
    if (event.call.op !== "search") {
      const meta = await deps.readMeta(event.sessionId).catch(() => null);
      if (meta === null || meta.parentId !== undefined) {
        return { ok: false, error: "子会话只读记忆，不能修改；请在回报里告诉父会话哪条记忆不对" };
      }
    }
    if (!deps.isRunning()) await deps.ensureStarted();
    return await deps.agentTool({
      sessionId: event.sessionId,
      scopeId: memoryScopeOf(event.scope),
      turn: event.turn,
      call: event.call,
    });
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
