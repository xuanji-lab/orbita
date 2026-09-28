/**
 * 给导入的会话分配模型 —— 契约与纯函数 —— IPC 四层的第 1 层。
 *
 * 背景：导入与模型解耦（2026-09-28 裁决，见 session.ts 的 UNASSIGNED_PROVIDER_ID）——
 * 导入的会话不替源模型挑渠道，provider 落占位、原模型名记在 importedModel / modelId。
 * 但用户的正常流程是「导入聊天记录，配置模型，开始体验」：真正发生分配的地方在
 * **配置模型的界面**（wafo 2026-09-28：用户没有导入的聊天记录，配置完多个 provider
 * 什么提示都不该有；有导入的记录，配置完就提示可以一键按原模型名配上——是服务商页里
 * 一个单独的功能按钮，不是每配一个 provider 提示一下）。
 *
 * 匹配只按模型名（先精确、再归一化书写差），**没有兜底**：对不上的保持占位，
 * 打开会话时用户自己选。多个服务商都有同名模型取列表第一个（providers.json 的
 * 顺序就是用户排的顺序），预览里注明。用户已经手动选过模型的会话（provider 已是
 * 真实值）绝不动。
 */
import {
  UNASSIGNED_MODEL_ID,
  UNASSIGNED_PROVIDER_ID,
  type SessionMeta,
} from "./session.ts";

/** 归一化 model id 供匹配：小写 + 只留字母数字（glm-5.3 ↔ GLM_5.3 这类书写差）。 */
export function normalizeModelId(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 一个 provider 下的一个模型（匹配的候选全集由调用方装配）。 */
export interface RegisteredModel {
  providerId: string;
  modelId: string;
}

/** 按原模型名匹配的结果；ambiguous = 有多个服务商都声明了能对上的模型。 */
export interface ModelMatch {
  providerId: string;
  modelId: string;
  /** true = 多个服务商都有同名（或同形）模型，取了列表里的第一个 */
  ambiguous: boolean;
}

/**
 * 按原模型名在已注册模型里匹配。**先精确后归一化**——精确命中不动，书写差
 * （大小写 / 分隔符）才走归一化；两条规则下取到的都是 providers.json 顺序里的
 * 第一个。对不上返回 null——没有兜底，渠道选择不替用户做。
 */
export function matchModelByName(original: string, registered: readonly RegisteredModel[]): ModelMatch | null {
  const exact = registered.filter((m) => m.modelId === original);
  const pickFrom = (list: readonly RegisteredModel[]): ModelMatch | null => {
    const first = list[0];
    if (first === undefined) return null;
    return {
      providerId: first.providerId,
      modelId: first.modelId,
      ambiguous: new Set(list.map((m) => m.providerId)).size > 1,
    };
  };
  const exactMatch = pickFrom(exact);
  if (exactMatch !== null) return exactMatch;
  const normalized = normalizeModelId(original);
  if (normalized === "") return null;
  return pickFrom(registered.filter((m) => normalizeModelId(m.modelId) === normalized));
}

/** 一条导入会话的「原模型名」：importedModel 优先，缺席看 modelId；占位值 / 空不算。 */
export function originalModelOf(meta: SessionMeta): string | null {
  const name = meta.importedModel ?? meta.modelId;
  return name === "" || name === UNASSIGNED_MODEL_ID ? null : name;
}

/** 还没分配模型的导入会话：provider 仍是占位。 */
export function isUnassignedSession(meta: SessionMeta): boolean {
  return meta.providerId === UNASSIGNED_PROVIDER_ID;
}

/**
 * `model-assign:groups` 的返回：还挂着占位的会话按原模型名分组。
 * `total` 是占位会话总数（含原模型名不可知的——提示行说「N 个还没有模型」用它）；
 * `groups` 只列原模型名可用的（不可知的没法按名字配，不进组、也不进预览），
 * 按会话数降序、同名次按模型名字典序——预览行的顺序就是它。
 */
export interface ModelAssignGroups {
  total: number;
  groups: { model: string; sessions: number }[];
}

/** 分组统计（纯函数）。 */
export function groupUnassignedModels(metas: readonly SessionMeta[]): ModelAssignGroups {
  const byModel = new Map<string, number>();
  let total = 0;
  for (const meta of metas) {
    if (!isUnassignedSession(meta)) continue;
    total += 1;
    const original = originalModelOf(meta);
    if (original === null) continue;
    byModel.set(original, (byModel.get(original) ?? 0) + 1);
  }
  const groups = [...byModel.entries()]
    .map(([model, sessions]) => ({ model, sessions }))
    .sort((a, b) => b.sessions - a.sessions || a.model.localeCompare(b.model));
  return { total, groups };
}

/** `model-assign:run` 的一条：原模型名 → 目标 provider / 模型。 */
export interface ModelAssignEntry {
  model: string;
  providerId: string;
  modelId: string;
}

/** 执行结果：assigned = 实际改写的会话数；skipped = 确认前已被用户改过的。 */
export interface ModelAssignRunResult {
  assigned: number;
  skipped: number;
}

/**
 * `model-assign:run` 在目标失效时抛的稳定错误码（附原模型名）。主进程不猜界面
 * 语言，renderer 按码翻文案（同 IMPORT_GREETING_UNAVAILABLE_CODE 的纪律）。
 */
export const MODEL_ASSIGN_TARGET_GONE_CODE = "MODEL_ASSIGN_TARGET_GONE:";

/**
 * 执行前校验：清单里哪条目标已不在注册表里（provider 或模型被删）。返回 null =
 * 全部活着。整批拒绝而不是跳过那一条——半截结果会让人以为全配上了。
 */
export function findDeadTarget(
  entries: readonly ModelAssignEntry[],
  registered: readonly RegisteredModel[],
): ModelAssignEntry | null {
  const alive = new Set(registered.map((m) => `${m.providerId}\u0000${m.modelId}`));
  return entries.find((entry) => !alive.has(`${entry.providerId}\u0000${entry.modelId}`)) ?? null;
}

/**
 * 把清单套到当前会话上：只有仍是占位、且原模型名在清单里的会话才进计划
 * （不在清单里的、原模型名不可知的、用户已手选过的都不动）。写入制是
 * 「再核一次占位」（store.assignModel），这里的简选只负责不浪费写。
 */
export function planAssignments(
  metas: readonly SessionMeta[],
  entries: readonly ModelAssignEntry[],
): { id: string; providerId: string; modelId: string }[] {
  const targets = new Map(entries.map((entry) => [entry.model, entry]));
  const out: { id: string; providerId: string; modelId: string }[] = [];
  for (const meta of metas) {
    if (!isUnassignedSession(meta)) continue;
    const original = originalModelOf(meta);
    const target = original === null ? undefined : targets.get(original);
    if (target === undefined) continue;
    out.push({ id: meta.id, providerId: target.providerId, modelId: target.modelId });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * renderer 传来的是 unknown。**坏形状整体拒绝（抛错）**：这是一次会落盘的批量
 * 改写，改写用户意图比报错更糟（同 parseImportRunInput 的纪律）。
 */
export function parseModelAssignEntries(raw: unknown): ModelAssignEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("model assign entries must be a non-empty array");
  const out: ModelAssignEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) throw new Error("model assign entry must be an object");
    const model = item["model"];
    const providerId = item["providerId"];
    const modelId = item["modelId"];
    if (typeof model !== "string" || model === "") throw new Error("bad model name in model assign entry");
    if (typeof providerId !== "string" || providerId === "") throw new Error("bad providerId in model assign entry");
    if (typeof modelId !== "string" || modelId === "") throw new Error("bad modelId in model assign entry");
    if (seen.has(model)) continue;
    seen.add(model);
    out.push({ model, providerId, modelId });
  }
  return out;
}
