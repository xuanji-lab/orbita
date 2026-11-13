/**
 * Claude 提示缓存时长：Anthropic 官方直连的主会话用 1 小时，其余保持 pi 默认 5 分钟
 * （用户 2026-10-25 裁决：不出设置项，直接替用户定）。
 *
 * 为什么：pi 默认 `cacheRetention: "short"` = 5 分钟。用户读完回复想一会儿再回，
 * 回来时缓存多半已过期，整段上下文重写。1 小时写入单价是基础输入价 2 倍（5 分钟 1.25 倍），
 * 只要隔几分钟后还会再读一次就划算——主会话正是这种节奏。
 *
 * 判定（两条同时满足才给 "long"，否则不传、留给 pi 默认）：
 * - 请求发到 Anthropic 官方端点：协议 anthropic-messages，baseUrl 主机恰为 api.anthropic.com
 *   （订阅 OAuth 与官方 API key 两个条目同一个地址）。Anthropic 兼容网关（sub2api 一类）
 *   自己会插一个 5m 的 cache_control 块，再发 1h 块直接 400
 *   （`a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`），
 *   所以只认官方主机，不认「协议是 anthropic」。非 Anthropic 协议上 pi 会把 "long" 翻成
 *   OpenAI 的 24h 保留，那是另一回事，不碰。
 * - 是主会话（根会话，meta 无 parentId）。子会话连续干活，请求间隔很少超过 5 分钟，
 *   1 小时的 2 倍写入价换不来命中，保持 5 分钟。
 *
 * 不读 PI_CACHE_RETENTION：那是全局开关，网关上会每条失败。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** 会话的 provider 调用入口（`Agent.streamFunction` 的公开形状） */
type SessionStreamFn = AgentSession["agent"]["streamFunction"];

/** 本会话在父子关系里的身份（与 runtime 里决定通道工具的 role 同源：meta.parentId） */
export type SessionRole = "root" | "child";

/** Anthropic 官方 API 主机：只有它对 1 小时 cache_control 的行为经过实测 */
const OFFICIAL_ANTHROPIC_HOST = "api.anthropic.com";

/**
 * 纯判定：这次请求该不该改用 1 小时缓存。返回 "long" 或 undefined（= 不传，pi 默认）。
 * 按**这次请求**的 model 判，同一会话中途换型号 / 服务商，下一次请求跟着变。
 */
export function chooseCacheRetention(
  model: { api: string; baseUrl: string },
  role: SessionRole,
): "long" | undefined {
  if (role !== "root") return undefined;
  if (model.api !== "anthropic-messages") return undefined;
  let host: string;
  try {
    host = new URL(model.baseUrl).hostname;
  } catch {
    // 空串 / 非法地址：判不了就不动，保持默认
    return undefined;
  }
  return host === OFFICIAL_ANTHROPIC_HOST ? "long" : undefined;
}

/**
 * 包一层 streamFn：调用方没给 cacheRetention 时按判定补。调用方显式给了的
 * （pi 压缩 / 分支摘要固定传 "none"）原样保留。判定为 undefined 时 options 逐字透传。
 */
export function wrapStreamWithCacheRetention(inner: SessionStreamFn, role: SessionRole): SessionStreamFn {
  return (model, context, options) => {
    if (options?.cacheRetention !== undefined) return inner(model, context, options);
    const retention = chooseCacheRetention(model, role);
    if (retention === undefined) return inner(model, context, options);
    return inner(model, context, { ...options, cacheRetention: retention });
  };
}

/** 给会话装上包装（openTurn 建出 session 后调一次，同 applyBillingStreamPatch 的落点） */
export function applyCacheRetentionPatch(session: AgentSession, role: SessionRole): void {
  session.agent.streamFunction = wrapStreamWithCacheRetention(session.agent.streamFunction, role);
}
