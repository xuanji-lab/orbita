/**
 * provider 域的 IPC handler —— 四层契约的第 2 层。
 * 校验失败不是异常路径而是正常结果：把 issues 结构化地还给 renderer，让表单逐项标红。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels, type OauthDeviceCode, type OauthLoginInput } from "../../shared/agent-ipc.ts";
import { KNOWN_PROVIDERS } from "../../shared/known-providers.ts";
import type { OauthCredential, ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";
import { resolveProviderSecrets } from "../agent/ipc.ts";
import type { AgentHostCore } from "../agent/host-core.ts";
import { runClaudeLogin } from "./oauth.ts";
import { isPiOauthKind, modelsFromCredential, runPiOauthLogin } from "./oauth-flows.ts";
import { discoverModels, type DiscoveredModels } from "./discover.ts";
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

export function registerProviderIpc(store: ProviderStore, host?: AgentHostCore): void {
  ipcMain.handle(ipcChannels.providerList, (): Promise<ProviderDto[]> => store.list());

  ipcMain.handle(
    ipcChannels.providerUpsert,
    async (_event, input: ProviderUpsertInput): Promise<UpsertResult> => {
      try {
        const provider = await store.upsert(input);
        // 新添加的 / 改了条目的服务商：补刷它的目录，不等 4 小时循环
        host?.syncCatalogScope();
        return { ok: true, provider };
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
        return { ok: false, models: [], message: "Login expired — log in again from Settings › Providers." };
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
        return { ok: false, message: "Login expired — log in again from Settings › Providers." };
      }
      if (apiKey === null) return { ok: false, message: "Enter an API key first." };
      /**
       * 浏览器登录的订阅一律走 agent 进程探测（真会话同源客户端）：Claude 的令牌主进程裸
       * fetch 即便补齐身份头仍被 429（实测），官方 SDK 自带的遥测指纹裸 fetch 补不了；
       * ChatGPT（Codex 私有协议）/ Copilot（动态请求头、令牌里的地址）/ xAI 的请求细节都在
       * pi 的客户端里，裸探测只会测出一个和会话不相干的结果。
       * 只认「已落盘的 oauth provider + 没手填 key」：手贴令牌走兼容条目的，保持裸探测。
       */
      const stored =
        input.providerId === undefined ? undefined : (await store.list()).find((p) => p.id === input.providerId);
      if (
        host !== undefined &&
        (input.apiKey === undefined || input.apiKey === "") &&
        input.providerId !== undefined &&
        stored?.auth.scheme === "oauth"
      ) {
        const provider = await resolveProviderSecrets(store, input.providerId);
        const modelId = input.modelId.trim() !== "" ? input.modelId.trim() : provider.models[0]?.id ?? "";
        if (modelId === "") {
          return { ok: false, message: "Add a model first to test the connection." };
        }
        return host.probeProvider(provider, modelId);
      }
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

  ipcMain.handle(ipcChannels.providerRemove, async (_event, id: string): Promise<void> => {
    await store.remove(id);
    // 删掉最后一个实例的那家目录退出刷新范围
    host?.syncCatalogScope();
  });

  // 「添加」页点开一张还没保存的卡片：现拉一次这家的目录（节流内不拉），新目录走 builtins 广播
  ipcMain.handle(ipcChannels.providerRefreshCatalog, async (_event, catalogId: string): Promise<void> => {
    if (typeof catalogId !== "string" || catalogId === "") return;
    // 只认目录表里有的 id：renderer 不能借这条通道让 agent 进程去拉任意目录
    if (!KNOWN_PROVIDERS.some((known) => known.catalogId === catalogId)) return;
    await host?.peekCatalog(catalogId);
  });

  ipcMain.handle(ipcChannels.providerReorder, (_event, ids: string[]): Promise<void> =>
    store.reorder(ids),
  );

  /** 进行中的浏览器登录（按 provider id）：设置页的「取消」按 id 叫停 */
  const pendingLogins = new Map<string, AbortController>();

  /**
   * 浏览器登录订阅（Claude / ChatGPT / GitHub Copilot / xAI）。登录即保存：主进程跑完整
   * 流程，成功后 upsert provider（scheme oauth）并落盘凭据；重登录沿用盘上的模型与
   * endpoint——换令牌不该抹掉用户配好的模型。Claude 走我们手写的流程，其余三家走 pi 的
   * （oauth-flows.ts）；设备码流程（Copilot / xAI）把码推给发起登录的窗口显示。
   */
  ipcMain.handle(ipcChannels.providerOauthLogin, async (event, input: OauthLoginInput): Promise<UpsertResult> => {
    const known = KNOWN_PROVIDERS.find((item) => item.id === input.kind && item.auth === "oauth");
    if (known === undefined) {
      return { ok: false, issues: [{ field: "kind", message: `"${input.kind}" has no browser login` }] };
    }
    // 同一个 id 的上一次登录还挂着（用户又点了一次）：先叫停它，不叠两个回调服务器
    pendingLogins.get(input.id)?.abort();
    const controller = new AbortController();
    pendingLogins.set(input.id, controller);
    try {
      // 先验撞名再开浏览器：别让用户授权完回来才发现 id 被占
      const existing = (await store.list()).find((p) => p.id === input.id);
      if (input.create === true && existing !== undefined) {
        return {
          ok: false,
          issues: [{ field: "id", message: `provider "${input.id}" already exists` }],
        };
      }
      const openExternal = (url: string) => shell.openExternal(url);
      const credential: OauthCredential = isPiOauthKind(known.id)
        ? await runPiOauthLogin(known.id, {
            openExternal,
            signal: controller.signal,
            onDeviceCode: (code) => {
              const payload: OauthDeviceCode = { id: input.id, ...code };
              if (!event.sender.isDestroyed()) event.sender.send(ipcChannels.providerOauthDeviceCode, payload);
            },
          })
        : await runClaudeLogin({ openExternal, signal: controller.signal });
      // 新建且没带型号时，用登录顺手问出的账号可用型号预填（Copilot 有，其余为空）
      const declared =
        input.models !== undefined && input.models.length > 0
          ? input.models
          : modelsFromCredential(credential).map((id) => ({ id }));
      const saved = await store.upsert({
        provider: {
          id: input.id,
          kind: known.id,
          displayName: input.displayName,
          endpoint: existing?.endpoint ?? {
            baseUrl: known.baseUrl,
            api: known.api,
            ...(known.headers === undefined ? {} : { headers: known.headers }),
          },
          models: existing?.models ?? { declared },
          auth: { scheme: "oauth" },
        },
        ...(input.create === true ? { create: true } : {}),
      });
      await store.saveOauthCredential(input.id, credential);
      host?.syncCatalogScope();
      const fresh = (await store.list()).find((p) => p.id === input.id);
      return { ok: true, provider: fresh ?? saved };
    } catch (error) {
      if (error instanceof ProviderValidationError) return { ok: false, issues: error.issues };
      throw error;
    } finally {
      if (pendingLogins.get(input.id) === controller) pendingLogins.delete(input.id);
    }
  });

  ipcMain.handle(ipcChannels.providerOauthCancel, (_event, id: string): void => {
    pendingLogins.get(id)?.abort();
  });
}
