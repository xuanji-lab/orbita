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
import { KNOWN_PROVIDERS, knownProviderOf } from "../../shared/known-providers.ts";
import { refreshOauthCredential } from "./oauth-flows.ts";
import {
  maskSecret,
  normalizeBaseUrl,
  validateProvider,
  type OauthCredential,
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

/**
 * 续期端口：默认按目录条目分派（Claude 直连 Anthropic token 端点，ChatGPT / Copilot / xAI
 * 交给 pi 的流程，见 oauth-flows.ts）；测试注入假网络。`kind` 是目录条目 id。
 */
export interface OauthDeps {
  refreshOauth?: (credential: OauthCredential, kind: string) => Promise<OauthCredential>;
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
  private readonly oauthDeps: OauthDeps;
  private readonly filePath: string;
  private cache: Provider[] | null = null;
  /** 进行中的 OAuth 续期（按密钥库 account 合并并发）：上游轮换 refresh token，
   * 两路并发各拿旧的去换会把后到的一路变成 invalid_grant（sub2api #1035 的事故） */
  private readonly oauthInflight = new Map<string, Promise<OauthCredential>>();

  // 注：不用 TS 参数属性（constructor(private x: T)）——Node 的类型剥离不支持它，
  // 测试直接加载 .ts 时会 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。见 AGENTS.md「必须遵守」。
  constructor(dir: string, secrets: SecretsPort, oauthDeps: OauthDeps = {}) {
    this.dir = dir;
    this.secrets = secrets;
    this.oauthDeps = oauthDeps;
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
    if (input.create === true && existing !== undefined) {
      throw new ProviderValidationError([{ field: "id", message: `provider "${draft.id}" already exists` }]);
    }

    // 来自哪个目录条目：只收认得的条目 id；编辑时没带就沿用盘上的（老 renderer / 只改模型的写回）
    const kind = draft.kind ?? existing?.kind;
    const normalized: Provider = {
      id: draft.id,
      ...(kind !== undefined && KNOWN_PROVIDERS.some((item) => item.id === kind) ? { kind } : {}),
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
    } else if (draft.auth.scheme === "oauth") {
      // 凭据本体不在这里写（登录流程成功后由 saveOauthCredential 落盘）；
      // 这里只建立引用。凭据落盘前它处于「已登记但未登录」的中间态，dto 里 loggedIn=false
      const account =
        existing?.auth.scheme === "oauth"
          ? existing.auth.secretRef.account
          : `${draft.id}-oauth-${randomBytes(6).toString("hex")}`;
      normalized.auth = { scheme: "oauth", secretRef: { kind: "keychain", account } };
    } else if (draft.auth.scheme === "env") {
      const envKeys = existing?.auth.scheme === "env" ? existing.auth.envKeys : [];
      normalized.auth = { scheme: "env", envKeys };
    }

    // 换 scheme 时顺手清掉不再被引用的密钥（api_key 与 oauth 各自的密文都算）
    if (existing?.auth.scheme === "api_key" && normalized.auth.scheme !== "api_key") {
      await this.secrets.delete(existing.auth.secretRef.account);
    }
    if (existing?.auth.scheme === "oauth" && normalized.auth.scheme !== "oauth") {
      await this.secrets.delete(existing.auth.secretRef.account);
    }

    const next = existing
      ? providers.map((p) => (p.id === draft.id ? normalized : p))
      : [...providers, normalized];
    await this.persist(next);
    return this.toDto(normalized);
  }

  /** 删除 provider，连带删掉它的密钥 / OAuth 凭据（不留孤儿密文）。 */
  async remove(id: ProviderId): Promise<void> {
    const providers = await this.load();
    const target = providers.find((p) => p.id === id);
    if (!target) return;
    if (target.auth.scheme === "api_key" || target.auth.scheme === "oauth") {
      await this.secrets.delete(target.auth.secretRef.account);
    }
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

  /** 登录成功后落盘 OAuth 凭据（JSON 整体加密进密钥库）。 */
  async saveOauthCredential(id: ProviderId, credential: OauthCredential): Promise<void> {
    const provider = (await this.load()).find((p) => p.id === id);
    if (!provider || provider.auth.scheme !== "oauth") {
      throw new Error(`provider "${id}" is not an oauth provider`);
    }
    await this.secrets.set(provider.auth.secretRef.account, JSON.stringify(credential));
  }

  /** 读已存的 OAuth 凭据；密文解不开 / 字段不齐都当没有（让用户重登录，不拉挂列表）。 */
  async readOauthCredential(id: ProviderId): Promise<OauthCredential | null> {
    const provider = (await this.load()).find((p) => p.id === id);
    if (!provider || provider.auth.scheme !== "oauth") return null;
    return this.readCredentialBy(provider.auth.secretRef.account);
  }

  /**
   * 取 OAuth 访问令牌（**只给主进程内的装配代码用**，不经 IPC 暴露）。
   * 剩余寿命够就直接返回；快到点就续期并把新的一对写回密钥库（上游会轮换
   * refresh token，旧的那次续期后即作废）。续期失败抛错——调用方把它变成
   * 「请重新登录」，不能静默拿旧 token 硬发一轮。
   */
  async resolveOauthApiKey(id: ProviderId): Promise<string | null> {
    return (await this.resolveOauthCredential(id))?.accessToken ?? null;
  }

  /**
   * 同 resolveOauthApiKey，但交回整份（续期过的）凭据：Copilot 的请求地址写在令牌里、
   * 由流程的 toAuth 解出来，装配会话要的不只是令牌本身（见 agent/ipc 的 resolveProviderSecrets）。
   */
  async resolveOauthCredential(id: ProviderId): Promise<OauthCredential | null> {
    const provider = (await this.load()).find((p) => p.id === id);
    if (!provider || provider.auth.scheme !== "oauth") return null;
    const account = provider.auth.secretRef.account;
    const credential = await this.readCredentialBy(account);
    if (credential === null) return null;
    if (credential.expiresAt > Date.now()) return credential;
    // 同一 account 的并发续期合并成一次（检查与登记之间无 await，不会漏登记）
    const inflight = this.oauthInflight.get(account);
    if (inflight !== undefined) return inflight;
    const refresh = this.oauthDeps.refreshOauth ?? ((stale, kind) => refreshOauthCredential(kind, stale));
    // 哪家的流程按目录条目认（第二个实例 openai-codex-2 也走 Codex 的续期）
    const kind = knownProviderOf(provider).id;
    const task = (async () => {
      const fresh = await refresh(credential, kind);
      await this.secrets.set(account, JSON.stringify(fresh));
      return fresh;
    })().finally(() => {
      this.oauthInflight.delete(account);
    });
    this.oauthInflight.set(account, task);
    return task;
  }

  private async toDto(provider: Provider): Promise<ProviderDto> {
    if (provider.auth.scheme === "oauth") {
      const credential = await this.readCredentialBy(provider.auth.secretRef.account);
      return {
        ...provider,
        auth: {
          scheme: "oauth",
          loggedIn: credential !== null,
          account: credential?.accountEmail ?? null,
        },
      };
    }
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

  /** 按密钥库 account 读凭据；损坏的密文当没有（换机器后 safeStorage 解不开的场景） */
  private async readCredentialBy(account: string): Promise<OauthCredential | null> {
    const raw = await this.secrets.get(account);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<OauthCredential>;
      if (
        typeof parsed.accessToken !== "string" ||
        typeof parsed.refreshToken !== "string" ||
        typeof parsed.expiresAt !== "number"
      ) {
        return null;
      }
      const flowData = parsed.flowData;
      return {
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        expiresAt: parsed.expiresAt,
        accountEmail: typeof parsed.accountEmail === "string" ? parsed.accountEmail : null,
        ...(typeof flowData === "object" && flowData !== null && !Array.isArray(flowData) ? { flowData } : {}),
      };
    } catch {
      return null;
    }
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
