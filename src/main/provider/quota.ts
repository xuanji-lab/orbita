/**
 * 额度探针 —— 纯模块：不 import electron，可被 `node --test` 直接加载。
 *
 * 一个能力一个分支：
 *   balance      → DeepSeek 的余额（公开文档接口）
 *   plan-windows → 智谱 Coding Plan（国内站 / 国际站同一后端）+ Kimi Code 的套餐窗口
 *
 * 失败分类必须分清（decisions 15）：
 *   auth        = 钥匙不对 / 没填钥匙（用户能立刻改）
 *   protocol    = 端点没了 / 格式变了（厂商改版的信号）
 *   network     = 连不上 / 超时 / 5xx（等等再试）
 *   unsupported = 这家就是查不了（团队账号 / 没有个人套餐）
 * 预算 8s：额度是「打开看一眼」的东西，宁可说失败也不让界面挂在转圈上。
 */
import type {
  QuotaCredits,
  QuotaFailure,
  QuotaResult,
  QuotaSnapshot,
  QuotaWindow,
  QuotaWindowKind,
} from "../../shared/quota.ts";

/** 探针入参。`kind` 是**目录条目 id**（`knownProviderOf` 的结果），不是存储行的 kind */
export interface QuotaProbeInput {
  probe: "balance" | "plan-windows" | "none";
  kind?: string;
  baseUrl: string;
  apiKey: string | null;
}

const TIMEOUT_MS = 8_000;

/** 已知窗口类别的英文标签（厂商没给 label，这个是我们自己起的稳定名，渲染层按 kind 本地化） */
const KIND_LABELS = {
  "5h": "5-hour window",
  weekly: "Weekly",
  monthly: "Monthly",
  // MCP 工具额度：与 token 窗口不是同一种东西，标签必须分开
  mcp: "MCP monthly",
} as const;

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
 * 数字口径：厂商有时把同一个字段给成 `"12"` 或 `12`（Kimi 的 remaining / used 两种都见过）。
 * 只接受有限数；认不出就是 `undefined`——调用方据此**跳过这一项**，不拿 0 冒充。
 */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 重置时刻：厂商可能给毫秒数、秒数、ISO 字符串，三种都认。认不出就不写（不编一个）。
 *
 * 秒 / 毫秒按量级分辨：`1e11` 毫秒 = 1973 年，`1e11` 秒 = 5138 年——
 * 落在两者之间说明是按秒给的。这条分辨是 Proma 在 codex 上踩过的坑。
 */
function asTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    if (value > 1e11) return value;
    if (value > 1e9) return value * 1_000;
    return undefined;
  }
  const text = asString(value);
  if (text === undefined) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) return asTimestamp(Number(text));
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return parsed;
  // 实测（2026-10-23）：Kimi 给的是微秒级 ISO（`2026-10-26T13:43:42.336823Z`）。
  // V8 认；但规范只保证三位小数，认不出时把小数截到三位再试一次，仍不就放弃。
  const trimmed = text.replace(/\.(\d{3})\d+/, ".$1");
  if (trimmed === text) return undefined;
  const retried = Date.parse(trimmed);
  return Number.isFinite(retried) ? retried : undefined;
}

interface FetchOk {
  ok: true;
  body: unknown;
}

interface FetchFail {
  ok: false;
  reason: QuotaFailure;
  /** 换一个主机再试有意义吗（404 / 连接失败 / 5xx）；401 与结构错误重试只是多打一次 */
  retryable: boolean;
}

/** 一次 GET + JSON 解析，把 HTTP 状态压成四类原因（分类口径与 DeepSeek 那条一致） */
/**
 * 一次 GET + JSON 解析，把 HTTP 状态压成四类原因（分类口径与 DeepSeek 那条一致）。
 * `forbidden` 让调用方覆盖 403 的分类：OpenCode Go 用 403 表示「没订阅 / 凭据不合法」，
 * 那与「钥匙填错了」不是同一件要用户做的事。
 */
async function fetchJson(
  url: string,
  headers: Record<string, string>,
  forbidden: QuotaFailure = "auth",
): Promise<FetchOk | FetchFail> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // 超时、DNS、TLS、连接被拒：都归 network——用户能做的是稍后再试
    return { ok: false, reason: "network", retryable: true };
  }
  if (response.status === 401) return { ok: false, reason: "auth", retryable: false };
  if (response.status === 403) return { ok: false, reason: forbidden, retryable: false };
  if (response.status === 404) return { ok: false, reason: "protocol", retryable: true };
  if (!response.ok) return { ok: false, reason: "network", retryable: response.status >= 500 };
  try {
    return { ok: true, body: (await response.json()) as unknown };
  } catch {
    return { ok: false, reason: "protocol", retryable: false };
  }
}

interface ParseOk {
  ok: true;
  snapshot: QuotaSnapshot;
}

interface ParseFail {
  ok: false;
  reason: QuotaFailure;
}

type ParseOutcome = ParseOk | ParseFail;

function parsed(windows: QuotaWindow[], fetchedAt: number): ParseOk {
  return { ok: true, snapshot: { windows, fetchedAt } };
}

/* ------------------------------------------------------------------ *
 * DeepSeek：API 余额
 * ------------------------------------------------------------------ */

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

async function probeDeepseek(origin: string, apiKey: string): Promise<QuotaResult> {
  const attempt = await fetchJson(`${origin}/user/balance`, {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  });
  if (!attempt.ok) return failure(attempt.reason);
  const snapshot = parseDeepseekBalance(attempt.body, Date.now());
  if (snapshot === null) return failure("protocol");
  return { status: "ok", snapshot, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * 智谱 / Z.AI：Coding Plan 的 5 小时 / 每周 / 每月窗口
 * ------------------------------------------------------------------ */

const ZHIPU_QUOTA_PATH = "/api/monitor/usage/quota/limit";

/**
 * 错误信封里能透出「这是团队账号」的线索。团队版要求 `?type=2` + 组织 / 项目头，
 * 我们没有组织配置的概念（decisions 4），所以只能按返回猜：命中就归 unsupported，
 * 文案说「团队账号不支持」，用户才知道该换个人账号，而不是去检查钥匙。
 */
const TEAM_HINT = /组织|团队|企业|organization|team|enterprise/i;

/**
 * 把 `/api/monitor/usage/quota/limit` 的响应翻成窗口。智谱与 Z.AI 是同一个后端。
 *
 * 三条硬纪律：
 *   - 窗口**只按 `type + unit + number` 识别，绝不按数组下标猜**（ZCode 的做法）：
 *     `TOKENS_LIMIT,3,5` = 5 小时，`TOKENS_LIMIT,6` = 每周，`TIME_LIMIT` = MCP 每月调用额度，
 *     `CREDIT_LIMIT` = 账号的每月额度；
 *   - **`MCP 每月` 与 token 窗口不是同一种额度，标签必须区分**（2026-10-23 验收时发现
 *     两者都写成「每月」，界面读起来像同一类窗口）——下一个人改文案时不要再合并回去；
 *   - `percentage` 是**已用**，直接作 `usedPercent`；`remaining` / `usage` 是厂商的另一套数，
 *     不当唯一口径（不在这里再做第二次换算）；
 *   - 成功但 `limits` 是空数组 = 没有个人额度（团队账号的常态）→ unsupported，不是 0%。
 */
export function parseZhipuQuota(body: unknown, fetchedAt: number): ParseOutcome {
  const record = asRecord(body);
  if (record === null) return { ok: false, reason: "protocol" };
  if (record.success !== true || asNumber(record.code) !== 200) {
    const code = asNumber(record.code);
    const msg = asString(record.msg) ?? asString(record.message) ?? "";
    // 实测（2026-10-23 无密钥直打两家端点）：**站点用 HTTP 200 装错误信封**——
    // 钥匙不对时 `code: 401`（「令牌已过期或验证不正确」），
    // 没带 Authorization 时 `code: 1001`（「Header中未收到Authorization参数」）。
    // 这两种必须归 auth，否则用户拿错钥匙看到的是「厂商改版了」（decisions 15）。
    if (code === 401 || code === 403 || code === 1001) return { ok: false, reason: "auth" };
    // 其余错误一律 protocol：msg 是厂商的自由文本，只有「组织/团队」这类词能可靠指向团队账号
    return { ok: false, reason: TEAM_HINT.test(msg) ? "unsupported" : "protocol" };
  }
  const data = asRecord(record.data);
  const limits = data === null ? undefined : data.limits;
  if (!Array.isArray(limits)) return { ok: false, reason: "protocol" };

  const windows: QuotaWindow[] = [];
  const seen = new Set<string>();
  for (const raw of limits) {
    const window = zhipuWindow(asRecord(raw));
    // 同一个 id 只留第一条：重复的 React key 比少一个窗口更坏
    if (window === null || seen.has(window.id)) continue;
    seen.add(window.id);
    windows.push(window);
  }
  if (windows.length === 0) return { ok: false, reason: "unsupported" };
  return parsed(windows, fetchedAt);
}

function zhipuWindow(limit: Record<string, unknown> | null): QuotaWindow | null {
  if (limit === null) return null;
  const type = asString(limit.type);
  if (type === undefined) return null;
  const percentage = asNumber(limit.percentage);
  // percentage 是唯一可信的「已用」口径：缺了就不猜，这一项整条跳过
  if (percentage === undefined) return null;

  const unit = asNumber(limit.unit);
  const number = asNumber(limit.number);
  const suffix = [unit, number].filter((value): value is number => value !== undefined).join(":");
  const id = suffix === "" ? type.toLowerCase() : `${type.toLowerCase()}:${suffix}`;

  let kind: QuotaWindowKind = "custom";
  let label: string = type;
  let windowMinutes: number | undefined;
  if (type === "TOKENS_LIMIT" && unit === 3 && number === 5) {
    kind = "5h";
    label = KIND_LABELS["5h"];
    windowMinutes = 5 * 60;
  } else if (type === "TOKENS_LIMIT" && unit === 6) {
    kind = "weekly";
    label = KIND_LABELS.weekly;
    windowMinutes = 7 * 24 * 60;
  } else if (type === "TIME_LIMIT") {
    // MCP 工具的每月调用额度（usageDetails 里是 search-prime / web-reader 这些工具），
    // **不是 token 套餐的月窗**：单独一类 mcp
    kind = "mcp";
    label = KIND_LABELS.mcp;
  } else if (type === "CREDIT_LIMIT") {
    // Z.AI 团队版的账号级额度，才是真正的「每月」窗口
    kind = "monthly";
    label = KIND_LABELS.monthly;
  }

  const resetsAt = asTimestamp(limit.nextResetTime);
  return {
    id,
    label,
    kind,
    usedPercent: percentage,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

async function probeZhipu(origin: string, apiKey: string, fallbacks: string[]): Promise<QuotaResult> {
  // 探针只拿得到 providers 里那一行 baseUrl，用户填的可能是子路径 / 镜像；
  // 官方主机依次兜底（最多两个），全失败按最后一次的原因归类。
  const origins = [origin, ...fallbacks].filter((item, index, all) => all.indexOf(item) === index);
  let lastReason: QuotaFailure = "network";
  for (const candidate of origins) {
    // ⚠ 这个接口要的是**裸 key**：带上 `Bearer ` 直接 401（Proma / ZCode 都是这么写的）
    const attempt = await fetchJson(`${candidate}${ZHIPU_QUOTA_PATH}`, {
      Authorization: apiKey,
      Accept: "application/json",
    });
    if (attempt.ok) {
      const outcome = parseZhipuQuota(attempt.body, Date.now());
      if (!outcome.ok) return failure(outcome.reason);
      return { status: "ok", snapshot: outcome.snapshot, fromCache: false };
    }
    lastReason = attempt.reason;
    if (!attempt.retryable) return failure(attempt.reason);
  }
  return failure(lastReason);
}

/* ------------------------------------------------------------------ *
 * Kimi Code：会员的用量窗口
 * ------------------------------------------------------------------ */

/**
 * Kimi 的每个窗口只有 `duration + timeUnit`，没有标签。所以我们自己推语义类别：
 * 300 分钟 = 5 小时、7 天 = 每周、30 天 = 每月，其余 custom。
 */
function kimiKind(windowMinutes: number | undefined): QuotaWindowKind {
  if (windowMinutes === 5 * 60) return "5h";
  if (windowMinutes === 7 * 24 * 60) return "weekly";
  if (windowMinutes === 30 * 24 * 60) return "monthly";
  return "custom";
}

/** `TIME_UNIT_HOUR` / `TIME_UNIT_MINUTE` / `TIME_UNIT_DAY` → 分钟；认不出就不写长度 */
function kimiWindowMinutes(duration: unknown, timeUnit: unknown): number | undefined {
  const count = asNumber(duration);
  const unit = asString(timeUnit);
  if (count === undefined || unit === undefined) return undefined;
  switch (unit.replace(/^TIME_UNIT_/, "").toUpperCase()) {
    case "MINUTE":
      return count;
    case "HOUR":
      return count * 60;
    case "DAY":
      return count * 24 * 60;
    default:
      return undefined;
  }
}

/**
 * 已用百分比 = used / (used + remaining)。分母为 0 或缺失 → 没有「用了百分之多少」
 * 这回事，调用方跳过这个窗口（不写 0% 冒充）。
 *
 * 实测（2026-10-23，真实账号）：`limits[].detail` **只有 `limit` 与 `remaining`，没有 `used`**，
 * 而顶层 `usage` 三个都给。缺 `used` 时用 `limit - remaining` 推（同一件事，方向不变）。
 */
function kimiUsedPercent(used: unknown, remaining: unknown, limit: unknown): number | undefined {
  const remainingValue = asNumber(remaining);
  if (remainingValue === undefined) return undefined;
  const limitValue = asNumber(limit);
  const rawUsed = asNumber(used) ?? (limitValue === undefined ? undefined : limitValue - remainingValue);
  if (rawUsed === undefined) return undefined;
  // remaining 比 limit 还大（厂商自己的数据不一致）：夹到 0，不让界面出现负数百分比
  const usedValue = Math.max(0, rawUsed);
  const total = usedValue + remainingValue;
  if (!(total > 0)) return undefined;
  const percent = (usedValue / total) * 100;
  return Number.isFinite(percent) ? percent : undefined;
}

/** custom 窗口的原文标签：机器口径的短写（`3h` / `45m` / `2d`），认不出单位就照抄枚举 */
function kimiLabel(kind: QuotaWindowKind, duration: unknown, timeUnit: unknown): string {
  if (kind !== "custom") return KIND_LABELS[kind];
  const count = asNumber(duration);
  const unit = asString(timeUnit);
  if (count === undefined || unit === undefined) return "Window";
  switch (unit.replace(/^TIME_UNIT_/, "").toUpperCase()) {
    case "MINUTE":
      return `${count}m`;
    case "HOUR":
      return `${count}h`;
    case "DAY":
      return `${count}d`;
    default:
      return `${count} ${unit}`;
  }
}

/** 一个窗口：`{ window: { duration, timeUnit }, detail: { remaining, used, resetTime } }` */
function kimiWindow(limit: Record<string, unknown> | null, id: string): QuotaWindow | null {
  if (limit === null) return null;
  const detail = asRecord(limit.detail);
  if (detail === null) return null;
  const percent = kimiUsedPercent(detail.used, detail.remaining, detail.limit);
  if (percent === undefined) return null;
  const window = asRecord(limit.window);
  const duration = window === null ? undefined : window.duration;
  const timeUnit = window === null ? undefined : window.timeUnit;
  const windowMinutes = kimiWindowMinutes(duration, timeUnit);
  const kind = kimiKind(windowMinutes);
  const resetsAt = asTimestamp(detail.resetTime);
  return {
    id,
    label: kimiLabel(kind, duration, timeUnit),
    kind,
    usedPercent: percent,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

/**
 * 把 `/coding/v1/usages` 的响应翻成窗口。
 *
 * 实测（2026-10-23，真实账号）：`limits` 里只有 5 小时窗（`duration:300, TIME_UNIT_MINUTE`），
 * 而顶层 `usage` 是**另一个**窗（重置在 3 天后 = 周窗）。所以两者**都要**：
 *   - `limits` 逐个翻；
 *   - `usage` 作一个周窗（Kimi 的摘要固定是周窗，见 Proma），但已经有一个周窗、
 *     或它的重置时刻与某个已翻出的窗口重合（同一窗口的另一种说法）时跳过，不重复计数。
 * 两者都拿不到 → protocol，不编一个空的成功。
 */
export function parseKimiUsage(body: unknown, fetchedAt: number): ParseOutcome {
  const record = asRecord(body);
  if (record === null) return { ok: false, reason: "protocol" };
  const code = asNumber(record.code);
  // 实测（2026-10-23）：钥匙无效时 Kimi 直接回 HTTP 401（上面的 fetchJson 已归 auth）；
  // 这里的 401 / 403 是「将来如果改成 200 + 业务码」的兑底
  if (code === 401 || code === 403) return { ok: false, reason: "auth" };
  if (code !== undefined && code !== 0 && code !== 200) return { ok: false, reason: "protocol" };

  const windows: QuotaWindow[] = [];
  const limits = record.limits;
  if (Array.isArray(limits)) {
    limits.forEach((raw, index) => {
      const window = kimiWindow(asRecord(raw), `limit:${index}`);
      if (window !== null) windows.push(window);
    });
  }
  const usage = asRecord(record.usage);
  const percent = usage === null ? undefined : kimiUsedPercent(usage.used, usage.remaining, usage.limit);
  if (usage !== null && percent !== undefined) {
    const resetsAt = asTimestamp(usage.resetTime);
    const duplicate =
      windows.some((window) => window.kind === "weekly") ||
      (resetsAt !== undefined &&
        windows.some((window) => window.resetsAt !== undefined && Math.abs(window.resetsAt - resetsAt) < 60_000));
    if (!duplicate) {
      windows.push({
        id: "usage",
        label: KIND_LABELS.weekly,
        kind: "weekly",
        usedPercent: percent,
        windowMinutes: 7 * 24 * 60,
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    }
  }
  if (windows.length === 0) return { ok: false, reason: "protocol" };
  return parsed(windows, fetchedAt);
}

async function probeKimi(origin: string, apiKey: string): Promise<QuotaResult> {
  // `/coding` 不在 origin 里（baseUrl 可能是 `https://api.kimi.com/coding`），从根拼回来
  let url: string;
  try {
    url = new URL("/coding/v1/usages", origin).toString();
  } catch {
    return failure("protocol");
  }
  const attempt = await fetchJson(url, {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  });
  if (!attempt.ok) return failure(attempt.reason);
  const outcome = parseKimiUsage(attempt.body, Date.now());
  if (!outcome.ok) return failure(outcome.reason);
  return { status: "ok", snapshot: outcome.snapshot, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * OpenCode Go：订阅的三个用量窗口
 * ------------------------------------------------------------------ */

/** 固定顺序（也是 id）：厂商没给顺序，界面每次打开不应该换行 */
const OPENCODE_WINDOW_IDS = ["rolling", "weekly", "monthly"] as const;

/**
 * 把 `/zen/go/v1/usage` 的响应翻成窗口。
 *
 * ⚠ 这个端点是**推理网关自己的路由，官方文档没写**（文档只说「去 console 看用量」），
 * 属于「能用但未文档化」：厂商改版就静默失效，所以上层必须能把它当失败藏起来。
 *
 * 三条纪律：
 *   - 三个窗口**不是每个都在**（按订阅类型），缺哪个跳过哪个，不补 0%；
 *   - `percent` 是**已用**，直接作 `usedPercent`；超过 100 不在这里夹（渲染层已经夹过）；
 *   - `status`（`ok` / `rate-limited`）**不折成百分比、不参与计算**：数字以 `percent` 为准。
 *     「rate-limited 就不算可用」这个判断**还没在真机验证**，先照原样收下不据它过滤。
 */
export function parseOpenCodeUsage(body: unknown, fetchedAt: number): ParseOutcome {
  const record = asRecord(body);
  if (record === null) return { ok: false, reason: "protocol" };
  const usage = asRecord(record.usage);
  if (usage === null) return { ok: false, reason: "protocol" };

  const windows: QuotaWindow[] = [];
  for (const id of OPENCODE_WINDOW_IDS) {
    const entry = asRecord(usage[id]);
    if (entry === null) continue;
    const percent = asNumber(entry.percent);
    // 缺 percent（或不是数）= 这一项没有可展示的数字，跳过，不写 0% 冒充
    if (percent === undefined) continue;
    const resetsAt = asTimestamp(entry.resetsAt);
    /*
     * `rolling` 就是 OpenCode 的 5 小时订阅窗：上游 `Subscription.analyzeRollingUsage`
     * 算的就是它，issue #43983 的原话是 "the current rolling 5-hour, weekly, and monthly
     * limits"。所以对外按 `5h` 标（与智谱 / Kimi 同一档），id 仍保留厂商的 `rolling`——
     * 将来厂商改了窗口长度，从 id 还能看出来源。
     */
    const kind: QuotaWindowKind = id === "rolling" ? "5h" : id;
    windows.push({
      id,
      label: KIND_LABELS[kind],
      kind,
      usedPercent: percent,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  if (windows.length === 0) return { ok: false, reason: "protocol" };
  return parsed(windows, fetchedAt);
}

async function probeOpenCode(origin: string, apiKey: string): Promise<QuotaResult> {
  // baseUrl 是 `https://opencode.ai/zen/go/v1`；路径从 origin 拼回来，与 Kimi 同一手法
  let url: string;
  try {
    url = new URL("/zen/go/v1/usage", origin).toString();
  } catch {
    return failure("protocol");
  }
  const attempt = await fetchJson(
    url,
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    // 403：源码里 `EntitlementError` 的语义——没订阅 / 凭据不合法，要用户换账号而不是换钥匙
    "unsupported",
  );
  if (!attempt.ok) return failure(attempt.reason);
  const outcome = parseOpenCodeUsage(attempt.body, Date.now());
  if (!outcome.ok) return failure(outcome.reason);
  return { status: "ok", snapshot: outcome.snapshot, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * StepFun：Step Plan 的额度
 * ------------------------------------------------------------------ */

/**
 * StepFun 的 **200 响应至今没人见过**（证据见下），所以解析只接受两种可辩护的形状，
 * 其余一律 protocol——不猜字段含义、不拿未知字段当百分比。
 *
 * 已知事实（2026-10-23）：
 *   - 官方 API 参考只有 chat / models / files / audio，计费页只讲 Credit 规则并让去控制台看；
 *   - `stepfun-cli@0.2.4` 与 `stepcode@2.0.0` 的 bundle 里没有任何 usage 路径；
 *   - 路由**真实存在**：`GET /step_plan/v1/usage` 无凭据回 401
 *     （`invalid_api_key`），而同方向的 `/usage/summary`、`/credits`、`/balance`、
 *     `/subscription`、`/v1/usage`、`/v1/user/balance` 全部 404。
 *
 * 所以：**这条 200 至今没人见过**，下面的解析是「可辩护的保守假设」。第一次拿到真实响应后
 * 要回来收紧（尤其是 `rolling` 到底是不是 5 小时窗）；认不出时只打**字段名**，不打值。
 */
export function parseStepfunUsage(body: unknown, fetchedAt: number): ParseOutcome {
  const record = asRecord(body);
  if (record === null) return { ok: false, reason: "protocol" };

  const windows = stepfunWindows(asRecord(record.usage));
  if (windows.length > 0) return parsed(windows, fetchedAt);

  const credits = stepfunCredits(record);
  if (credits !== null) return { ok: true, snapshot: { credits, windows: [], fetchedAt } };

  // 只打字段名：这里可能有额度数字或账号信息，一个值都不进日志
  console.warn(
    "[quota] stepfun 未识别的响应字段",
    Object.keys(record),
    Object.keys(asRecord(record.usage) ?? {}),
  );
  return { ok: false, reason: "protocol" };
}

/**
 * 窗口式：`{ usage: { <name>: { percent, resetsAt|resetTime } } }`。
 * `rolling` 按 5 小时窗处理（Step Plan 的滚动窗，与智谱 / Kimi / OpenCode 同档）——
 * **这是假设，不是实证**；其余 `weekly` / `monthly` 按名字；认不得的名字用原文当标签。
 */
function stepfunWindows(usage: Record<string, unknown> | null): QuotaWindow[] {
  if (usage === null) return [];
  const windows: QuotaWindow[] = [];
  for (const [name, value] of Object.entries(usage)) {
    const entry = asRecord(value);
    if (entry === null) continue;
    const percent = asNumber(entry.percent);
    // 缺 percent 就不拿 unknown 字段顶上：这一项跳过，不写 0% 冒充
    if (percent === undefined) continue;
    const kind = stepfunKind(name);
    const resetsAt = asTimestamp(entry.resetsAt) ?? asTimestamp(entry.resetTime);
    windows.push({
      id: name,
      label: kind === "custom" ? name : KIND_LABELS[kind],
      kind,
      usedPercent: percent,
      ...(kind === "5h" ? { windowMinutes: 5 * 60 } : {}),
      ...(kind === "weekly" ? { windowMinutes: 7 * 24 * 60 } : {}),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return windows;
}

function stepfunKind(name: string): QuotaWindowKind {
  switch (name) {
    case "rolling":
      return "5h";
    case "weekly":
      return "weekly";
    case "monthly":
      return "monthly";
    default:
      return "custom";
  }
}

/** 金额字段：字符串原样保精度，数字转字符串（数字本身没有末尾 0，不会丢） */
function stepfunMoney(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") return value;
  const parsed = asNumber(value);
  return parsed === undefined ? undefined : String(parsed);
}

/**
 * 余额式：`{ credits|credit|balance: { total|remaining|used } }`，能配出「剩余」的才算数。
 * `remaining` 直接就是答案；只有 `total` 时它自己就是剩余；`total` + `used` 做一次减法
 * （本探针唯一的金额算术，只用于积分类整数）。币种缺省 `CNY`（StepFun 是国内站）。
 */
function stepfunCredits(record: Record<string, unknown>): QuotaCredits | null {
  const source = asRecord(record.credits) ?? asRecord(record.credit) ?? asRecord(record.balance);
  if (source === null) return null;
  const currency = asString(source.currency) ?? "CNY";
  const remaining = stepfunMoney(source.remaining);
  if (remaining !== undefined) return { amount: remaining, currency };
  const total = stepfunMoney(source.total);
  if (total === undefined) return null;
  const used = stepfunMoney(source.used);
  if (used === undefined) return { amount: total, currency };
  const derived = Number(total) - Number(used);
  return Number.isFinite(derived) ? { amount: String(derived), currency } : null;
}

async function probeStepfun(origin: string, apiKey: string): Promise<QuotaResult> {
  let url: string;
  try {
    url = new URL("/step_plan/v1/usage", origin).toString();
  } catch {
    return failure("protocol");
  }
  const attempt = await fetchJson(
    url,
    { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    // 403：账号不符合 Step Plan 的条件（没订阅 / 不在白名单），要用户换账号
    "unsupported",
  );
  if (!attempt.ok) return failure(attempt.reason);
  const outcome = parseStepfunUsage(attempt.body, Date.now());
  if (!outcome.ok) return failure(outcome.reason);
  return { status: "ok", snapshot: outcome.snapshot, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * 分发
 * ------------------------------------------------------------------ */

/** 智谱 / Z.AI 的官方主机兜底（最多两个；`zai` 先自己，再回国内站） */
const ZHIPU_FALLBACKS = ["https://open.bigmodel.cn", "https://bigmodel.cn"];
const ZAI_FALLBACKS = ["https://api.z.ai", "https://open.bigmodel.cn"];

export async function probeQuota(input: QuotaProbeInput): Promise<QuotaResult> {
  if (input.probe === "none") return { status: "none" };
  if (input.apiKey === null || input.apiKey === "") return failure("auth");

  let origin: string;
  try {
    origin = new URL(input.baseUrl).origin;
  } catch {
    return failure("protocol");
  }

  if (input.probe === "balance") {
    // 余额类今天只有 DeepSeek 一家声明；其余条目声明了 balance 也算「说了但没接」
    return input.kind === "deepseek" ? probeDeepseek(origin, input.apiKey) : failure("unsupported");
  }

  switch (input.kind) {
    case "zhipu-coding":
      return probeZhipu(origin, input.apiKey, ZHIPU_FALLBACKS);
    case "zai":
      return probeZhipu(origin, input.apiKey, ZAI_FALLBACKS);
    case "kimi-coding":
      return probeKimi(origin, input.apiKey);
    case "opencode-go":
      return probeOpenCode(origin, input.apiKey);
    case "stepfun":
      return probeStepfun(origin, input.apiKey);
    default:
      // 能力声明了但这家还没接：不猜端点
      return failure("unsupported");
  }
}
