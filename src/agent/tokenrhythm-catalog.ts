/**
 * 基元律动（tokenrhythm.studio）的自家目录 → pi 运行时里的一个 provider 条目。
 *
 * 它不在 pi.dev 的目录里（pi 只收 models.dev 认识的服务商），但**自己有一个公开目录**：
 * `GET https://tokenrhythm.studio/api/models`，不要 key，是它网站模型页用的接口——型号、
 * 上下文、能力、状态都在里面。方案：把这份目录**翻译成 pi 的一个 provider 条目注册进
 * 运行时**（`registerProvider`），下游全部复用现有的目录机制——设置页的型号清单、参数
 * 推断（model-defaults 按本家目录优先）、会话注册的保留合并（model-registration 的 known
 * 基线）、用量与价格图的官方单价，一个都不用另写。与 OpenCode Go 的差别只在「目录从哪来」：
 * 它读 pi.dev，我们读基元律动自己的接口。
 *
 * ## 容错与退回（用户已接受依赖这个未写进文档的接口，2026-10-24）
 * 拉取成功 → 原子写缓存（上次成功的原始响应）；拉取失败 → 缓存不动，继续用上次的；
 * 缓存也没有 → 不注册目录条目（设置页「获取模型」仍可用 key 打 `/v1/models` 拿 id 清单，
 * 参数退到白名单 / 跨目录借参——比目录口径弱，但能用）。响应整体形状不对（data 缺席 /
 * code 非 0）视为拉取失败，不落缓存；单条型号缺关键字段（如 contextWindow）只丢那一条。
 *
 * ## 单价 = 官方美元价（用户拍板，2026-10-24：「价格还是都是用模型的官方价格吧」）
 * 不用它的人民币价（inputPrice 等字段一律不读）。注册时对每个型号拿**同一型号**在 pi
 * 目录里的官方单价（复用用量侧的 officialRates：用户自填 > 本家目录 > 全目录同 id 非零价），
 * 带日期后缀的先去掉 `-MMDD` 再找（deepseek-v4.1-flash-1017 → deepseek-v4.1-flash）。
 * 这样每条消息按官方美元价计费（pi 按注册价算 usage.cost），用量格与价格图也口径一致；
 * 找不到官方价的填零价——用量里如实算「部分缺单价」、价格图进「缺官方单价」（现成行为）。
 *
 * ## 思考参数（minimal 除外均已实测可用；2026-10-25 用户用真 key 全量实测）
 * 按标准 OpenAI 发法（reasoning_effort、不带任何厂商 compat 怪癖）。目录映射三件事：
 * **minimal 一律不提供**——glm-5.3-flashx 与 deepseek-v4.1-flash-1017 发 minimal 直接
 * 400（no body），其余型号 minimal 与 low 无可分辨差别；reasoningMode=required 的不给
 * 「关」（thinkingLevelMap.off = null）；目录给了 efforts 档位清单的（如
 * minimax-m3.1-flash 的 low…max）照清单收窄。「关」是否真能关、档位深浅，由
 * 「用户自己定义每个型号的思考档」那条线解决，这里不按型号手写名单。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { writeJsonAtomic } from "../main/atomic-write.ts";
import { officialRates } from "../main/usage/task-cost.ts";
import { CATALOG_CACHE_ENV, type BuiltinProvider } from "../shared/agent-ipc.ts";
import type { ThinkingLevel } from "../shared/thinking.ts";
import { THINKING_LEVELS } from "../shared/thinking.ts";
import { toBuiltinProvider } from "./model-registration.ts";

/** 与 known-providers 的条目 id 一致：目录条目、缓存与注册都用它认账 */
export const TOKENRHYTHM_CATALOG_ID = "tokenrhythm";
/** 公开目录（网站模型页自用，未写进文档；不要 key） */
export const TOKENRHYTHM_MODELS_URL = "https://tokenrhythm.studio/api/models";
/** 默认（OpenAI Chat）接入方式的地址；Anthropic 接入方式用裸域（客户端自己接 /v1/messages） */
export const TOKENRHYTHM_BASE_URL = "https://tokenrhythm.studio/v1";

/** 目录里一条 chat 型号映射成注册条目后的形状（单价另算，见 priceOf） */
export interface TokenrhythmModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  input: ("text" | "image")[];
  reasoning: boolean;
  /** 与 pi 的 thinkingLevelMap 同语义：null = 不支持该档，缺省 = pi 默认映射 */
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/** 目录响应的整体形状不对（当拉取失败处理，不落缓存） */
export class TokenrhythmShapeError extends Error {}

const SKIP_STATUSES = new Set(["offline", "maintenance"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** OpenAI 协议可不可用：新形状（protocolCapabilities）优先，老形状（capabilities）兜底 */
function openaiAvailable(entry: Record<string, unknown>): boolean {
  const proto = isRecord(entry.protocolCapabilities) ? entry.protocolCapabilities : undefined;
  const openai = isRecord(proto?.openai) ? proto.openai : undefined;
  if (openai !== undefined) return openai.available === true;
  return isRecord(entry.capabilities) && entry.capabilities.openai === true;
}

/**
 * 思考档映射：目录的 reasoningMode / reasoningSupportedEfforts → pi 的 thinkingLevelMap。
 * - minimal 一律不提供（null）：2026-10-25 用户用真 key 全量实测，glm-5.3-flashx 与
 *   deepseek-v4.1-flash-1017 发 minimal 直接 400（no body），其余型号 minimal 与 low 无差别——
 *   这家网关不认识 minimal，不冒这个险（包括目录没给 efforts 清单的情况）
 * - efforts 有清单：不在清单里的档标 null，xhigh / max 落字符串（pi 只认带字符串的这两档）
 * - 没清单但思考恒开（required）：只去掉 off，其余交给 pi 默认
 * - 其余（optional、无清单）：只去掉 minimal，其余交给 pi 默认——档位深浅与能否真关，
 *   由「用户自己定义每个型号的思考档」那条线解决，这里不按型号手写名单
 */
function thinkingLevelMapOf(entry: Record<string, unknown>, reasoning: boolean): Partial<Record<ThinkingLevel, string | null>> | undefined {
  if (!reasoning) return undefined;
  const raw = Array.isArray(entry.reasoningSupportedEfforts) ? entry.reasoningSupportedEfforts : [];
  const efforts = new Set(raw.filter((v): v is ThinkingLevel => typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v)));
  if (efforts.size > 0) {
    const map: Partial<Record<ThinkingLevel, string | null>> = {};
    for (const level of THINKING_LEVELS) {
      if (efforts.has(level)) {
        if (level === "xhigh" || level === "max") map[level] = level;
      } else {
        map[level] = null;
      }
    }
    map.minimal = null;
    return map;
  }
  if (entry.reasoningMode === "required") return { off: null, minimal: null };
  return { minimal: null };
}

/**
 * 容错解析：整份响应 → 可注册的 chat 型号清单。
 * 返回 null = 整体形状不对（抛错语义交给调用方：视为拉取失败）。`dropped` 收被丢弃的
 * chat 候选（非 chat 类型的不算丢弃，那是正常过滤）。
 */
export function parseTokenrhythmCatalog(payload: unknown): { models: TokenrhythmModel[]; dropped: string[] } | null {
  if (!isRecord(payload)) return null;
  if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0" && payload.code !== "ok") return null;
  if (!Array.isArray(payload.data)) return null;
  const models: TokenrhythmModel[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of payload.data) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const label = id === "" ? "(missing id)" : id;
    if (raw.type !== undefined && raw.type !== "chat") continue;
    const status = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : "";
    const unusable = SKIP_STATUSES.has(status) || raw.effectiveAvailable === false || !openaiAvailable(raw);
    const contextWindow = positiveInt(raw.contextWindow);
    if (unusable || contextWindow === undefined || id === "") {
      dropped.push(label);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const vision = raw.supportsVision === true;
    const reasoning =
      raw.reasoningMode === "unsupported" ? false : raw.supportsReasoning === true || raw.reasoningMode === "required";
    models.push({
      id,
      name: typeof raw.name === "string" && raw.name.trim() !== "" ? raw.name.trim() : id,
      contextWindow,
      maxTokens: positiveInt(raw.maxOutputTokens) ?? 8_192,
      input: vision ? ["text", "image"] : ["text"],
      reasoning,
      ...(reasoning ? { thinkingLevelMap: thinkingLevelMapOf(raw, reasoning) } : {}),
    });
  }
  return { models, dropped };
}

/** 去掉末尾的 `-MMDD` 日期后缀（deepseek-v4.1-flash-1017 → deepseek-v4.1-flash），找不到再按原 id 找 */
function withoutDateSuffix(id: string): string {
  return /-\d{4}$/.test(id) ? id.replace(/-\d{4}$/, "") : id;
}

/** 官方美元单价：先按原 id、再按去日期后缀的 id 查 pi 目录（找不到返回零价，如实「缺官方单价」） */
export function tokenrhythmOfficialRates(
  catalog: readonly BuiltinProvider[],
  modelId: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } {
  for (const id of [modelId, withoutDateSuffix(modelId)]) {
    const rates = officialRates(catalog, id, {}, undefined);
    if (rates !== null) return rates;
  }
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** 注册条目的形状（pi registerProvider 第二参的 models 元素，从 PiProviderRegistration 推不出的字段按字面写） */
type RegisteredModel = NonNullable<Parameters<ModelRuntime["registerProvider"]>[1]["models"]>[number];

/** 型号清单 + 官方单价 → pi 的 provider 注册配置（无鉴权：目录条目只供参数与清单，key 由用户实例注册时合并进来） */
export function tokenrhythmRegistration(
  models: readonly TokenrhythmModel[],
  catalog: readonly BuiltinProvider[],
): { name: string; baseUrl: string; api: "openai-completions"; models: RegisteredModel[] } {
  return {
    name: "基元律动",
    baseUrl: TOKENRHYTHM_BASE_URL,
    // 目录里所有 chat 型号都在 OpenAI 协议端点上；型号条目不带自己的 api / baseUrl——
    // 继承服务商层（用户实例选哪种接入方式、哪个地址，型号就跟哪条路，同一条地址两种协议）
    api: "openai-completions",
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      ...(model.thinkingLevelMap === undefined ? {} : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
      input: [...model.input],
      cost: tokenrhythmOfficialRates(catalog, model.id),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
  };
}

/**
 * 把一份目录响应注册进运行时（解析 + 官方单价 + registerProvider）。
 * 返回注册进去的型号数；形状不对或一条不剩时返回 0、什么都不注册。幂等：重复注册 merge。
 */
export function applyTokenrhythmCatalog(runtime: ModelRuntime, payload: unknown): number {
  const parsed = parseTokenrhythmCatalog(payload);
  if (parsed === null || parsed.models.length === 0) return 0;
  // 官方单价从 pi 目录查：排除我们自己（重复 apply 时不自引用），也排除用户实例的合并条目
  const catalog = runtime
    .getProviders()
    .filter((provider) => provider.id !== TOKENRHYTHM_CATALOG_ID)
    .map(toBuiltinProvider);
  runtime.registerProvider(TOKENRHYTHM_CATALOG_ID, tokenrhythmRegistration(parsed.models, catalog));
  return parsed.models.length;
}

// ── 缓存：上次成功的原始响应，原子写 ─────────────────────────────────────────────

interface CacheFile {
  fetchedAt: string;
  payload: unknown;
}

/**
 * 缓存路径：挨着 pi 目录缓存（主进程经 CATALOG_CACHE_ENV 告知的那个文件）放。
 * 环境变量缺席（单测、裸跑）= 不落盘。
 */
export function tokenrhythmCachePath(): string | undefined {
  const store = process.env[CATALOG_CACHE_ENV];
  if (store === undefined || store === "") return undefined;
  return join(dirname(store), "tokenrhythm-catalog.json");
}

/** 读缓存里的原始响应；文件不在 / 读坏 / 形状不对 → undefined（当没有缓存） */
export function loadTokenrhythmCache(path: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(parsed) && "payload" in parsed) return parsed.payload;
    // 防御：早期格式或手改过的文件直接是原始响应——也认
    return parsed;
  } catch {
    return undefined;
  }
}

/** 建运行时时把缓存里的目录灌进去（createModelRuntime 调；没缓存就什么都不做） */
export function applyTokenrhythmFromCache(runtime: ModelRuntime): number {
  const path = tokenrhythmCachePath();
  if (path === undefined) return 0;
  const payload = loadTokenrhythmCache(path);
  return payload === undefined ? 0 : applyTokenrhythmCatalog(runtime, payload);
}

export interface FetchTokenrhythmInput {
  cachePath?: string;
  /** 测试注入；缺省真连基元律动 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type FetchTokenrhythmResult = { ok: true; models: number } | { ok: false; reason: string };

/**
 * 向基元律动拉一次目录，成功则原子写缓存。失败不动缓存（下一次 createModelRuntime
 * 继续用旧的），也不抛——调用方（后台刷新循环）只记日志。
 */
export async function fetchTokenrhythmCatalog(input: FetchTokenrhythmInput = {}): Promise<FetchTokenrhythmResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  let payload: unknown;
  try {
    const response = await doFetch(TOKENRHYTHM_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const text = await response.text();
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `${TOKENRHYTHM_MODELS_URL} 拉取失败：${reason}` };
  } finally {
    clearTimeout(timer);
  }
  const parsed = parseTokenrhythmCatalog(payload);
  if (parsed === null) return { ok: false, reason: `${TOKENRHYTHM_MODELS_URL} 的响应形状变了（data / code），不落缓存` };
  if (parsed.models.length === 0) return { ok: false, reason: `${TOKENRHYTHM_MODELS_URL} 一条可用的 chat 型号都没有，不落缓存` };
  if (input.cachePath !== undefined) {
    const file: CacheFile = { fetchedAt: new Date().toISOString(), payload };
    await writeJsonAtomic(input.cachePath, file);
  }
  return { ok: true, models: parsed.models.length };
}
