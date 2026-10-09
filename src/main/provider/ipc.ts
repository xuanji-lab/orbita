/**
 * provider 域的 IPC handler —— 四层契约的第 2 层。
 * 校验失败不是异常路径而是正常结果：把 issues 结构化地还给 renderer，让表单逐项标红。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels, type OauthLoginInput } from "../../shared/agent-ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";
import { discoverModels, type DiscoveredModels } from "./discover.ts";
import { runClaudeLogin } from "./oauth.ts";
import { testConnection, type ConnectionTestResult } from "./test-connection.ts";
import { ProviderStore, ProviderValidationError } from "./store.ts";

export type UpsertResult =
  | { ok: true; provider: ProviderDto }
  | { ok: false; issues: ValidationIssue[] };

/** 密钥来源：表单里刚输入的优先，否则取已存的（api_key 或 OAuth 访问令牌——后者会自动续期，
 *  续期失败会抛错：调用方把它转成「请重新登录」而不是当成没有密钥） */
async function resolveKey(
  store: ProviderStore,
  typed: string | undefined,
  providerId: string | undefined,
): Promise<string | null> {
  if (typed !== undefined && typed !== "") return typed;
  if (providerId === undefined) return null;
  const oauth = await store.resolveOauthApiKey(providerId);
  if (oauth !== null) return oauth;
  return store.resolveApiKey(providerId);
}

export function registerProviderIpc(store: ProviderStore): void {
  ipcMain.handle(ipcChannels.providerList, (): Promise<ProviderDto[]> => store.list());

  ipcMain.handle(
    ipcChannels.providerUpsert,
    async (_event, input: ProviderUpsertInput): Promise<UpsertResult> => {
      try {
        return { ok: true, provider: await store.upsert(input) };
      } catch (error) {
        if (error instanceof ProviderValidationError) return { ok: false, issues: error.issues };
        throw error;
      }
    },
  );

  // 从供应商获取模型：密钥可以是表单里刚输入的（还没保存），也可以取已存的
  ipcMain.handle(
    ipcChannels.providerDiscover,
    async (
      _event,
      input: { baseUrl: string; api: string; apiKey?: string; providerId?: string; headers?: Record<string, string> },
    ): Promise<DiscoveredModels> => {
      let apiKey: string | null;
      try {
        apiKey = await resolveKey(store, input.apiKey, input.providerId);
      } catch (cause) {
        console.error("[provider] OAuth 续期失败", cause);
        return { ok: false, models: [], message: "Claude login expired — log in again from Settings › Providers." };
      }
      if (apiKey === null) {
        return { ok: false, models: [], message: "Enter an API key first." };
      }
      return discoverModels({
        baseUrl: input.baseUrl,
        api: input.api,
        apiKey,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      });
    },
  );

  // 测试连接：用表单当前值，不必先保存
  ipcMain.handle(
    ipcChannels.providerTest,
    async (
      _event,
      input: {
        api: string;
        baseUrl: string;
        modelId: string;
        apiKey?: string;
        providerId?: string;
        headers?: Record<string, string>;
      },
    ): Promise<ConnectionTestResult> => {
      let apiKey: string | null;
      try {
        apiKey = await resolveKey(store, input.apiKey, input.providerId);
      } catch (cause) {
        console.error("[provider] OAuth 续期失败", cause);
        return { ok: false, message: "Claude login expired — log in again from Settings › Providers." };
      }
      if (apiKey === null) return { ok: false, message: "Enter an API key first." };
      return testConnection({
        ...input,
        apiKey,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      });
    },
  );

  /**
   * 显示明文密钥。**这是「密钥不过 IPC」边界上唯一的一个显式开口**——
   * 只在用户点眼睛时取一次，不随 list 下发。用户明确要求要能核对自己粘的 key 对不对。
   */
  ipcMain.handle(ipcChannels.providerReveal, (_event, id: string): Promise<string | null> =>
    store.resolveApiKey(id),
  );

  ipcMain.handle(ipcChannels.providerRemove, (_event, id: string): Promise<void> =>
    store.remove(id),
  );

  ipcMain.handle(ipcChannels.providerReorder, (_event, ids: string[]): Promise<void> =>
    store.reorder(ids),
  );

  /**
   * Claude OAuth 登录。登录即保存：主进程跑完整流程（回调服务器 + 系统浏览器 +
   * 换令牌），成功后 upsert provider（scheme oauth）并落盘凭据；重登录沿用
   * 盘上的模型与 endpoint——换令牌不该抹掉用户配好的模型。
   */
  ipcMain.handle(ipcChannels.providerOauthLogin, async (_event, input: OauthLoginInput): Promise<UpsertResult> => {
    try {
      // 先验撞名再开浏览器：别让用户授权完回来才发现 id 被占
      const existing = (await store.list()).find((p) => p.id === input.id);
      if (input.create === true && existing !== undefined) {
        return {
          ok: false,
          issues: [{ field: "id", message: `provider "${input.id}" already exists` }],
        };
      }
      const credential = await runClaudeLogin({
        openExternal: (url) => shell.openExternal(url),
      });
      const saved = await store.upsert({
        provider: {
          id: input.id,
          // 目前唯一的 OAuth 流就是 Claude 订阅；新流加入时这里按入参分流
          kind: "claude",
          displayName: input.displayName,
          endpoint:
            existing?.endpoint ?? { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
          models: existing?.models ?? { declared: input.models ?? [] },
          auth: { scheme: "oauth" },
        },
        ...(input.create === true ? { create: true } : {}),
      });
      await store.saveOauthCredential(input.id, credential);
      const fresh = (await store.list()).find((p) => p.id === input.id);
      return { ok: true, provider: fresh ?? saved };
    } catch (error) {
      if (error instanceof ProviderValidationError) return { ok: false, issues: error.issues };
      throw error;
    }
  });
}
