/**
 * 模型参数的推断层 —— **按模型 id 跨 pi 目录查**，不是按接入的那家网关查。
 *
 * 起因（wafo 2026-09-21 实测）：「Anthropic 兼容」网关下的 7 个模型全显示 128k、
 * 图片全关。根因不是目录缺数据，是查询键选窄了：目录只按 provider 的 `catalogId`
 * 查，自建网关没有 catalogId → 一无所获 → 全落兜底。而 pi 的目录里实际收录了
 * 其中 5 个，只是挂在别家名下（claude-opus-5 在 anthropic、k3 在 kimi-coding、
 * glm-5.3 在 zai）。**模型 id 是型号的身份，与从哪个网关接进来无关**——所以按 id 查。
 *
 * 代价是同名 id 在不同网关参数不同时会借错。对冲有两层：同家 / 同 api 的条目优先，
 * 且用户的手填覆盖（ModelDecl 字段）永远在最上面。借错的后果是窗口数字偏差，
 * 借不到的后果是 1M 模型按 128k 压缩（提前 8 倍触发）——后者更坏。
 *
 * 纯函数、零 electron 依赖：renderer（徽标 / 弹窗占位）与 agent（注册基线）共用同一份
 * 判定，两边不会对同一个模型说出两个上下文窗口。
 */
import type { BuiltinModel, BuiltinProvider } from "./agent-ipc.ts";
import { knownModelParams, type ModelParams } from "./known-models.ts";
import { clampThinkingLevel, type ThinkingLevel } from "./thinking.ts";

/** 模型接受的输入模态。与 pi `Model["input"]` 同形（pi 只有这两档）。 */
export type ModelInput = ("text" | "image")[];

/**
 * 目录与白名单都不认识的模型 id 的保守默认：自建网关声明的 id、目录还没收录的新模型。
 *
 * **input 默认带 image**（wafo 2026-09-21 裁决）：pi 会在发请求前把模型声明不支持的
 * 图片静默换成占位文本（pi-ai `transform-messages.js` 的 `downgradeUnsupportedImages`），
 * 用户看不到任何提示、模型根本收不到图。默认给 image 的代价是不支持图片的网关 400 一次
 * （看得见、能改），默认不给的代价是图片被悄悄剥掉（看不见）。
 *
 * 窗口 / 单价填错只影响压缩时机与用量估算，不影响能不能跑。
 */
export const FALLBACK_MODEL = {
  reasoning: false,
  input: ["text", "image"] as ModelInput,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

/**
 * 一个模型 id 的生效参数基线（**不含**用户手填的覆盖——那一层由调用方叠在这之上）。
 *
 * `source` 只回答「这组数字的主来源」，给 UI 判断要不要说「走的是兜底」：
 * - `catalog` / `catalog-family`：pi 目录命中（精确 id / Claude 家族借参）
 * - `known`：目录没有，我们自己的型号白名单（known-models.ts）有
 * - `fallback`：两边都没有，落 `FALLBACK_MODEL`
 *
 * 白名单优先于目录（它存在的意义就是赶在目录前面纠错），但**目录命中时 source 仍记
 * catalog**：调用方只关心「是不是编出来的数」，不关心是谁盖了谁。
 */
export interface ModelDefaults {
  contextWindow: number;
  maxTokens: number;
  input: ModelInput;
  /** 能不能思考：**兑底语义与 contextWindow 相反**——那边是「猜一个能用的」，这边是「不确定就不发」（发出去不支持的档位会 400） */
  reasoning: boolean;
  cost: BuiltinModel["cost"];
  source: "catalog" | "catalog-family" | "known" | "fallback";
}

/**
 * 查目录时的偏好：这家在 pi 目录里的 id，以及接入协议（同家 > 同协议 > 其余）。
 * 从服务商条目取用 known-providers 的 `catalogPreferenceOf`，不要各处自己拼。
 */
export interface CatalogPreference {
  catalogId?: string;
  api?: string;
  /** 这家的目录说了算（`KnownProvider.catalogAuthoritative`）：本家目录收录的型号不吃白名单 */
  catalogAuthoritative?: boolean;
}

/**
 * 白名单对这个（服务商，型号）给出的口径。只有一种情况不生效：服务商「目录说了算」且
 * 本家目录收录了这个 id——聚合网关收窄了型号能力，型号的通用口径在它那里不成立。
 *
 * **设置页、底栏菜单与会话注册都经过这里**：三处对同一个型号必须说同一句话。
 * 默认思考档不走这里（那是偏好不是能力，按支持集夹取即可，见 `defaultThinkingLevel`）。
 */
export function knownParamsFor(
  catalog: readonly BuiltinProvider[],
  modelId: string,
  prefer: CatalogPreference = {},
): ModelParams {
  if (prefer.catalogAuthoritative === true && prefer.catalogId !== undefined) {
    const home = catalog.find((provider) => provider.id === prefer.catalogId);
    if (home?.models.some((model) => model.id === modelId) === true) return {};
  }
  return knownModelParams(modelId);
}

/**
 * Claude 系的家族键：`claude-opus-4-6` / `claude-opus-4.6` / `claude-4-6-opus` 都归到
 * `opus-4-6`。Anthropic 的模型 id 在各网关之间写法不一，精确匹配漏掉的多是写法差异。
 *
 * `allowMajorOnly`：目录条目那一侧允许只有大版本（`claude-fable-5`），
 * 查询侧不允许——只有 fable 例外（见 `findFamilyModel`）。
 */
function claudeFamilyKey(modelRef: string, allowMajorOnly = false): string | undefined {
  const normalized = modelRef.toLowerCase();
  const familyFirst = /claude[\s._:/-]+(opus|sonnet|haiku|fable)[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?/.exec(
    normalized,
  );
  const versionFirst = /claude[\s._:/-]+(\d+)(?:[\s._:/-]+(\d+))?[\s._:/-]+(opus|sonnet|haiku)/.exec(
    normalized,
  );
  const family = familyFirst?.[1] ?? versionFirst?.[3];
  const major = familyFirst?.[2] ?? versionFirst?.[1];
  const minor = familyFirst?.[3] ?? versionFirst?.[2];
  if (family === undefined || major === undefined) return undefined;
  if (minor === undefined && family !== "fable" && !allowMajorOnly) return undefined;
  return minor === undefined ? `${family}-${major}` : `${family}-${major}-${minor}`;
}

/** 同一家目录里按家族键找。**major + minor 都要相同**——4-6 不借 4-7 的参数。 */
function findFamilyModel(models: readonly BuiltinModel[], familyKey: string): BuiltinModel | undefined {
  const exact = models.find((model) => claudeFamilyKey(model.id, true) === familyKey);
  if (exact !== undefined) return exact;
  /**
   * Fable 的小版本可以先于目录出现（`claude-fable-5-1` 上线时目录只有 `claude-fable-5`），
   * 只有它允许降到大版本借参。其余家族坚持 major+minor 相同：opus-4-6 与 opus-4-7
   * 的窗口就可能不同，借错比借不到更难发现。
   */
  const fableMajor = /^fable-(\d+)-\d+$/.exec(familyKey);
  if (fableMajor === null) return undefined;
  return models.find((model) => claudeFamilyKey(model.id, true) === `fable-${fableMajor[1]}`);
}

/**
 * 在整个 pi 目录里找这个模型 id 的官方条目。
 *
 * 顺序：偏好的那家精确 id → 全目录精确 id（同 api 的先）→ 偏好那家的 Claude 家族
 * → 全目录 Claude 家族（同 api 的先）。同 api 优先是因为同一个 id 跨协议往往是不同
 * 套餐（`glm-5.3` 在 anthropic 兼容端与 openai 兼容端参数一致，但这不是保证）。
 */
export function lookupCatalogModel(
  catalog: readonly BuiltinProvider[],
  modelId: string,
  prefer: CatalogPreference = {},
): BuiltinModel | undefined {
  return lookupCatalogSource(catalog, modelId, prefer)?.model;
}

/**
 * 同 `lookupCatalogModel`，连同条目所在的那一家一起返回。会话注册借档位表时要从**同一家**
 * 的原始条目抄：同一个 id 在不同网关上档位不同（deepseek-v4-flash 在 deepseek 目录能关
 * 思考、在 Anthropic 协议的网关上不能），只按 id 抄第一条，菜单与会话就各拿各的
 * （2026-10-24 一致性测试抓到）。
 */
export function lookupCatalogSource(
  catalog: readonly BuiltinProvider[],
  modelId: string,
  prefer: CatalogPreference = {},
): { provider: BuiltinProvider; model: BuiltinModel } | undefined {
  const home =
    prefer.catalogId === undefined ? undefined : catalog.find((p) => p.id === prefer.catalogId);
  const homeExact = home?.models.find((m) => m.id === modelId);
  if (home !== undefined && homeExact !== undefined) return { provider: home, model: homeExact };

  // 同 api 的厂商排前面：精确扫描与家族扫描共用这一份排序结果
  const ordered = [...catalog].sort((a, b) => {
    const rank = (p: BuiltinProvider) => (prefer.api !== undefined && p.api === prefer.api ? 0 : 1);
    return rank(a) - rank(b);
  });
  for (const provider of ordered) {
    const hit = provider.models.find((m) => m.id === modelId);
    if (hit !== undefined) return { provider, model: hit };
  }

  const familyKey = claudeFamilyKey(modelId);
  if (familyKey === undefined) return undefined;
  const homeFamily = home === undefined ? undefined : findFamilyModel(home.models, familyKey);
  if (home !== undefined && homeFamily !== undefined) return { provider: home, model: homeFamily };
  for (const provider of ordered) {
    const hit = findFamilyModel(provider.models, familyKey);
    if (hit !== undefined) return { provider, model: hit };
  }
  return undefined;
}

/**
 * 一个模型 id 的生效参数基线：**白名单 > pi 目录 > 兜底**（用户手填在调用方那一层）。
 *
 * 白名单（known-models.ts）按型号 id 查：它记的是「这个型号的官方口径」，与从哪家
 * 网关接进来无关——「目录说了算」的服务商除外（`knownParamsFor`）。
 */
export function resolveModelDefaults(
  catalog: readonly BuiltinProvider[],
  modelId: string,
  prefer: CatalogPreference = {},
): ModelDefaults {
  const entry = lookupCatalogModel(catalog, modelId, prefer);
  const patch = knownParamsFor(catalog, modelId, prefer);
  const exact = entry !== undefined && entry.id === modelId;
  const source: ModelDefaults["source"] =
    entry !== undefined
      ? exact
        ? "catalog"
        : "catalog-family"
      : patch.contextWindow !== undefined ||
          patch.maxTokens !== undefined ||
          patch.reasoning !== undefined
        ? "known"
        : "fallback";
  return {
    contextWindow: patch.contextWindow ?? entry?.contextWindow ?? FALLBACK_MODEL.contextWindow,
    maxTokens: patch.maxTokens ?? entry?.maxTokens ?? FALLBACK_MODEL.maxTokens,
    input: [...(entry?.input ?? FALLBACK_MODEL.input)],
    reasoning: patch.reasoning ?? entry?.reasoning ?? FALLBACK_MODEL.reasoning,
    cost: { ...(entry?.cost ?? FALLBACK_MODEL.cost) },
    source,
  };
}

/** 白名单没写默认档的型号从这一档起步（与 pi 的全局 DEFAULT_THINKING_LEVEL 同值），再夹进支持集 */
export const FALLBACK_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * 一个型号的**默认思考档**：白名单 `defaultThinkingLevel`（官方口径）> medium，
 * 再按支持集夹取（`clampThinkingLevel`，与 pi 同规则：先往深、再往浅）。
 *
 * 语义（wafo 2026-09-23）：彻底重启后落回这一档；没重启就记住用户上一次手选，
 * 换到的型号不支持那一档时才回到这里。子会话按模型解析时同样用它。
 *
 * `supported` 缺席 = 支持集未知：不夹，原样交给 pi（pi 发送前按同一规则夹）——
 * 主进程派子会话时拿不到目录，走的就是这条路，结果与 renderer 算的一致。
 */
export function defaultThinkingLevel(
  modelId: string,
  supported?: readonly ThinkingLevel[] | null,
): ThinkingLevel {
  return clampThinkingLevel(
    knownModelParams(modelId).defaultThinkingLevel ?? FALLBACK_THINKING_LEVEL,
    supported,
  );
}

/**
 * 这个型号（在这家服务商上）的支持档位集，`null` = 三处都不知道。设置页、底栏思考档
 * 菜单、子会话默认档共用；会话注册（model-registration）与它是同一套口径，
 * agent 侧的一致性测试逐个型号比对两边。来源三级：
 *
 *   白名单 thinkingLevels（人工确证的口径，赶在其余两级前面纠错——例：目录查不到
 *   的快速通道模型如 glm-5.3-flash，或目录给出错误支持集的情形）。经 knownParamsFor
 *   取：「目录说了算」的服务商（OpenCode Go）在本家目录命中时不吃白名单，
 *   与会话注册（model-registration）是同一个判定
 *   > observed（开轮事件回的真值，含 clamp 事实；调用方传 session.thinkingSupported）
 *   > 目录（BuiltinModel.supportedThinkingLevels，agent 进程在 pi 旁算好过线），
 *   按 lookupCatalogModel 的顺序找条目：本家 > 同协议 > 其余 > Claude 家族——与会话借参
 *   的来源是同一条。以前取整个目录里第一个同 id 的条目，谁排前面算谁
 *
 * 三者都没有 = 未知：调用方按「全量显示、不禁用」处理，不替 pi 撒谎——开轮后
 * 由 thinking 事件纠真。
 *
 * `prefer` 从服务商条目取（known-providers 的 catalogPreferenceOf）。缺席 = 不知道是哪家，
 * 按型号的通用口径答。
 */
export function modelThinkingLevels(
  modelId: string,
  catalog: readonly BuiltinProvider[],
  observed?: readonly ThinkingLevel[] | null,
  prefer: CatalogPreference = {},
): readonly ThinkingLevel[] | null {
  const known = knownParamsFor(catalog, modelId, prefer).thinkingLevels;
  if (known !== undefined) return known;
  if (observed != null) return observed;
  return lookupCatalogModel(catalog, modelId, prefer)?.supportedThinkingLevels ?? null;
}
