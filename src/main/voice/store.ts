/**
 * 语音设置的落盘：`userData/voice.json` 按厂商分键（`{ doubao: {...} }`，加厂商不用迁移）
 * 外加一个跨厂商的「听写用哪家」（`dictationProvider`，不是凭证是选择，默认豆包），
 * 都原子写；密钥走 SecretsPort（系统钥匙串加密，与 provider 的 API key 同一个 secrets.json），
 * 只在主进程里解开——设置页拿到的只有掩码。
 *
 * 豆包三样：APP ID、Resource ID 明文存，Access Token 进钥匙串；阶跃一样：API Key 进钥匙串，
 * 没有明文字段。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import type { SecretsPort } from "../provider/store.ts";
import { maskSecret } from "../../shared/provider.ts";
import {
  DEFAULT_DOUBAO_RESOURCE_ID,
  type DictationProvider,
  type DictationSelection,
  type DoubaoVoiceConfig,
  type DoubaoVoiceInput,
  type StepfunVoiceConfig,
  type StepfunVoiceInput,
} from "../../shared/voice.ts";
import type { DoubaoCredentials } from "./doubao-protocol.ts";

/** secrets.json 里的账户名。provider 的账户是 `<id>-<hex>`，带冒号的撞不上 */
const DOUBAO_TOKEN_ACCOUNT = "voice:doubao-access-token";
const STEPFUN_API_KEY_ACCOUNT = "voice:stepfun-api-key";

interface DoubaoFile {
  appId: string;
  resourceId: string;
}

/**
 * voice.json 的整体：各厂商一个键 + 听写选哪家。**不认识的键原样保留**——以后加的厂商、或
 * 更新版本写进来的东西，旧代码存豆包时不能把它们冲掉
 */
type VoiceFile = Record<string, unknown> & { doubao?: unknown; dictationProvider?: unknown };

/** 听写厂商的容错读：不认识的值回豆包（默认，老用户无感） */
export function parseDictationProvider(raw: unknown): DictationProvider {
  return raw === "stepfun" ? "stepfun" : "doubao";
}

/** 容错读豆包那一段：缺字段回默认，坏值当没配过——凭证随时可以再填，不值得为此报错 */
export function parseDoubao(raw: unknown): DoubaoFile {
  const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const appId = typeof record["appId"] === "string" ? record["appId"].trim() : "";
  const resourceId = typeof record["resourceId"] === "string" ? record["resourceId"].trim() : "";
  return { appId, resourceId: resourceId === "" ? DEFAULT_DOUBAO_RESOURCE_ID : resourceId };
}

export class VoiceStore {
  private readonly filePath: string;
  private readonly secrets: SecretsPort;

  constructor(dir: string, secrets: SecretsPort) {
    this.filePath = join(dir, "voice.json");
    this.secrets = secrets;
  }

  async doubaoConfig(): Promise<DoubaoVoiceConfig> {
    const doubao = parseDoubao((await this.readFile()).doubao);
    const token = await this.secrets.get(DOUBAO_TOKEN_ACCOUNT);
    return { ...doubao, tokenMasked: token === null || token === "" ? null : maskSecret(token) };
  }

  /** 听写用的完整豆包凭证；缺一样回 null */
  async doubaoCredentials(): Promise<DoubaoCredentials | null> {
    return this.doubaoCredentialsFor(parseDoubao((await this.readFile()).doubao));
  }

  /**
   * 测试连接用：设置页草稿里的值优先，Token 没填就拿已存的——用户改了 APP ID 想先试再存，
   * 不必把 Token 再粘一遍
   */
  async doubaoCredentialsFor(input: DoubaoVoiceInput): Promise<DoubaoCredentials | null> {
    const appId = input.appId.trim();
    const resourceId = input.resourceId.trim() === "" ? DEFAULT_DOUBAO_RESOURCE_ID : input.resourceId.trim();
    const typed = input.accessToken?.trim() ?? "";
    const accessToken = typed !== "" ? typed : ((await this.secrets.get(DOUBAO_TOKEN_ACCOUNT)) ?? "");
    if (appId === "" || accessToken === "") return null;
    return { appId, accessToken, resourceId };
  }

  async saveDoubao(input: DoubaoVoiceInput): Promise<DoubaoVoiceConfig> {
    const token = input.accessToken?.trim() ?? "";
    // 先存 Token：钥匙串不可用时这里抛，配置文件还保持原样，不会只存下一半
    if (token !== "") await this.secrets.set(DOUBAO_TOKEN_ACCOUNT, token);
    const file = await this.readFile();
    await writeJsonAtomic(this.filePath, {
      ...file,
      doubao: parseDoubao({ appId: input.appId, resourceId: input.resourceId }),
    });
    return this.doubaoConfig();
  }

  // ── 听写用哪家 ──

  async dictationProvider(): Promise<DictationProvider> {
    return parseDictationProvider((await this.readFile()).dictationProvider);
  }

  async setDictationProvider(provider: DictationProvider): Promise<DictationSelection> {
    const file = await this.readFile();
    await writeJsonAtomic(this.filePath, { ...file, dictationProvider: provider });
    return this.dictationSelection();
  }

  /** 选中的那家 + 那家凭证齐不齐（useDictation 碰麦克风前查一次） */
  async dictationSelection(): Promise<DictationSelection> {
    const provider = await this.dictationProvider();
    const configured =
      provider === "stepfun" ? (await this.stepfunApiKey()) !== null : (await this.doubaoCredentials()) !== null;
    return { provider, configured };
  }

  // ── 阶跃星辰凭证 ──

  async stepfunConfig(): Promise<StepfunVoiceConfig> {
    const key = await this.secrets.get(STEPFUN_API_KEY_ACCOUNT);
    return { apiKeyMasked: key === null || key === "" ? null : maskSecret(key) };
  }

  /** 听写用的阶跃 API Key；没存回 null */
  async stepfunApiKey(): Promise<string | null> {
    const key = await this.secrets.get(STEPFUN_API_KEY_ACCOUNT);
    return key === null || key.trim() === "" ? null : key;
  }

  /** 测试连接用：草稿 key 优先，没填拿已存的（同豆包的 CredentialsFor） */
  async stepfunCredentialsFor(input: StepfunVoiceInput): Promise<string | null> {
    const draft = input.apiKey?.trim() ?? "";
    return draft !== "" ? draft : this.stepfunApiKey();
  }

  /** 阶跃没有明文字段（只有 key，进钥匙串），voice.json 不动 */
  async saveStepfun(input: StepfunVoiceInput): Promise<StepfunVoiceConfig> {
    const key = input.apiKey?.trim() ?? "";
    if (key !== "") await this.secrets.set(STEPFUN_API_KEY_ACCOUNT, key);
    return this.stepfunConfig();
  }

  private async readFile(): Promise<VoiceFile> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as VoiceFile) : {};
    } catch {
      return {};
    }
  }
}
