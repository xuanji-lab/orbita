/**
 * pi 的 ModelRuntime 在 Orbita 里怎么建，以及内建目录怎么跟着 pi.dev 上新。
 *
 * **为什么要自己给选项**：`ModelRuntime.create({})` 的默认值全指向 pi CLI 的 `~/.pi/agent`——
 * 读那里的 models.json（用户给 pi CLI 配的自定义 provider 会混进来）、auth.json（pi CLI 的
 * 登录凭据会被当成这里的凭据），目录缓存也写那里。那是另一个应用的配置。Orbita 的 provider 与
 * 密钥由主进程管、每次经内存注册交给 pi（model-registration.ts），所以这里一律：
 * - `modelsPath: null`：不读任何 models.json；
 * - `credentials`：空的内存凭据库，鉴权只来自注册时给的 apiKey；
 * - `modelsStore`：目录覆盖层缓存落 Orbita 自己的数据目录（主进程经 CATALOG_CACHE_ENV 告知路径）。
 *
 * **为什么要占位凭据**：pi 的目录刷新以「这家有凭据」为闸门（pi-ai Models.refresh →
 * resolveRefreshCredential：解不出凭据就不联网）——它只给用户在 pi 里配置过的服务商刷新。
 * Orbita 的密钥不进 pi 的凭据库，pi 眼里一家都没配，闸门永远不开。所以刷新专用的那个 runtime
 * 给要刷新的目录各放一枚占位凭据，只为开闸：pi.dev 的目录请求不带凭据（remote-catalog-provider：
 * 只发 accept、User-Agent 与 If-None-Match），占位值不会发给任何人。这个 runtime 只用来刷新，
 * 用完即弃，绝不拿它发模型请求。
 *
 * 刷新哪些：预置服务商（known-providers.ts）用到的那几份目录——设置页给用户看的、会话借参数的
 * 都是它们。每家的节流（4 小时内不重复下载、过期用 ETag 复验）是 pi 自己做的。
 * pi 升级后，比内建快照旧的缓存会被它自动忽略（remoteModels 按 lastModified 比），不用我们清。
 */
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type ModelsStore,
  type ModelsStoreEntry,
  type ModelsStoreOperationOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "../main/atomic-write.ts";
import { CATALOG_CACHE_ENV } from "../shared/agent-ipc.ts";
import { KNOWN_PROVIDERS } from "../shared/known-providers.ts";
import { applyTokenrhythmFromCache, TOKENRHYTHM_CATALOG_ID } from "./tokenrhythm-catalog.ts";

/** 刷新间隔。与 pi 的单家节流同为 4 小时（REMOTE_CATALOG_REFRESH_INTERVAL_MS，未导出） */
export const CATALOG_REFRESH_EVERY_MS = 4 * 60 * 60 * 1000;

/**
 * 占位凭据的值：只用来打开 pi 的刷新闸门，见文件头。写成一句话而不是像密钥的串——
 * 万一哪天出现在日志里，一眼看得出它是什么。
 */
const CATALOG_GATE_KEY = "orbita-catalog-refresh-placeholder";

/** 预置服务商用到的 pi 目录 id（去重，保持表内顺序）。基元律动的 catalogId 不是 pi.dev 的条目——它的目录从它自己的接口刷新（tokenrhythm-catalog.ts），不向 pi.dev 要 */
export function catalogIdsToRefresh(): string[] {
  const ids = KNOWN_PROVIDERS.flatMap((provider) =>
    provider.catalogId === undefined || provider.catalogId === TOKENRHYTHM_CATALOG_ID
      ? []
      : [provider.catalogId],
  );
  return [...new Set(ids)];
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

/**
 * Orbita 里建 ModelRuntime 的唯一入口：不读 ~/.pi/agent，目录读 Orbita 自己的缓存，不联网。
 * 会话、起名、探测、列目录都走它——「能不能用某个模型」只该有一套真相。
 * 建好顺手把基元律动的目录缓存灌进去（tokenrhythm-catalog.ts）：它不在 pi.dev 目录里，
 * 但设置页与会话注册都把它当一条普通目录条目用。
 */
export async function createModelRuntime(store: ModelsStore = catalogStore()): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create({ modelsPath: null, modelsStore: store, credentials: new InMemoryCredentialStore() });
  applyTokenrhythmFromCache(runtime);
  return runtime;
}

export interface RefreshCatalogsInput {
  store?: ModelsStore;
  ids?: readonly string[];
  /** 测试用：把 pi.dev 换成本地假服务 */
  catalogBaseUrl?: string;
  /** 不论 4 小时节流，立刻下载（测试用；pi 的 force） */
  force?: boolean;
  signal?: AbortSignal;
}

/**
 * 向 pi.dev 拉一次目录覆盖层，落进缓存。返回每家的失败原因（没失败的不在里面）；
 * 失败只意味着这家继续用旧缓存或内建快照，不影响任何会话。
 */
export async function refreshCatalogs(input: RefreshCatalogsInput = {}): Promise<ReadonlyMap<string, Error>> {
  const ids = input.ids ?? catalogIdsToRefresh();
  const credentials = new InMemoryCredentialStore();
  for (const id of ids) {
    await credentials.modify(id, async () => ({ type: "api_key", key: CATALOG_GATE_KEY }));
  }
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    modelsStore: input.store ?? catalogStore(),
    credentials,
    refreshOnCreate: false,
    ...(input.catalogBaseUrl === undefined ? {} : { catalogBaseUrl: input.catalogBaseUrl }),
  });
  const result = await runtime.refresh({
    providers: [...ids],
    allowNetwork: true,
    ...(input.force === true ? { force: true } : {}),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return result.errors;
}
