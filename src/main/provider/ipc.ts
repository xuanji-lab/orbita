/**
 * provider 域的 IPC handler —— 四层契约的第 2 层。
 * 校验失败不是异常路径而是正常结果：把 issues 结构化地还给 renderer，让表单逐项标红。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels, type OauthDeviceCode, type OauthLoginInput } from "../../shared/agent-ipc.ts";
import { KNOWN_PROVIDERS, knownProviderOf, knownProviderQuota, knownQuotaSourceOf } from "../../shared/known-providers.ts";
import {
  isProviderEnabled,
  type OauthCredential,
  type ProviderDto,
  type ProviderSetDisabledInput,
  type ProviderUpsertInput,
  type ValidationIssue,
} from "../../shared/provider.ts";
import { quotaIsStale, type QuotaFailure, type QuotaQuery, type QuotaResult } from "../../shared/quota.ts";
import { resolveProviderSecrets } from "../agent/ipc.ts";
import type { AgentHostCore } from "../agent/host-core.ts";
import { runClaudeLogin } from "./oauth.ts";
import { isPiOauthKind, modelsFromCredential, runPiOauthLogin } from "./oauth-flows.ts";
import { discoverModels, type DiscoveredModels } from "./discover.ts";
import { testConnection, type ConnectionTestResult } from "./test-connection.ts";
import { ProviderStore, ProviderValidationError } from "./store.ts";
import { QuotaCache } from "./quota-cache.ts";
import { probeQuota } from "./quota.ts";

export type UpsertResult =
  | { ok: true; provider: ProviderDto }
  | { ok: false; issues: ValidationIssue[] };

/**
 * 额度的刷新节奏（decisions 12）：成功后 60s 内复用，失败后退 15s。
 * **绝不做后台定时轮询**——只有界面打开时才问。节流状态放模块级 Map：
 * 它描述的是「这个 provider 最近一次被打是什么时候」，与窗口实例无关。
 */
const QUOTA_OK_REUSE_MS = 60_000;
const QUOTA_FAIL_BACKOFF_MS = 15_000;

/** 最近一次探测的结果：成功只要时间，失败多记一个原因（退避期间直接回它） */
type QuotaProbeState = { at: number } & ({ failed: false } | { failed: true; reason: QuotaFailure });

const quotaProbeState = new Map<string, QuotaProbeState>();

/**
 * 失效代数：每失效一次 +1。探测是异步的，出发时记下代数、回来时对号——对不上说明期间
 * 换过钥匙 / 地址，那份结果是按旧配置查出来的，不能落进缓存与节流状态（见 provider:quota）。
 */
const quotaEpoch = new Map<string, number>();

/**
 * 在途的作废（按 providerId）。作废是「先同步加代数，再异步删盘上的缓存」：加完代数、删盘还没落定的
 * 那一刻进来的查询，代数已经是新的，却会读到还没删掉的旧快照。所以查询进来先等它删完盘再去读缓存。
 */
const quotaForgetting = new Map<string, Promise<void>>();

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
  return (await store.resolveApiKey(providerId)) ?? (await store.resolveEnvKey(providerId));
}

/**
 * 这次保存动没动到「额度是按什么查出来的」：钥匙、接口地址、条目种类、鉴权方式。
 * 动了一样，旧快照就不再是这家的事实，得作废。只改显示名、型号清单、自定义请求头的不算，缓存留着。
 * 新建也算：老版本删服务商时不清额度缓存，同一个 id 重建会吃到上一家的额度。
 */
function quotaInputsChanged(
  before: ProviderDto | undefined,
  input: ProviderUpsertInput,
  after: ProviderDto,
): boolean {
  if (input.apiKey !== undefined && input.apiKey !== "") return true;
  return (
    before === undefined ||
    before.kind !== after.kind ||
    before.auth.scheme !== after.auth.scheme ||
    before.endpoint.baseUrl !== after.endpoint.baseUrl
  );
}

/**
 * `quotaCache` 由主进程传入（同一个实例还给 `failed` 事件的额度补丁用）：缓存是
 * 「上次看到的事实」，两处只能读同一份文件、同一个形状。
 */
export function registerProviderIpc(
  store: ProviderStore,
  host?: AgentHostCore,
  quotaCache?: QuotaCache,
): void {
  const quotaStore = quotaCache ?? null;

  /**
   * 让这一家的额度作废：按旧配置查到的快照、节流状态都清掉，在途的探测回来也对不上号。
   * 缓存是「按某把钥匙、某个地址查出来的事实」，钥匙 / 地址一换它就不再是这家的事实——
   * 不清的话换钥匙后 60 秒内还顶着上一家的余额，新钥匙探测失败时上一家的快照还会以
   * 「保留旧值」的名义继续显示。盘上那份删不掉只记一条：下次探测成功会整体覆盖。
   *
   * 等盘上的删除落定才返回：调用方（保存 / 删除）返回后界面紧接着就会来查额度，
   * 不等的话那一次查询可能正好读到还没删掉的旧快照。调用方还没返回就挤进来的查询，
   * 由 provider:quota 等这里登记的在途 promise（见 quotaForgetting）。
   */
  const forgetQuota = (providerId: string): Promise<void> => {
    quotaProbeState.delete(providerId);
    quotaEpoch.set(providerId, (quotaEpoch.get(providerId) ?? 0) + 1);
    if (quotaStore === null) return Promise.resolve();
    const removal = quotaStore
      .remove(providerId)
      .catch((cause: unknown) => {
        console.error("[provider] 额度缓存清除失败", providerId, cause);
      })
      .finally(() => {
        // 同一家连着作废两次时只认最后一个：它排在写入链的最后，落定即全部落定
        if (quotaForgetting.get(providerId) === removal) quotaForgetting.delete(providerId);
      });
    quotaForgetting.set(providerId, removal);
    return removal;
  };

  ipcMain.handle(ipcChannels.providerList, (): Promise<ProviderDto[]> => store.list());

  ipcMain.handle(
    ipcChannels.providerUpsert,
    async (_event, input: ProviderUpsertInput): Promise<UpsertResult> => {
      try {
        const before = (await store.list()).find((item) => item.id === input.provider.id);
        const provider = await store.upsert(input);
        // 新添加的 / 改了条目的服务商：补刷它的目录，不等 4 小时循环
        host?.syncCatalogScope();
        if (quotaInputsChanged(before, input, provider)) await forgetQuota(provider.id);
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
        // 关着的服务商也允许测试连接：用户要看它恢复了没有，再决定开不开
        const provider = await resolveProviderSecrets(store, input.providerId, { allowDisabled: true });
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
    await forgetQuota(id);
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

  /**
   * 账号额度（余额 / 套餐窗口）。
   *
   * 流程：能力声明 → 缓存 → 节流 → 探活 → 落盘。三条界线：
   *   - capability `none` 直接回 none：界面整块不渲染，不留空块；
   *   - 失败**保留上一次成功的快照**（`cached`），不覆盖成 0；
   *   - `> 24h` 的旧值当作没有——一周前的余额比「不知道」更容易误导。
   * 密钥只在主进程用一次，不进任何返回值。
   *
   * `epoch` 是出发时的失效代数：探测期间换过钥匙 / 地址，这份结果就不落缓存、不记节流。
   */
  const readQuota = async (query: QuotaQuery, epoch: number): Promise<QuotaResult> => {
    if (quotaStore === null) return { status: "none" };
    const provider = (await store.list()).find((item) => item.id === query.providerId);
    if (provider === undefined) return { status: "none" };

    // 「单独开关」关着的服务商：不查也不返回（旧缓存也不给）——关着就是不用它，
    // 界面那边已经不画额度块，这里再拦一道，免得别的调用点（环菜单、将来的入口）绕过去打探它
    if (!isProviderEnabled(provider)) return { status: "none" };
    const probe = knownProviderQuota(provider);
    if (probe === "none") return { status: "none" };

    const now = Date.now();
    const stored = (await quotaStore.read())[query.providerId] ?? null;
    const cached = stored !== null && !quotaIsStale(stored.fetchedAt, now) ? stored : null;

    const last = quotaProbeState.get(query.providerId);
    if (query.refresh !== true && last !== undefined) {
      if (!last.failed && cached !== null && now - last.at < QUOTA_OK_REUSE_MS) {
        return { status: "ok", snapshot: cached, fromCache: true };
      }
      if (last.failed && now - last.at < QUOTA_FAIL_BACKOFF_MS) {
        return { status: "error", reason: last.reason, cached };
      }
    }

    let apiKey: string | null;
    try {
      apiKey = await resolveKey(store, undefined, query.providerId);
    } catch (cause) {
      // OAuth 续期失败：与钥匙不对同类（用户要做的是重新登录 / 换钥匙）
      console.error("[provider] 额度探测：密钥解析失败", cause);
      quotaProbeState.set(query.providerId, { at: now, failed: true, reason: "auth" });
      return { status: "error", reason: "auth", cached };
    }

    const result = await probeQuota({
      probe,
      // 传**额度来源条目的 id**（general 兼容条目按 baseUrl 兜底认到的那家），探针靠它分派
      kind: knownQuotaSourceOf(provider)?.id ?? knownProviderOf(provider).id,
      baseUrl: provider.endpoint.baseUrl,
      apiKey,
    });

    // 探测期间换过钥匙 / 地址：这是按旧配置查出来的，缓存与节流状态都不落（调用方按新配置重查）
    if ((quotaEpoch.get(query.providerId) ?? 0) !== epoch) return { status: "none" };

    if (result.status === "ok") {
      quotaProbeState.set(query.providerId, { at: now, failed: false });
      try {
        await quotaStore.write(query.providerId, result.snapshot);
      } catch (cause) {
        // 落盘失败不该让「已经拿到的余额」显示不出来；下次打开会重新探
        console.error("[provider] 额度缓存写入失败", cause);
      }
      return result;
    }
    if (result.status === "error") {
      quotaProbeState.set(query.providerId, { at: now, failed: true, reason: result.reason });
      return { status: "error", reason: result.reason, cached };
    }
    return { status: "none" };
  };

  ipcMain.handle(ipcChannels.providerQuota, async (_event, query: QuotaQuery): Promise<QuotaResult> => {
    // 这一趟里换过钥匙 / 地址：刚拿到的（缓存也好、探测结果也好）是旧配置的，按新配置重查一遍。
    // 只重来一次——连着换两次不存在，不留没有底的循环
    for (let attempt = 0; ; attempt += 1) {
      // 代数与「在途的作废」在同一拍里取，然后先等作废删完盘：作废是先同步加代数、再异步删盘，
      // 挤在中间的查询若不等它，代数对得上号，读到的却还是没删掉的旧快照。
      // 先取代数再等，是为了把「等的时候又来了一次作废」也挡住——那种情况代数会对不上，外层重来
      const epoch = quotaEpoch.get(query.providerId) ?? 0;
      const forgetting = quotaForgetting.get(query.providerId);
      if (forgetting !== undefined) await forgetting;
      // 等的这会儿又作废了一次：这趟不用探了，按新代数重来（同样只重来一次）
      if (attempt < 1 && (quotaEpoch.get(query.providerId) ?? 0) !== epoch) continue;
      const result = await readQuota(query, epoch);
      if (attempt >= 1 || (quotaEpoch.get(query.providerId) ?? 0) === epoch) return result;
    }
  });

  ipcMain.handle(ipcChannels.providerReorder, (_event, ids: string[]): Promise<void> =>
    store.reorder(ids),
  );

  // 开 / 关一家服务商：入参来自 renderer，按不可信处理（形状不对直接拒，不猜）
  ipcMain.handle(
    ipcChannels.providerSetDisabled,
    async (_event, input: ProviderSetDisabledInput): Promise<ProviderDto | null> => {
      if (typeof input?.id !== "string" || typeof input.disabled !== "boolean") {
        throw new Error("provider:set-disabled needs { id: string, disabled: boolean }");
      }
      return store.setDisabled(input.id, input.disabled);
    },
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
      // 重新登录 = 换了令牌（可能是另一个账号）：按旧令牌查到的额度作废
      await forgetQuota(input.id);
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
