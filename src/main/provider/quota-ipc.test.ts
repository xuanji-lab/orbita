import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ProviderDto, ProviderUpsertInput, ValidationIssue } from "../../shared/provider.ts";
import type { QuotaResult } from "../../shared/quota.ts";
import { QuotaCache } from "./quota-cache.ts";
import { ProviderStore, type SecretsPort } from "./store.ts";

/**
 * provider:upsert / provider:remove / provider:quota 三个 handler 之间的额度缓存。
 *
 * `provider/ipc.ts` 静态引 electron，node --test 里它只能是个空壳：先把 electron 换成替身
 * （只记下每个 handler），再动态 import 它。其余都是真的——真的 ProviderStore（密钥端口换成
 * 内存实现）、真的 QuotaCache（临时目录）、真的探针（只把 fetch 换掉，不出网；钥匙全是假的）。
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>();
mock.module("electron", {
  namedExports: {
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => void handlers.set(channel, handler),
    },
    // ipc.ts 的依赖链在加载时要见到这几个名字；这里的用例用不到它们的行为
    shell: {},
    app: {},
    utilityProcess: {},
  },
});
const { registerProviderIpc } = await import("./ipc.ts");

type UpsertResult = { ok: true; provider: ProviderDto } | { ok: false; issues: ValidationIssue[] };

/** 内存密钥端口（与 store.test.ts 同款）：store 不依赖 Electron，这里就能跑真文件系统的用例 */
class MemorySecrets implements SecretsPort {
  readonly values = new Map<string, string>();
  async set(account: string, plaintext: string): Promise<void> {
    this.values.set(account, plaintext);
  }
  async get(account: string): Promise<string | null> {
    return this.values.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.values.delete(account);
  }
}

const KEY_A = "sk-review-key-AAAA";
const KEY_B = "sk-review-key-BBBB";

let dir = "";
let cache: QuotaCache;
/** 每次探测：带的是哪把钥匙、打的哪台主机（按先后） */
let probed: Array<{ key: string; host: string }> = [];
/** 这次探测该怎么回：按钥匙区分账号 */
let respond: (key: string) => Response | Promise<Response> = () => unauthorized();
/** 每发出一次探测的回调（在途用例靠它知道「已经发出去了」） */
let onProbe: (key: string) => void = () => undefined;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-quota-ipc-"));
  cache = new QuotaCache(dir);
  registerProviderIpc(new ProviderStore(dir, new MemorySecrets()), undefined, cache);
  probed = [];
  respond = () => unauthorized();
  onProbe = () => undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = (headers.Authorization ?? "").replace(/^Bearer /, "");
    const host = new URL(String(input)).host;
    probed.push({ key, host });
    onProbe(key);
    return respond(key);
  }) as typeof fetch;
});
afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

async function call<Ret>(channel: string, ...args: unknown[]): Promise<Ret> {
  const handler = handlers.get(channel);
  assert.ok(handler !== undefined, `${channel} 没有注册`);
  return (await handler({}, ...args)) as Ret;
}

const upsert = (input: ProviderUpsertInput): Promise<UpsertResult> => call(ipcChannels.providerUpsert, input);
const quota = (providerId: string): Promise<QuotaResult> => call(ipcChannels.providerQuota, { providerId });
const remove = (id: string): Promise<void> => call(ipcChannels.providerRemove, id);

function deepseek(
  id: string,
  extra: { apiKey?: string; create?: boolean; baseUrl?: string; displayName?: string } = {},
): ProviderUpsertInput {
  return {
    provider: {
      id,
      kind: "deepseek",
      displayName: extra.displayName ?? "DeepSeek",
      endpoint: { baseUrl: extra.baseUrl ?? "https://api.deepseek.com", api: "openai-completions" },
      models: { declared: [{ id: "deepseek-chat" }] },
      auth: { scheme: "api_key" },
    },
    ...(extra.apiKey === undefined ? {} : { apiKey: extra.apiKey }),
    ...(extra.create === true ? { create: true } : {}),
  };
}

async function addWithKey(id: string, apiKey: string): Promise<void> {
  const result = await upsert(deepseek(id, { apiKey, create: true }));
  assert.equal(result.ok, true, JSON.stringify(result));
}

function balance(amount: string): Response {
  return new Response(JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: amount }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function unauthorized(): Response {
  return new Response("unauthorized", { status: 401 });
}

/** 界面上会画出来的余额数字：成功取新值，失败取「保留旧值」那份；都没有就是 null */
function shownAmount(result: QuotaResult): string | null {
  if (result.status === "ok") return result.snapshot.credits?.amount ?? null;
  if (result.status === "error") return result.cached?.credits?.amount ?? null;
  return null;
}
function isFreshOk(result: QuotaResult): boolean {
  return result.status === "ok" && !result.fromCache;
}
function isCachedOk(result: QuotaResult): boolean {
  return result.status === "ok" && result.fromCache;
}

describe("provider:quota —— 换钥匙 / 换地址 / 删除之后，按旧配置查到的额度作废", () => {
  test("换钥匙：60 秒内也不再顶着旧账号的余额，按新钥匙重查", async () => {
    respond = (key) => balance(key === KEY_A ? "111.00" : "9.00");
    await addWithKey("ds-key", KEY_A);
    assert.equal(shownAmount(await quota("ds-key")), "111.00");
    assert.equal(isCachedOk(await quota("ds-key")), true, "没换钥匙时 60 秒内复用，不打接口");

    await upsert(deepseek("ds-key", { apiKey: KEY_B })); // 换成账号 B 的钥匙

    const after = await quota("ds-key");
    assert.equal(shownAmount(after), "9.00");
    assert.equal(isFreshOk(after), true, "换了钥匙就不能再回缓存");
    assert.equal(probed.at(-1)?.key, KEY_B, "按新钥匙重查");
  });

  test("新钥匙探测失败：不把上一家的快照当「保留旧值」返回，盘上的旧快照也删掉", async () => {
    respond = (key) => (key === KEY_A ? balance("111.00") : unauthorized());
    await addWithKey("ds-keyfail", KEY_A);
    assert.equal(shownAmount(await quota("ds-keyfail")), "111.00");

    await upsert(deepseek("ds-keyfail", { apiKey: KEY_B }));

    assert.deepEqual(await quota("ds-keyfail"), { status: "error", reason: "auth", cached: null });
    assert.equal((await cache.read())["ds-keyfail"], undefined);
  });

  test("只改显示名 / 型号清单：缓存留着，不多打一次厂商接口", async () => {
    respond = () => balance("5.00");
    await addWithKey("ds-rename", KEY_A);
    await quota("ds-rename");
    assert.equal(probed.length, 1);

    const draft = deepseek("ds-rename");
    await upsert({
      provider: {
        ...draft.provider,
        displayName: "DeepSeek 备用",
        models: { declared: [{ id: "deepseek-reasoner" }] },
      },
    });

    assert.equal(isCachedOk(await quota("ds-rename")), true);
    assert.equal(probed.length, 1, "钥匙与地址都没动，不该再探一次");
  });

  test("换了接口地址：作废，按新地址重查", async () => {
    respond = () => balance("5.00");
    await addWithKey("ds-url", KEY_A);
    assert.equal(shownAmount(await quota("ds-url")), "5.00");

    await upsert(deepseek("ds-url", { baseUrl: "https://mirror.example" }));
    respond = () => balance("7.00");

    const moved = await quota("ds-url");
    assert.equal(shownAmount(moved), "7.00");
    assert.equal(isFreshOk(moved), true);
    assert.equal(probed.at(-1)?.host, "mirror.example");
  });

  test("删掉这家：缓存项跟着删；同名重建后查到的是新账号的额度", async () => {
    respond = (key) => balance(key === KEY_A ? "222.00" : "9.00");
    await addWithKey("ds-readd", KEY_A);
    assert.equal(shownAmount(await quota("ds-readd")), "222.00");

    await remove("ds-readd");
    assert.equal((await cache.read())["ds-readd"], undefined);

    await addWithKey("ds-readd", KEY_B);
    const rebuilt = await quota("ds-readd");
    assert.equal(shownAmount(rebuilt), "9.00");
    assert.equal(probed.at(-1)?.key, KEY_B, "发出去的是新账号的钥匙");
  });

  test("老版本删服务商时没清缓存：新建同名 id 时一并清掉，不吃到上一家", async () => {
    await cache.write("ds-legacy", { credits: { amount: "888.00", currency: "CNY" }, windows: [], fetchedAt: Date.now() });
    respond = () => unauthorized();

    await addWithKey("ds-legacy", KEY_B);

    assert.deepEqual(await quota("ds-legacy"), { status: "error", reason: "auth", cached: null });
  });

  test("探测在途时换了钥匙：旧钥匙那份结果不落缓存，按新钥匙重查", async () => {
    let release: ((response: Response) => void) | undefined;
    let notifyStarted: (() => void) | undefined;
    const firstProbeStarted = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    onProbe = (key) => {
      if (key === KEY_A) notifyStarted?.();
    };
    respond = (key) => {
      if (key === KEY_B) return balance("9.00");
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    };
    await addWithKey("ds-inflight", KEY_A);

    const pending = quota("ds-inflight");
    await firstProbeStarted; // 账号 A 的探测已经发出去、还没回来
    await upsert(deepseek("ds-inflight", { apiKey: KEY_B }));
    release?.(balance("111.00")); // 旧钥匙那份这时才回来

    const result = await pending;
    assert.equal(shownAmount(result), "9.00");
    assert.deepEqual(
      probed.map((item) => item.key),
      [KEY_A, KEY_B],
      "旧钥匙一次、新钥匙一次",
    );
    assert.equal((await cache.read())["ds-inflight"]?.credits?.amount, "9.00", "盘上落的是新钥匙那份");
  });

  test("作废还在删盘、没落定时来了一条查询：等删完再查，不把旧快照当「保留旧值」返回", async () => {
    respond = (key) => (key === KEY_A ? balance("111.00") : unauthorized());
    await addWithKey("ds-forgetting", KEY_A);
    assert.equal(shownAmount(await quota("ds-forgetting")), "111.00");

    // 把删盘卡住：作废已经开始（代数已加），盘上的删除要到测试放行才落定
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let removalAsked: (() => void) | undefined;
    const removalAskedPromise = new Promise<void>((resolve) => {
      removalAsked = resolve;
    });
    const realRemove = cache.remove.bind(cache);
    cache.remove = async (id: string): Promise<void> => {
      removalAsked?.();
      await gate;
      await realRemove(id);
    };

    const saving = upsert(deepseek("ds-forgetting", { apiKey: KEY_B })); // 不等它：它卡在删盘上
    await removalAskedPromise;

    const querying = quota("ds-forgetting");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(probed.length, 1, "删盘没落定之前，这条查询连探测都不该发出去");

    openGate?.();
    await saving;
    assert.deepEqual(await querying, { status: "error", reason: "auth", cached: null });
    assert.equal(probed.at(-1)?.key, KEY_B, "删盘落定之后才按新钥匙去探");
  });

  test("等在途作废的时候又作废了一次：按新代数重来并等第二次删完，不多探、不回旧快照", async () => {
    const KEY_C = "sk-review-key-CCCC";
    respond = (key) => balance(key === KEY_A ? "111.00" : key === KEY_B ? "9.00" : "5.00");
    await addWithKey("ds-twice", KEY_A);
    await quota("ds-twice");

    // 每次删盘各卡一道闸，按调用先后排队；放行第 n 道，第 n 次作废才落定
    const gates: Array<() => void> = [];
    let asked = 0;
    const waiters: Array<() => void> = [];
    const whenAsked = (count: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (asked >= count) resolve();
        else waiters.push(resolve);
      });
    const realRemove = cache.remove.bind(cache);
    cache.remove = async (id: string): Promise<void> => {
      asked += 1;
      waiters.splice(0).forEach((resolve) => resolve());
      await new Promise<void>((resolve) => {
        gates.push(resolve);
      });
      await realRemove(id);
    };

    const savingB = upsert(deepseek("ds-twice", { apiKey: KEY_B }));
    await whenAsked(1);
    const querying = quota("ds-twice"); // 进来就等第一道闸
    const savingC = upsert(deepseek("ds-twice", { apiKey: KEY_C }));
    await whenAsked(2);

    gates[0]?.();
    await savingB;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      probed.map((item) => item.key),
      [KEY_A],
      "第二次作废还没落定：不按中间那把钥匙去探",
    );

    gates[1]?.();
    await savingC;
    assert.equal(shownAmount(await querying), "5.00");
    assert.deepEqual(
      probed.map((item) => item.key),
      [KEY_A, KEY_C],
      "只按最新的钥匙探了一次",
    );
  });
});