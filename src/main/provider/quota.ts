/**
 * 额度探针 —— 纯模块：不 import electron，可被 `node --test` 直接加载。
 *
 * 一个能力一个分支。今天只有 DeepSeek 的余额（公开文档接口）；套餐窗口
 * （智谱 / Z.AI / Kimi）是下一个 PR，加在这张 switch 里。
 *
 * 失败分类必须分清（decisions 15）：
 *   auth     = 钥匙不对 / 没填钥匙（用户能立刻改）
 *   protocol = 端点没了 / 格式变了（厂商改版的信号）
 *   network  = 连不上 / 超时 / 5xx（等等再试）
 * 预算 8s：额度是「打开看一眼」的东西，宁可说失败也不让界面挂在转圈上。
 */
import type { QuotaCredits, QuotaFailure, QuotaResult, QuotaSnapshot } from "../../shared/quota.ts";

/** 探针入参。`kind` 是**目录条目 id**（`knownProviderOf` 的结果），不是存储行的 kind */
export interface QuotaProbeInput {
  probe: "balance" | "plan-windows" | "none";
  kind?: string;
  baseUrl: string;
  apiKey: string | null;
}

const TIMEOUT_MS = 8_000;

function failure(reason: QuotaFailure): QuotaResult {
  return { status: "error", reason, cached: null };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * 把 `/user/balance` 的响应翻成快照。结构不认就返回 null（调用方判 protocol）。
 *
 * **多币种：这一版只取第一个**（DeepSeek 的 `balance_infos` 通常只有一条；
 * 国际账号是 USD、国内是 CNY）。多币种要扩成 `credits: QuotaCredits[]`，
 * 那是契约变更 + 界面多行，留给 PR2；在那之前行为就是「取第一个，其余忽略」，
 * 已记录在案，不是静默丢失。
 *
 * 金额原样保留字符串：`"43.21"` 不做 `Number()`——转一次就可能掉末尾的 0。
 */
export function parseDeepseekBalance(body: unknown, fetchedAt: number): QuotaSnapshot | null {
  const record = asRecord(body);
  if (record === null) return null;
  const infos = record.balance_infos;
  if (!Array.isArray(infos)) return null;
  const first = infos.length === 0 ? null : asRecord(infos[0]);
  if (infos.length > 0 && first === null) return null;

  // 厂商明说不可用 = 余额为 0（这是事实，不是未知）；结构里一条都没有也不猜
  const unavailable = record.is_available === false;
  const total = first === null ? undefined : asString(first.total_balance);
  if (first === null && !unavailable) return null;
  if (total === undefined && !unavailable) return null;

  const currency = first === null ? "" : (asString(first.currency) ?? "");
  const granted = first === null ? undefined : asString(first.granted_balance);
  const toppedUp = first === null ? undefined : asString(first.topped_up_balance);
  const credits: QuotaCredits = {
    amount: unavailable ? "0" : (total ?? "0"),
    currency,
    // 不可用时不给拆分：厂商说「没有余额」，拆出来的两个数也就没有意义
    ...(unavailable || granted === undefined ? {} : { granted }),
    ...(unavailable || toppedUp === undefined ? {} : { toppedUp }),
  };
  return { credits, windows: [], fetchedAt };
}

export async function probeQuota(input: QuotaProbeInput): Promise<QuotaResult> {
  if (input.probe === "none") return { status: "none" };
  if (input.probe !== "balance" || input.kind !== "deepseek") {
    // 能力声明了但这家还没接（PR1 只有 deepseek 声明 balance，这条是给 PR2 的默认拒绝）
    return failure("unsupported");
  }
  if (input.apiKey === null || input.apiKey === "") return failure("auth");

  let origin: string;
  try {
    origin = new URL(input.baseUrl).origin;
  } catch {
    return failure("protocol");
  }

  let response: Response;
  try {
    response = await fetch(`${origin}/user/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // 超时、DNS、TLS、连接被拒：都归 network——用户能做的是稍后再试
    return failure("network");
  }

  if (response.status === 401 || response.status === 403) return failure("auth");
  if (response.status === 404) return failure("protocol");
  if (!response.ok) return failure("network");

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return failure("protocol");
  }
  const snapshot = parseDeepseekBalance(body, Date.now());
  if (snapshot === null) return failure("protocol");
  return { status: "ok", snapshot, fromCache: false };
}
