/**
 * 订阅车道改写的「落点补全」：让绕过 agent 主循环的 provider 请求也过 ccBillingPatch。
 *
 * pi 0.84.3 的 `before_provider_request`（onPayload）只在 agent 主循环触发——loop
 * config 带着它调 streamFn（pi-agent-core `agent.js` 的 createLoopConfig）。压缩摘要
 * 与分支摘要不走主循环：`compaction.js` / `branch-summarization.js` 用自建的 options
 * （只有 maxTokens / signal / apiKey / headers / env / sessionId，没有 onPayload）
 * 直接调 `agent.streamFunction`。OAuth 车道上这些请求原样带着 pi 的身份块、没有
 * billing header 出门，被 Anthropic 以 claude_code_version_too_old 拒绝——手动
 * /compact、阈值自动压缩、上下文溢出恢复压缩全部失败。
 *
 * 解法在本仓侧收口：建出会话后包一层 `agent.streamFunction`。调用方没给 onPayload
 * （= 摘要路径）时注入 ccBillingPatch；主循环经扩展注册的 onPayload 原样放行——
 * 同一条改写，不会二次应用（ccBillingPatch 本身也幂等）。它只认带 pi OAuth 身份块
 * 的 payload，其它 provider 的请求返回 undefined 原样过，包装对它们是纯透传。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ccBillingPatch } from "./cc-billing-patch.ts";

/** 会话的 provider 调用入口（`Agent.streamFunction` 的公开形状） */
type SessionStreamFn = AgentSession["agent"]["streamFunction"];

/**
 * 包一层 streamFn：缺 onPayload 的调用注入订阅车道改写。只在 options 上补字段，
 * 不动 model / context；onPayload 已在的调用（主循环）逐字透传。
 */
export function wrapStreamWithBilling(inner: SessionStreamFn): SessionStreamFn {
  return (model, context, options) => {
    if (options?.onPayload !== undefined) return inner(model, context, options);
    return inner(model, context, { ...options, onPayload: (payload) => ccBillingPatch(payload) });
  };
}

/**
 * 给会话装上包装（openTurn 建出 session 后调一次）。压缩与分支摘要都在调用时现读
 * `agent.streamFunction`，属性替换一次即全覆盖；主循环同样从这一属性走，包装不改变
 * 它已有的 onPayload 通路（扩展注册的 before_provider_request）。
 */
export function applyBillingStreamPatch(session: AgentSession): void {
  session.agent.streamFunction = wrapStreamWithBilling(session.agent.streamFunction);
}
