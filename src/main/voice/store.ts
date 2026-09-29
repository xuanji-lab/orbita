/**
 * 语音厂商凭证的落盘：`userData/voice.json` 按厂商分键（`{ doubao: {...} }`，加厂商不用迁移），
 * 原子写；密钥走 SecretsPort（系统钥匙串加密，与 provider 的 API key 同一个 secrets.json），
 * 只在主进程里解开——设置页拿到的只有掩码。
 *
 * 豆包三样：APP ID、Resource ID 明文存；Access Token 进钥匙串。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import type { SecretsPort } from "../provider/store.ts";
import { maskSecret } from "../../shared/provider.ts";
import { DEFAULT_DOUBAO_RESOURCE_ID, type DoubaoVoiceConfig, type DoubaoVoiceInput } from "../../shared/voice.ts";
import type { DoubaoCredentials } from "./doubao-asr.ts";

/** secrets.json 里的账户名。provider 的账户是 `<id>-<hex>`，带冒号的撞不上 */
const DOUBAO_TOKEN_ACCOUNT = "voice:doubao-access-token";

interface DoubaoFile {
  appId: string;
  resourceId: string;
}

/**
 * voice.json 的整体：各厂商一个键。**不认识的键原样保留**——以后加的厂商、或更新版本写进来的
 * 东西，旧代码存豆包时不能把它们冲掉
 */
type VoiceFile = Record<string, unknown> & { doubao?: unknown };

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

  private async readFile(): Promise<VoiceFile> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.filePath, "utf8"));
      return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as VoiceFile) : {};
    } catch {
      return {};
    }
  }
}
