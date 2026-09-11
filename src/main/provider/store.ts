/**
 * ProviderStore —— Provider 的唯一持有者（提案 §2.2「main 独占」）。
 * renderer 永远拿不到明文密钥：对外只出 ProviderDto，密钥进 SecretsPort。
 *
 * 落盘走原子写（临时文件 + rename，AGENTS.md「必须遵守」）：providers.json 是
 * 启动必读的关键元数据，半截文件会让应用起不来。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound } from "../fs-errors.ts";
import {
  maskSecret,
  normalizeBaseUrl,
  validateProvider,
  type Provider,
  type ProviderDto,
  type ProviderId,
  type ProviderUpsertInput,
  type ValidationIssue,
} from "../../shared/provider.ts";

/**
 * 密钥端口。Electron 实现走 safeStorage（macOS 钥匙串 / Windows DPAPI），
 * 测试注入内存实现——store 因此不依赖 Electron，可被 node --test 直接加载。
 */
export interface SecretsPort {
  set(account: string, plaintext: string): Promise<void>;
  get(account: string): Promise<string | null>;
  delete(account: string): Promise<void>;
}

export class ProviderValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super(`provider validation failed: ${issues.map((i) => i.field || "(root)").join(", ")}`);
    this.name = "ProviderValidationError";
    this.issues = issues;
  }
}

/** providers.json 的落盘形状。version 供将来迁移判定用。 */
interface ProvidersFile {
  version: 1;
  providers: Provider[];
}

export class ProviderStore {
  private readonly dir: string;
  private readonly secrets: SecretsPort;
  private readonly filePath: string;
  private cache: Provider[] | null = null;

  // 注：不用 TS 参数属性（constructor(private x: T)）——Node 的类型剥离不支持它，
  // 测试直接加载 .ts 时会 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。见 AGENTS.md「必须遵守」。
  constructor(dir: string, secrets: SecretsPort) {
    this.dir = dir;
    this.secrets = secrets;
    this.filePath = join(dir, "providers.json");
  }

  /** 读全量。文件缺失视为空列表（首次启动）；文件损坏则抛错，不静默清空用户配置。 */
  async load(): Promise<Provider[]> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        this.cache = [];
        return this.cache;
      }
      throw error;
    }
    const parsed = JSON.parse(raw) as ProvidersFile;
    const list = Array.isArray(parsed.providers) ? parsed.providers : [];
    this.cache = list;
    return list;
  }

  async list(): Promise<ProviderDto[]> {
    const providers = await this.load();
    return Promise.all(providers.map((p) => this.toDto(p)));
  }

  /**
   * 新建或改写。校验不过则抛 ProviderValidationError 且**不落盘**。
   * apiKey 有值时写入密钥库并生成 SecretRef；无值时保留原有密钥（编辑其它字段不该清空密钥）。
   */
  async upsert(input: ProviderUpsertInput): Promise<ProviderDto> {
    const draft = input.provider;
    const issues = validateProvider(draft);
    if (issues.length > 0) throw new ProviderValidationError(issues);

    const providers = await this.load();
    const existing = providers.find((p) => p.id === draft.id);

    const normalized: Provider = {
      id: draft.id,
      displayName: draft.displayName.trim(),
      endpoint: {
        ...draft.endpoint,
        baseUrl: normalizeBaseUrl(draft.endpoint.baseUrl),
      },
      models: { declared: draft.models.declared },
      auth: { scheme: "none" },
    };

    if (draft.auth.scheme === "api_key") {
      const account =
        existing?.auth.scheme === "api_key"
          ? existing.auth.secretRef.account
          : `${draft.id}-${randomBytes(6).toString("hex")}`;
      if (input.apiKey !== undefined && input.apiKey !== "") {
        await this.secrets.set(account, input.apiKey);
      } else if (existing?.auth.scheme !== "api_key") {
        throw new ProviderValidationError([{ field: "apiKey", message: "API key is required" }]);
      }
      normalized.auth = { scheme: "api_key", secretRef: { kind: "keychain", account } };
    } else if (draft.auth.scheme === "env") {
      const envKeys = existing?.auth.scheme === "env" ? existing.auth.envKeys : [];
      normalized.auth = { scheme: "env", envKeys };
    }

    // 旧的 api_key 换成了别的 scheme —— 顺手清掉不再被引用的密钥
    if (existing?.auth.scheme === "api_key" && normalized.auth.scheme !== "api_key") {
      await this.secrets.delete(existing.auth.secretRef.account);
    }

    const next = existing
      ? providers.map((p) => (p.id === draft.id ? normalized : p))
      : [...providers, normalized];
    await this.persist(next);
    return this.toDto(normalized);
  }

  /** 删除 provider，连带删掉它的密钥（不留孤儿密钥）。 */
  async remove(id: ProviderId): Promise<void> {
    const providers = await this.load();
    const target = providers.find((p) => p.id === id);
    if (!target) return;
    if (target.auth.scheme === "api_key") await this.secrets.delete(target.auth.secretRef.account);
    await this.persist(providers.filter((p) => p.id !== id));
  }

  /**
   * 按给定 id 顺序重排（拖拽排序的落盘）。sort 稳定，所以清单里漏掉的 id 保序垫底、
   * 多余的 id 忽略——renderer 传旧快照也不会丢数据。顺序没变就不写盘。
   */
  async reorder(ids: ProviderId[]): Promise<void> {
    const providers = await this.load();
    const rank = new Map(ids.map((id, i) => [id, i]));
    const next = [...providers].sort(
      (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
    );
    if (next.every((p, i) => p === providers[i])) return;
    await this.persist(next);
  }

  /** 取明文密钥。**只给主进程内的装配代码用**，不经 IPC 暴露。 */
  async resolveApiKey(id: ProviderId): Promise<string | null> {
    const provider = (await this.load()).find((p) => p.id === id);
    if (!provider || provider.auth.scheme !== "api_key") return null;
    return this.secrets.get(provider.auth.secretRef.account);
  }

  private async toDto(provider: Provider): Promise<ProviderDto> {
    if (provider.auth.scheme !== "api_key") {
      return { ...provider, auth: provider.auth };
    }
    const secret = await this.secrets.get(provider.auth.secretRef.account);
    return {
      ...provider,
      auth: {
        scheme: "api_key",
        hasSecret: secret !== null,
        masked: secret === null ? null : maskSecret(secret),
      },
    };
  }

  /** 原子写：写临时文件 → rename 覆盖。中途失败不会留下半截 providers.json。 */
  private async persist(providers: Provider[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const payload: ProvidersFile = { version: 1, providers };
    const tempPath = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    this.cache = providers;
  }
}
