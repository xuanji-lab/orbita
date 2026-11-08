/**
 * 远程 MCP 的 OAuth 凭据存储：每台 server 一条（client 信息 + token + 登录时的 MCP 地址 + 撤销端点），
 * 整条 JSON 经 SecretsPort 加密落盘（生产里是 SafeStorageSecrets：macOS 钥匙串 / Windows DPAPI，
 * 文件是 `<config>/mcp-oauth.secrets.json`——自己的文件，不与模型服务商的 secrets.json 互相覆盖）。
 *
 * **不写进 mcp.json**：mcp.json 可以贴给别人看，token 不能跟着走。整条加密而不是只加密 token——
 * client_secret（若授权服务器发了）与 token 同等敏感，拆开存只会多一处忘了加密的地方。
 * 读到解不开 / 形状不对的密文当「没有」（换机器、换系统账户后要重新登录，不让整个目录挂掉）。
 */
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { SecretsPort } from "../provider/store.ts";

export interface McpOauthCredential {
  /** 登录时的 MCP 地址：给别的地址（用户改了 mcp.json、同名的工作区配置）一律不给 token */
  serverUrl: string;
  clientInformation: OAuthClientInformationMixed;
  tokens: OAuthTokens;
  /** access token 失效的绝对时间（ms）；服务端没给 expires_in 为 null（靠 401 触发续期） */
  expiresAt: number | null;
  /** 授权服务器元数据里的撤销端点（断开时尽力调用） */
  revocationEndpoint: string | null;
  savedAt: number;
}

function account(serverName: string): string {
  return `mcp-oauth:${serverName}`;
}

function isCredential(value: unknown): value is McpOauthCredential {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const tokens = v["tokens"] as Record<string, unknown> | undefined;
  const client = v["clientInformation"] as Record<string, unknown> | undefined;
  return (
    typeof v["serverUrl"] === "string" &&
    typeof tokens === "object" &&
    tokens !== null &&
    typeof tokens["access_token"] === "string" &&
    typeof client === "object" &&
    client !== null &&
    typeof client["client_id"] === "string" &&
    (v["expiresAt"] === null || typeof v["expiresAt"] === "number")
  );
}

export class McpOauthCredentialStore {
  private readonly secrets: SecretsPort;
  /** SecretsPort 的写是「读全量 → 改一项 → 换名」，并发的两次写会丢一项——串行化 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(secrets: SecretsPort) {
    this.secrets = secrets;
  }

  async get(serverName: string): Promise<McpOauthCredential | null> {
    const raw = await this.secrets.get(account(serverName));
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCredential(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  set(serverName: string, credential: McpOauthCredential): Promise<void> {
    return this.serial(() => this.secrets.set(account(serverName), JSON.stringify(credential)));
  }

  delete(serverName: string): Promise<void> {
    return this.serial(() => this.secrets.delete(account(serverName)));
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
