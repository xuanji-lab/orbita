/**
 * 模型目录：pi-ai 的 `createModels` 之上，我们自己的服务商装配与 pi.dev 目录覆盖层。
 *
 * **为什么不直接用 pi-ai 的 builtinProviders**：内建目录只是 pi 发版时的快照；新型号由 pi.dev 的
 * 目录覆盖层补（4 小时节流、ETag 复验、比快照旧的缓存不用）。pi-ai 不带这一层（它在 pi 的
 * coding-agent 包里），这里按同一个协议自己拉——只拉主进程说过的那几家（审核 F-1）。
 *
 * **服务商怎么装配**：Orbita 的服务商与密钥由主进程管、每次经内存注册交给这里
 * （model-registration.ts）。注册是「同 id 的内建服务商 + 我们的注册」叠一层：
 * - 带 `models`：型号整份替换成注册里的（目录的官方参数由 model-registration 先合并好再交来）；
 * - 不带：沿用内建型号，地址换成注册的；
 * - 密钥是**字面值**：按注册给的原样发，不当环境变量名、不当命令；`headers` 同理，加在鉴权头上；
 * - 再次注册同一家：没给的字段沿用上一次（kernel 进程长寿，先注 auth 面、再补 models 两步走）；
 * - 发请求：型号的协议内建服务商有实现就走内建的（保住各家的特殊处理），否则按协议取 pi-ai 的通用实现。
 * 其余（鉴权解析、OpenCode 会话头、上下文规整、思考档夹取）全是 pi-ai `Models` 自己的，原样用。
 *
 * **不读 ~/.pi/agent**：不读 models.json / auth.json，凭据库是空的内存库，鉴权只来自注册时给的 apiKey；
 * 目录缓存落 Orbita 自己的数据目录（主进程经 CATALOG_CACHE_ENV 告知路径）。
 *
 * **为什么要占位凭据**：pi-ai 的 refresh 以「这家已配置」为联网闸门（Models.refresh →
 * checkProviderAuth）。刷新专用的 catalog 给要刷新的目录各放一枚占位凭据，只为开闸：pi.dev 的目录请求
 * 不带凭据（只发 accept、User-Agent 与 If-None-Match），占位值不会发给任何人。用完即弃，不拿它发模型请求。
 */
import {
  createModels,
  getModelType,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  isModelType,
  lazyStream,
  type AnyModel,
  type Api,
  type ApiKeyAuth,
  type Model,
  type Models,
  type ModelsStore,
  type ModelsStoreEntry,
  type ModelsStoreOperationOptions,
  type MutableModels,
  type Provider,
  type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { formatUserAgent } from "@earendil-works/pi-ai/utils/identity";
import { builtinProviders, getBuiltinModelDataGeneratedAt } from "@earendil-works/pi-ai/providers/all";
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "../main/atomic-write.ts";
import { CATALOG_CACHE_ENV } from "../shared/agent-ipc.ts";
import { applyTokenrhythmFromCache, TOKENRHYTHM_CATALOG_ID, type FetchTokenrhythmResult } from "./tokenrhythm-catalog.ts";

/** 刷新间隔，也是单家目录的节流窗口：4 小时内查过就不再下载 */
export const CATALOG_REFRESH_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * 占位凭据的值：只用来打开 pi 的刷新闸门，见文件头。写成一句话而不是像密钥的串——
 * 万一哪天出现在日志里，一眼看得出它是什么。
 */
const CATALOG_GATE_KEY = "orbita-catalog-refresh-placeholder";

/** 给定目录 id 里该向 pi.dev 要的那些（去重，保持顺序）。基元律动的 catalogId 不是 pi.dev 的条目——它的目录从它自己的接口刷新（tokenrhythm-catalog.ts），不向 pi.dev 要 */
export function piCatalogIds(catalogIds: readonly string[]): string[] {
  return [...new Set(catalogIds.filter((id) => id !== TOKENRHYTHM_CATALOG_ID))];
}

function isEntry(value: unknown): value is ModelsStoreEntry {
  return typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models);
}

/**
 * 目录覆盖层缓存：一个 JSON 文件，按 pi 目录 id 分条。整份读进内存，改了就原子写回。
 * 写入排队执行、每次序列化执行那一刻的全量——两家目录同时刷新完也不会互相覆盖掉对方。
 * 读坏了（半截、手改坏）就当空缓存：最坏是多下载一次目录。
 */
export class JsonFileModelsStore implements ModelsStore {
  private readonly path: string;
  private data: Record<string, ModelsStoreEntry> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  private load(): Record<string, ModelsStoreEntry> {
    if (this.data !== undefined) return this.data;
    const data: Record<string, ModelsStoreEntry> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        for (const [id, entry] of Object.entries(parsed)) if (isEntry(entry)) data[id] = entry;
      }
    } catch {
      // 文件不在或读坏：空缓存
    }
    this.data = data;
    return data;
  }

  private flush(): Promise<void> {
    this.writing = this.writing.catch(() => undefined).then(() => writeJsonAtomic(this.path, this.load()));
    return this.writing;
  }

  async read(providerId: string, options?: ModelsStoreOperationOptions): Promise<ModelsStoreEntry | undefined> {
    options?.signal?.throwIfAborted();
    const entry = this.load()[providerId];
    return entry === undefined ? undefined : structuredClone(entry);
  }

  async write(providerId: string, entry: ModelsStoreEntry, options?: ModelsStoreOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    this.load()[providerId] = structuredClone(entry);
    await this.flush();
  }

  async delete(providerId: string, options?: ModelsStoreOperationOptions): Promise<void> {
    options?.signal?.throwIfAborted();
    delete this.load()[providerId];
    await this.flush();
  }
}

/** 一个进程一份：每次建 runtime 都要读它，不能每次都重新解析文件 */
let sharedStore: ModelsStore | undefined;

/** 主进程给了路径就落盘，没给（单测、裸跑）就只在内存里——不退回 ~/.pi/agent */
export function catalogStore(): ModelsStore {
  const path = process.env[CATALOG_CACHE_ENV];
  sharedStore ??= path === undefined || path === "" ? new InMemoryModelsStore() : new JsonFileModelsStore(path);
  return sharedStore;
}

// ── pi.dev 目录覆盖层 ─────────────────────────────────────────────────────────────

const CATALOG_BASE_URL = "https://pi.dev";
/** 单次请求的超时；超时与 408/425/429/5xx 立刻重试，最多 3 次（与 pi 的目录拉取同一口径） */
const CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
const CATALOG_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
/** 能消费的型号类型：随 `?types=` 发出，服务端回全类型分片 */
const CATALOG_MODEL_TYPES = ["chat", "image", "classifier"];

/** 内建快照的生成时间：比它旧的 pi.dev 目录不用（pi 升级后旧缓存自动作废） */
const BUILTIN_GENERATED_AT = getBuiltinModelDataGeneratedAt();

async function requestCatalog(providerId: string, baseUrl: string, signal: AbortSignal, etag?: string): Promise<Response> {
  const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, baseUrl);
  url.searchParams.set("types", CATALOG_MODEL_TYPES.join(","));
  // pi.dev 按 User-Agent 里的 pi 版本分发目录（版本不认识会 307 到 404）。版本取 pi-ai 编译进去的常量，
  // 打进 bundle 也不会错认成 Orbita 的版本号
  const headers: Record<string, string> = { accept: "application/json", "User-Agent": formatUserAgent() };
  if (etag !== undefined) headers["if-none-match"] = etag;
  for (let attempt = 1; ; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.any([signal, AbortSignal.timeout(CATALOG_ATTEMPT_TIMEOUT_MS)]) });
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= CATALOG_ATTEMPTS) return response;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      if (signal.aborted || attempt >= CATALOG_ATTEMPTS) throw error;
    }
  }
}

/** 响应体 → 这家的型号（数组 / `{models}` / 以 id 为键的对象三种写法都认）；类型不认识的丢掉 */
function parseCatalog(providerId: string, value: unknown): AnyModel[] {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "object" && value !== null && "models" in value && Array.isArray(value.models)
      ? value.models
      : typeof value === "object" && value !== null
        ? Object.values(value)
        : undefined;
  if (entries === undefined) throw new Error(`Invalid model catalog for provider "${providerId}"`);
  return entries
    .filter((entry): entry is { id: unknown; type?: unknown } => typeof entry === "object" && entry !== null && "id" in entry)
    .filter((entry) => entry.type === undefined || (typeof entry.type === "string" && CATALOG_MODEL_TYPES.includes(entry.type)))
    .map((entry) => ({ ...entry, provider: providerId }) as AnyModel);
}

async function readCatalog(providerId: string, response: Response): Promise<Required<Pick<ModelsStoreEntry, "models" | "lastModified">> & { etag?: string }> {
  const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
  const etag = response.headers.get("etag") ?? undefined;
  return {
    models: parseCatalog(providerId, await response.json()),
    lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
    ...(etag === undefined ? {} : { etag }),
  };
}

function isNewer(lastModified: number | undefined): boolean {
  return BUILTIN_GENERATED_AT === undefined || (lastModified !== undefined && lastModified > BUILTIN_GENERATED_AT);
}

/** 同类型同 id 后者覆盖前者 */
function mergeModels(baseline: readonly AnyModel[], overlay: readonly AnyModel[]): AnyModel[] {
  const merged = new Map<string, AnyModel>();
  for (const model of [...baseline, ...overlay]) merged.set(`${getModelType(model)}\0${model.id}`, model);
  return [...merged.values()];
}

function allModelsOf(provider: Provider | undefined): readonly AnyModel[] {
  return provider === undefined ? [] : (provider.getAllModels?.() ?? provider.getModels());
}

/**
 * 内建服务商 + pi.dev 覆盖层。缓存比内建快照新才用；4 小时内查过不再下载（force 除外），
 * 过期且有缓存体时带 ETag 复验；404 / 501 记「这家没有在线目录」；其余失败保留旧缓存并报错。
 */
function withPiDevCatalog(provider: Provider, baseUrl: string): Provider {
  let overlay: AnyModel[] = [];
  const fromEntry = (entry: Readonly<ModelsStoreEntry> | undefined) =>
    entry !== undefined && isNewer(entry.lastModified) ? entry.models.filter((model) => model.provider === provider.id) : [];
  return {
    ...provider,
    getModels: () => mergeModels(provider.getModels(), overlay.filter((model) => isModelType(model, "chat"))).filter((model): model is Model<Api> => isModelType(model, "chat")),
    getAllModels: () => mergeModels(allModelsOf(provider), overlay),
    // pi.dev 的目录不看这家的登录状态
    refreshModelsAuth: "configured",
    refreshModels: async (context: RefreshModelsContext) => {
      const stored = context.stored;
      const restored = fromEntry(stored);
      if (!(await context.publish({ update: () => void (overlay = restored) }))) return;
      if (!context.allowNetwork || context.signal.aborted) return;
      // 4 小时内查过就不下载。没有 lastModified 的条目（首次失败留下的）总是重拉：它不会被采用，等就是一直空着
      if (
        context.force !== true &&
        stored?.checkedAt !== undefined &&
        stored.lastModified !== undefined &&
        Date.now() - stored.checkedAt < CATALOG_REFRESH_EVERY_MS
      ) {
        return;
      }
      // 只有手上有缓存体时才复验，304 才不会把覆盖层留空
      const validator = stored !== undefined && stored.models.length > 0 ? stored.etag : undefined;
      const response = await requestCatalog(provider.id, baseUrl, context.signal, validator);
      if (context.signal.aborted) return;
      const checkedAt = Date.now();
      if (response.status === 304 && stored !== undefined) {
        await context.publish({ persist: { ...stored, checkedAt } });
        return;
      }
      if (response.status === 404 || response.status === 501) {
        await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt, lastModified: 0, etag: undefined } });
        return;
      }
      if (!response.ok) {
        // 临时失败：缓存体与 ETag 仍有效，只挪检查时间
        await context.publish({ persist: { ...(stored ?? { models: [] }), checkedAt } });
        throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
      }
      const entry = { ...(await readCatalog(provider.id, response)), checkedAt };
      if (context.signal.aborted) return;
      const published = fromEntry(entry);
      await context.publish({ persist: entry, update: () => void (overlay = published) });
    },
  };
}

/**
 * OpenRouter 的缓存是另一种形状（沿用 pi 的个性化目录）：存的是「内建 + 更新的 pi.dev 目录」合并后的整份清单，
 * 有就整份顶替内建；每次联网都重下、不节流不复验。pi 原本还拿用户的密钥按 /models/user 收窄成这把 key 能用的
 * 型号——我们的刷新只有占位凭据（OpenRouter 必回 401、清单原样），这一步不做。
 */
function withOpenRouterCatalog(provider: Provider, baseUrl: string): Provider {
  let saved: AnyModel[] = [];
  const all = () => (saved.length > 0 ? saved : allModelsOf(provider));
  return {
    ...provider,
    getModels: () => all().filter((model): model is Model<Api> => isModelType(model, "chat")),
    getAllModels: all,
    refreshModels: async (context: RefreshModelsContext) => {
      const restored = (context.stored?.models ?? []).filter((model) => model.provider === provider.id);
      if (!(await context.publish({ update: () => void (saved = restored) }))) return;
      if (!context.allowNetwork || context.signal.aborted) return;
      const response = await requestCatalog(provider.id, baseUrl, context.signal);
      if (context.signal.aborted) return;
      let remote: AnyModel[] = [];
      if (response.status !== 404 && response.status !== 501) {
        if (!response.ok) throw new Error(`Model catalog request failed for ${provider.id}: ${response.status}`);
        const catalog = await readCatalog(provider.id, response);
        if (isNewer(catalog.lastModified)) remote = [...catalog.models];
      }
      const merged = mergeModels(allModelsOf(provider), remote);
      await context.publish({ persist: { models: merged, checkedAt: Date.now() }, update: () => void (saved = merged) });
    },
  };
}

function catalogProviders(baseUrl: string): Provider[] {
  return builtinProviders().map((provider) => {
    // radius 是自托管网关，没有 pi.dev 目录（pi 同样不给它挂覆盖层）
    if (provider.id === "radius") return provider;
    return provider.id === "openrouter" ? withOpenRouterCatalog(provider, baseUrl) : withPiDevCatalog(provider, baseUrl);
  });
}

// ── 我们的注册叠在内建服务商上 ─────────────────────────────────────────────────────────

/** 注册里的一条型号：协议、地址、所属可省（省了取注册的 / 内建的） */
export type ModelDefinition = Omit<Model<Api>, "api" | "provider" | "baseUrl"> & { api?: Api; provider?: string; baseUrl?: string };

/** registerProvider 的第二参：Orbita 真传的就这几样（model-registration 的 toAuthConfig / toFallbackRegistration、基元律动） */
export interface ProviderRegistration {
  name?: string;
  /** 字面值，原样发出 */
  apiKey?: string;
  baseUrl?: string;
  api?: Api;
  /** 字面值，加在鉴权头上 */
  headers?: Record<string, string>;
  /** 给了就整份替换这家的型号 */
  models?: ModelDefinition[];
}

/** 一条型号定义 → 型号对象。协议 / 地址：型号的 ?? 注册的 ?? 内建同 id（否则同协议、否则 openai-completions、否则第一条）的 */
function modelOf(providerId: string, base: readonly AnyModel[], registration: ProviderRegistration, definition: ModelDefinition): Model<Api> {
  const chat = base.filter((model): model is Model<Api> => isModelType(model, "chat"));
  const defaults =
    chat.find((model) => model.id === definition.id) ??
    (definition.api === undefined ? undefined : chat.find((model) => model.api === definition.api)) ??
    chat.find((model) => model.api === "openai-completions") ??
    chat[0];
  const api = definition.api ?? registration.api ?? defaults?.api;
  if (api === undefined) {
    throw new Error(`Provider ${providerId}, model ${definition.id}: no "api" specified. Set it at model level or provider level.`);
  }
  const baseUrl = definition.baseUrl ?? registration.baseUrl ?? defaults?.baseUrl;
  if (baseUrl === undefined) throw new Error(`Provider ${providerId}: "baseUrl" is required when defining custom models.`);
  return { ...definition, api, provider: providerId, baseUrl };
}

function composeProvider(providerId: string, base: Provider | undefined, registration: ProviderRegistration): Provider {
  const allModels = (): AnyModel[] => {
    const baseModels = allModelsOf(base);
    if (registration.models === undefined) {
      const baseUrl = registration.baseUrl;
      return baseUrl === undefined ? [...baseModels] : baseModels.map((model) => ({ ...model, baseUrl }));
    }
    return registration.models.map((definition) => modelOf(providerId, baseModels, registration, definition));
  };
  // 当场校验：注册坏了在 registerProvider 里就抛，不等到发请求
  allModels();
  const inherited = base?.auth.apiKey;
  const key = registration.apiKey;
  const oauth = base?.auth.oauth;
  // 只有 OAuth 的内建服务商、注册又没给密钥：不凭空造一个密钥鉴权
  const apiKey: ApiKeyAuth | undefined =
    inherited === undefined && key === undefined && oauth !== undefined
      ? undefined
      : {
          name: inherited?.name ?? "API key",
          ...(inherited?.login === undefined ? {} : { login: inherited.login }),
          check: async (input) => {
            if (key !== undefined) return { type: "api_key", source: "configured API key" };
            if (inherited?.check !== undefined) return inherited.check(input);
            const resolved = await inherited?.resolve(input);
            return resolved === undefined ? undefined : { type: "api_key", source: resolved.source };
          },
          resolve: async (input) => {
            // 内建服务商的解析照走（个别家要据密钥补地址 / 头），只是密钥换成注册给的
            const result =
              key === undefined
                ? await inherited?.resolve(input)
                : inherited !== undefined
                  ? await inherited.resolve({ ...input, credential: { type: "api_key", key } })
                  : { auth: { apiKey: key }, source: "configured API key" };
            if (result === undefined) return undefined;
            const headers = registration.headers;
            return headers === undefined ? result : { ...result, auth: { ...result.auth, headers: { ...result.auth.headers, ...headers } } };
          },
        };
  if (apiKey === undefined && oauth === undefined) throw new Error(`Provider ${providerId}: no authentication method configured.`);
  const baseSpeaks = (model: Model<Api>) => base?.getModels().some((entry) => entry.api === model.api) ?? false;
  const streamWith = (model: Model<Api>, simple: boolean, run: (target: Pick<Provider, "stream" | "streamSimple">) => ReturnType<Provider["stream"]>, signal: AbortSignal | undefined) =>
    lazyStream(
      model,
      async () => {
        if (base !== undefined && baseSpeaks(model)) return run(base);
        const api = getApiProvider(model.api);
        if (api === undefined) throw new Error(`No API provider registered for api: ${model.api}`);
        return run(api);
      },
      undefined,
      signal,
    );
  const baseUrl = registration.baseUrl ?? base?.baseUrl;
  return {
    id: providerId,
    name: registration.name ?? base?.name ?? providerId,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(base?.headers === undefined ? {} : { headers: base.headers }),
    auth: { ...(apiKey === undefined ? {} : { apiKey }), ...(oauth === undefined ? {} : { oauth }) },
    getModels: () => allModels().filter((model): model is Model<Api> => isModelType(model, "chat")),
    getAllModels: allModels,
    // 覆盖层的状态在内建服务商的闭包里：重新注册不丢、刷新照旧由它做
    ...(base?.refreshModelsAuth === undefined ? {} : { refreshModelsAuth: base.refreshModelsAuth }),
    ...(base?.refreshModels === undefined ? {} : { refreshModels: (context: RefreshModelsContext) => base.refreshModels?.(context) ?? Promise.resolve() }),
    ...(base?.filterModels === undefined ? {} : { filterModels: base.filterModels.bind(base) }),
    ...(base?.filterAllModels === undefined ? {} : { filterAllModels: base.filterAllModels.bind(base) }),
    ...(base?.fetchDeferred === undefined ? {} : { fetchDeferred: base.fetchDeferred.bind(base) }),
    ...(base?.cancelDeferred === undefined ? {} : { cancelDeferred: base.cancelDeferred.bind(base) }),
    ...(base?.generateImages === undefined ? {} : { generateImages: base.generateImages.bind(base) }),
    ...(base?.classify === undefined ? {} : { classify: base.classify.bind(base) }),
    stream: (model, context, options) => streamWith(model, false, (target) => target.stream(model, context, options), options?.signal),
    streamSimple: (model, context, options) => streamWith(model, true, (target) => target.streamSimple(model, context, options), options?.signal),
  };
}

/**
 * Orbita 的模型目录：pi-ai 的 Models（`models`，交给新内核与发请求）+ 注册 / 查询服务商。
 * 会话、起名、探测、列目录都用它——「能不能用某个模型」只该有一套真相。
 */
export class ModelCatalog {
  readonly models: MutableModels;
  private readonly builtins: ReadonlyMap<string, Provider>;
  private readonly registrations = new Map<string, ProviderRegistration>();

  constructor(models: MutableModels, builtins: readonly Provider[]) {
    this.models = models;
    this.builtins = new Map(builtins.map((provider) => [provider.id, provider]));
    for (const provider of builtins) models.setProvider(provider);
  }

  /** 注册 / 重注册一家。没给的字段沿用上一次注册的（undefined 不算给了） */
  registerProvider(providerId: string, registration: ProviderRegistration): void {
    const effective: ProviderRegistration = { ...this.registrations.get(providerId) };
    for (const [field, value] of Object.entries(registration)) {
      if (value !== undefined) Object.assign(effective, { [field]: value });
    }
    // 先装配（坏注册当场抛，不动已存的），再存
    const provider = composeProvider(providerId, this.builtins.get(providerId), effective);
    this.registrations.set(providerId, effective);
    this.models.setProvider(provider);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models.getModel(providerId, modelId);
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    return this.models.getModels(providerId);
  }

  getProviders(): readonly Provider[] {
    return this.models.getProviders();
  }
}

function newCatalog(store: ModelsStore, credentials: InMemoryCredentialStore, catalogBaseUrl = CATALOG_BASE_URL): ModelCatalog {
  return new ModelCatalog(createModels({ credentials, modelsStore: store }), catalogProviders(catalogBaseUrl));
}

/**
 * Orbita 里建模型目录的唯一入口：不读 ~/.pi/agent，目录读 Orbita 自己的缓存，不联网。
 * 建好顺手把基元律动的目录缓存灌进去（tokenrhythm-catalog.ts）：它不在 pi.dev 目录里，
 * 但设置页与会话注册都把它当一条普通目录条目用。
 */
export async function createModelRuntime(store: ModelsStore = catalogStore()): Promise<ModelCatalog> {
  const catalog = newCatalog(store, new InMemoryCredentialStore());
  await catalog.models.refresh({ allowNetwork: false });
  applyTokenrhythmFromCache(catalog);
  return catalog;
}

/** 交给新内核的 Models（durable 只认 pi-ai 的接口） */
export function modelsOf(catalog: ModelCatalog): Models {
  return catalog.models;
}

export interface RefreshCatalogsInput {
  store?: ModelsStore;
  /** 要刷的 pi 目录 id——没有缺省：刷哪几家必须由调用方（已添加的服务商）说清楚 */
  ids: readonly string[];
  /** 测试用：把 pi.dev 换成本地假服务 */
  catalogBaseUrl?: string;
  /** 不论 4 小时节流，立刻下载（测试用） */
  force?: boolean;
  signal?: AbortSignal;
}

/**
 * 向 pi.dev 拉一次目录覆盖层，落进缓存。返回每家的失败原因（没失败的不在里面）；
 * 失败只意味着这家继续用旧缓存或内建快照，不影响任何会话。
 */
export async function refreshCatalogs(input: RefreshCatalogsInput): Promise<ReadonlyMap<string, Error>> {
  const ids = piCatalogIds(input.ids);
  if (ids.length === 0) return new Map();
  const credentials = new InMemoryCredentialStore();
  for (const id of ids) {
    await credentials.modify(id, async () => ({ type: "api_key", key: CATALOG_GATE_KEY }));
  }
  const catalog = newCatalog(input.store ?? catalogStore(), credentials, input.catalogBaseUrl);
  const result = await catalog.models.refresh({
    providers: [...ids],
    allowNetwork: true,
    ...(input.force === true ? { force: true } : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return result.errors;
}

export interface CatalogRefresherDeps {
  /** 向 pi.dev 刷这几家（refreshCatalogs）；返回每家的失败原因 */
  refreshPi: (ids: string[]) => Promise<ReadonlyMap<string, Error>>;
  /** 向基元律动刷它自家的目录（fetchTokenrhythmCatalog，带节流） */
  refreshTokenrhythm: () => Promise<FetchTokenrhythmResult>;
  /** 有刷新动作之后重报一次目录（runtime 的 listBuiltins） */
  relist: () => Promise<void>;
  warn: (message: string) => void;
}

/**
 * 目录联网刷新的调度（审核 F-1）：**只刷主进程说过的目录**。
 * - `added` 记下已添加服务商的目录全量，作为 4 小时循环（tick）的范围，并当场刷一次；
 * - `peek` 只刷给出的那几份，不改范围；
 * - 没收到过 `added` 时 tick 什么都不做——agent 进程刚起、主进程还没告知时不联网。
 * 刷新排队串行：启动时的 added 与用户点开卡片的 peek 撞在一起，不会对同一份目录并发下载两次
 * （排在后面的那次落到节流里）。每份目录的节流各归各：pi.dev 的由 pi 做，基元律动的看缓存 fetchedAt。
 */
export class CatalogRefresher {
  private readonly deps: CatalogRefresherDeps;
  private added: string[] | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: CatalogRefresherDeps) {
    this.deps = deps;
  }

  /** refreshCatalogs 命令的入口 */
  request(scope: "added" | "peek", catalogIds: readonly string[]): Promise<void> {
    if (scope === "added") this.added = [...new Set(catalogIds)];
    return this.enqueue([...catalogIds]);
  }

  /** 4 小时循环的一拍：按最近一次 added 的范围刷 */
  tick(): Promise<void> {
    return this.added === null ? Promise.resolve() : this.enqueue(this.added);
  }

  private enqueue(catalogIds: string[]): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(() => this.runOnce(catalogIds));
    return this.queue;
  }

  private async runOnce(catalogIds: readonly string[]): Promise<void> {
    const pi = piCatalogIds(catalogIds);
    const tokenrhythm = catalogIds.includes(TOKENRHYTHM_CATALOG_ID);
    if (pi.length === 0 && !tokenrhythm) return;
    // pi 不告诉我们这一趟是真下载了还是落在节流里，跑了就重报；基元律动只在真拉到新目录时才算
    let changed = pi.length > 0;
    if (pi.length > 0) {
      const errors = await this.deps.refreshPi(pi);
      for (const [id, error] of errors) this.deps.warn(`[catalog] ${id} 的目录没刷新成功，继续用旧的：${error.message}`);
    }
    if (tokenrhythm) {
      const result = await this.deps.refreshTokenrhythm();
      if (result.status === "fetched") changed = true;
      if (result.status === "failed") this.deps.warn(`[catalog] 基元律动目录没刷新成功，继续用旧的：${result.reason}`);
    }
    if (changed) await this.deps.relist();
  }
}
