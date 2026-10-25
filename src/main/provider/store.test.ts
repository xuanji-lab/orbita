import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore, ProviderValidationError, type OauthDeps, type SecretsPort } from "./store.ts";
import type { OauthCredential, ProviderUpsertInput } from "../../shared/provider.ts";

/** 内存密钥端口——store 不依赖 Electron，这里就能跑真文件系统的用例 */
class MemorySecrets implements SecretsPort {
  readonly values = new Map<string, string>();
  async set(account: string, plaintext: string) {
    this.values.set(account, plaintext);
  }
  async get(account: string) {
    return this.values.get(account) ?? null;
  }
  async delete(account: string) {
    this.values.delete(account);
  }
}

let dir = "";
let secrets: MemorySecrets;
let store: ProviderStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-provider-"));
  secrets = new MemorySecrets();
  store = new ProviderStore(dir, secrets);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function input(overrides: Partial<ProviderUpsertInput["provider"]> = {}): ProviderUpsertInput {
  return {
    provider: {
      id: "openai",
      displayName: "OpenAI",
      endpoint: { baseUrl: "https://api.openai.com/v1/", api: "openai-completions" },
      models: { declared: [{ id: "gpt-5" }] },
      auth: { scheme: "api_key" },
      ...overrides,
    },
    apiKey: "sk-proj-abcdefgh1234",
  };
}

describe("ProviderStore", () => {
  test("首次启动：文件不存在时读到空列表，不抛错", async () => {
    assert.deepEqual(await store.list(), []);
  });

  test("upsert 落盘并归一 baseUrl；密钥进密钥库、不进 providers.json", async () => {
    await store.upsert(input());
    const raw = await readFile(join(dir, "providers.json"), "utf8");

    assert.ok(!raw.includes("sk-proj-abcdefgh1234"), "明文密钥不得出现在 providers.json");
    const parsed = JSON.parse(raw) as { version: number; providers: unknown[] };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.providers.length, 1);
    assert.equal([...secrets.values.values()][0], "sk-proj-abcdefgh1234");

    const [dto] = await store.list();
    assert.equal(dto?.endpoint.baseUrl, "https://api.openai.com/v1", "尾斜杠应被去掉");
  });

  test("DTO 只带掩码，不带明文（renderer 永远看不到密钥）", async () => {
    await store.upsert(input());
    const [dto] = await store.list();
    assert.equal(dto?.auth.scheme, "api_key");
    if (dto?.auth.scheme !== "api_key") return;
    assert.equal(dto.auth.hasSecret, true);
    assert.equal(dto.auth.masked, "sk-…1234");
    assert.ok(!JSON.stringify(dto).includes("sk-proj-abcdefgh1234"));
  });

  test("resolveApiKey 只给主进程用，能取回明文", async () => {
    await store.upsert(input());
    assert.equal(await store.resolveApiKey("openai"), "sk-proj-abcdefgh1234");
    assert.equal(await store.resolveApiKey("missing"), null);
  });

  test("改其它字段而不传 apiKey：密钥保留，不被清空", async () => {
    await store.upsert(input());
    const before = [...secrets.values.entries()][0];

    await store.upsert({ provider: { ...input().provider, displayName: "OpenAI 正式" } });
    const [dto] = await store.list();
    assert.equal(dto?.displayName, "OpenAI 正式");
    assert.deepEqual([...secrets.values.entries()][0], before, "account 与明文都应原样保留");
  });

  test("create 撞了已有 id → 拒绝，原来那条与它的密钥原样保留", async () => {
    await store.upsert({ ...input(), create: true });
    const before = [...secrets.values.entries()];

    await assert.rejects(
      () => store.upsert({ ...input({ displayName: "第二个" }), apiKey: "sk-second-key-9999", create: true }),
      (error: unknown) =>
        error instanceof ProviderValidationError && error.issues.some((issue) => issue.field === "id"),
    );
    const list = await store.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.displayName, "OpenAI");
    assert.deepEqual([...secrets.values.entries()], before, "旧密钥不得被新 key 覆盖");
  });

  test("create 用新 id → 与已有的并存", async () => {
    await store.upsert({ ...input(), create: true });
    await store.upsert({ ...input({ id: "openai-2" }), apiKey: "sk-second-key-9999", create: true });
    assert.deepEqual((await store.list()).map((p) => p.id), ["openai", "openai-2"]);
    assert.equal(await store.resolveApiKey("openai"), "sk-proj-abcdefgh1234");
    assert.equal(await store.resolveApiKey("openai-2"), "sk-second-key-9999");
  });

  test("kind：认得的条目 id 落盘，认不得的丢掉；编辑时没带就沿用盘上的", async () => {
    await store.upsert({ ...input({ id: "ds-work", kind: "deepseek" }), create: true });
    assert.equal((await store.list())[0]?.kind, "deepseek");

    // 只改名字、不带 kind 的写回：不能把来历冲掉
    await store.upsert({ provider: { ...input({ id: "ds-work" }).provider, displayName: "工作号" } });
    assert.equal((await store.list())[0]?.kind, "deepseek");

    await store.upsert({ ...input({ id: "gw", kind: "no-such-entry" }), create: true });
    assert.equal((await store.list()).find((p) => p.id === "gw")?.kind, undefined);
  });

  test("新建 api_key provider 但不给密钥 → 拒绝，且不落盘", async () => {
    await assert.rejects(
      () => store.upsert({ provider: input().provider }),
      (error: unknown) => error instanceof ProviderValidationError,
    );
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(await readdir(dir), []);
  });

  test("校验不过 → 抛结构化 issues 且不落盘", async () => {
    const bad = input({ id: "BAD ID", displayName: "" });
    await assert.rejects(
      () => store.upsert(bad),
      (error: unknown) => {
        assert.ok(error instanceof ProviderValidationError);
        const fields = error.issues.map((i) => i.field);
        assert.ok(fields.includes("id"));
        assert.ok(fields.includes("displayName"));
        return true;
      },
    );
    assert.deepEqual(await readdir(dir), [], "非法输入不得产生任何文件");
  });

  test("scheme 从 api_key 改为 none：旧密钥被清掉，不留孤儿", async () => {
    await store.upsert(input());
    assert.equal(secrets.values.size, 1);
    await store.upsert({ provider: { ...input().provider, auth: { scheme: "none" } } });
    assert.equal(secrets.values.size, 0);
    const [dto] = await store.list();
    assert.equal(dto?.auth.scheme, "none");
  });

  test("remove 连带删密钥；删不存在的 id 是幂等的", async () => {
    await store.upsert(input());
    await store.remove("openai");
    assert.deepEqual(await store.list(), []);
    assert.equal(secrets.values.size, 0);
    await store.remove("openai");
  });

  test("reorder 按 id 顺序落盘；清单漏掉的 id 保序垫底", async () => {
    await store.upsert(input());
    await store.upsert(input({ id: "zhipu", displayName: "Zhipu" }));
    await store.upsert(input({ id: "deepseek", displayName: "DeepSeek" }));
    assert.deepEqual((await store.list()).map((p) => p.id), ["openai", "zhipu", "deepseek"]);

    await store.reorder(["deepseek", "openai"]);
    assert.deepEqual((await store.list()).map((p) => p.id), ["deepseek", "openai", "zhipu"]);

    // 顺序是持久化的，不是 renderer 本地态：新实例（模拟重启）读盘顺序一致
    const fresh = new ProviderStore(dir, secrets);
    assert.deepEqual((await fresh.list()).map((p) => p.id), ["deepseek", "openai", "zhipu"]);
  });

  test("原子写：落盘后目录里没有 .tmp 残留", async () => {
    await store.upsert(input());
    const files = await readdir(dir);
    assert.deepEqual(files, ["providers.json"]);
  });

  test("文件损坏时抛错，不静默把用户配置当成空列表", async () => {
    await writeFile(join(dir, "providers.json"), "{ not json", "utf8");
    await assert.rejects(() => new ProviderStore(dir, secrets).list());
  });
});

describe("ProviderStore · OAuth（Claude 订阅）", () => {
  const credential = (overrides: Partial<OauthCredential> = {}): OauthCredential => ({
    accessToken: "sk-ant-oat-A",
    refreshToken: "rt-1",
    expiresAt: Date.now() + 3600_000,
    accountEmail: "me@anthropic.com",
    ...overrides,
  });

  /** 假续期网络：每次换新的一对（模拟上游轮换 refresh token），并计数 */
  let refreshCalls = 0;
  const fakeRefresh = async (old: OauthCredential): Promise<OauthCredential> => {
    refreshCalls += 1;
    return credential({
      accessToken: `sk-ant-oat-R${refreshCalls}`,
      refreshToken: `rt-${refreshCalls + 1}`,
      accountEmail: old.accountEmail,
    });
  };
  const oauthStore = () => new ProviderStore(dir, secrets, { refreshOauth: fakeRefresh } satisfies OauthDeps);

  async function upsertOauth(overrides: Partial<ProviderUpsertInput["provider"]> = {}) {
    return store.upsert({
      provider: {
        id: "claude",
        kind: "claude",
        displayName: "Claude",
        endpoint: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
        models: { declared: [{ id: "claude-sonnet-5" }] },
        auth: { scheme: "oauth" },
        ...overrides,
      },
    });
  }

  beforeEach(() => {
    refreshCalls = 0;
  });

  test("登录落盘：凭据只进密钥库，providers.json 只有 secretRef；dto 报已登录与账号", async () => {
    await upsertOauth();
    await store.saveOauthCredential("claude", credential());
    const raw = await readFile(join(dir, "providers.json"), "utf8");
    assert.ok(!raw.includes("sk-ant-oat-A"), "令牌不得出现在 providers.json");
    assert.ok(!raw.includes("rt-1"), "refresh token 不得出现在 providers.json");
    assert.ok(raw.includes("oauth"));

    const [dto] = await store.list();
    assert.equal(dto?.auth.scheme, "oauth");
    if (dto?.auth.scheme === "oauth") {
      assert.equal(dto.auth.loggedIn, true);
      assert.equal(dto.auth.account, "me@anthropic.com");
    }
    assert.equal(await store.resolveOauthApiKey("claude"), "sk-ant-oat-A");
  });

  test("没登录的 oauth provider：dto 报未登录，取令牌返回 null（不是抛错）", async () => {
    await upsertOauth();
    const [dto] = await store.list();
    if (dto?.auth.scheme === "oauth") assert.equal(dto.auth.loggedIn, false);
    assert.equal(await store.resolveOauthApiKey("claude"), null);
  });

  test("未过期的令牌直接返回，不碰续期网络", async () => {
    const s = oauthStore();
    await upsertOauth();
    await s.saveOauthCredential("claude", credential());
    assert.equal(await s.resolveOauthApiKey("claude"), "sk-ant-oat-A");
    assert.equal(refreshCalls, 0);
  });

  test("快过期的令牌自动续期并落盘（下次直接拿新令牌）", async () => {
    const s = oauthStore();
    await upsertOauth();
    await s.saveOauthCredential("claude", credential({ expiresAt: Date.now() - 1 }));
    assert.equal(await s.resolveOauthApiKey("claude"), "sk-ant-oat-R1");
    assert.equal(refreshCalls, 1);
    // 新的一对已在密钥库里：第二次取不再续期
    assert.equal(await s.resolveOauthApiKey("claude"), "sk-ant-oat-R1");
    assert.equal(refreshCalls, 1);
    const stored = await s.readOauthCredential("claude");
    assert.equal(stored?.refreshToken, "rt-2", "轮换出的新 refresh token 必须已写回");
  });

  test("并发的两路取令牌只续期一次（refresh token 轮换下并发即 invalid_grant）", async () => {
    const s = oauthStore();
    await upsertOauth();
    await s.saveOauthCredential("claude", credential({ expiresAt: Date.now() - 1 }));
    const [a, b] = await Promise.all([
      s.resolveOauthApiKey("claude"),
      s.resolveOauthApiKey("claude"),
    ]);
    assert.equal(a, "sk-ant-oat-R1");
    assert.equal(b, "sk-ant-oat-R1");
    assert.equal(refreshCalls, 1);
  });

  test("续期失败要抛错（登录失效要让用户看见，不能静默拿旧令牌硬发）", async () => {
    const failing = new ProviderStore(dir, secrets, {
      refreshOauth: async () => {
        throw new Error("Claude token 端点返回 400：invalid_grant");
      },
    });
    await upsertOauth();
    await failing.saveOauthCredential("claude", credential({ expiresAt: Date.now() - 1 }));
    await assert.rejects(() => failing.resolveOauthApiKey("claude"), /invalid_grant/);
  });

  test("续期按目录条目分派：第二个 Copilot 实例也报 github-copilot；flowData 落盘、续期时原样交给流程", async () => {
    const kinds: string[] = [];
    let sawFlowData: unknown;
    const s = new ProviderStore(dir, secrets, {
      refreshOauth: async (old, kind) => {
        kinds.push(kind);
        sawFlowData = old.flowData;
        return { ...old, accessToken: "tid=2;proxy-ep=proxy.individual.githubcopilot.com", expiresAt: Date.now() + 1800_000 };
      },
    });
    await upsertOauth({
      id: "github-copilot-2",
      kind: "github-copilot",
      displayName: "Copilot",
      endpoint: { baseUrl: "https://api.individual.githubcopilot.com", api: "openai-completions" },
    });
    await s.saveOauthCredential(
      "github-copilot-2",
      credential({ expiresAt: Date.now() - 1, flowData: { enterpriseUrl: "corp.ghe.com", availableModelIds: ["gpt-5.2"] } }),
    );
    const fresh = await s.resolveOauthCredential("github-copilot-2");
    assert.deepEqual(kinds, ["github-copilot"]);
    assert.deepEqual(sawFlowData, { enterpriseUrl: "corp.ghe.com", availableModelIds: ["gpt-5.2"] });
    assert.equal(fresh?.accessToken, "tid=2;proxy-ep=proxy.individual.githubcopilot.com");
    // 落盘的那份也带着 flowData（下次续期还要用）
    assert.deepEqual((await s.readOauthCredential("github-copilot-2"))?.flowData, {
      enterpriseUrl: "corp.ghe.com",
      availableModelIds: ["gpt-5.2"],
    });
  });

  test("损坏的凭据密文当没有（换机器后 safeStorage 解不开），列表不拉挂", async () => {
    await upsertOauth();
    await store.saveOauthCredential("claude", credential());
    // 把真凭据的密钥位直接写成垃圾，模拟解不开的密文
    const [dto] = await store.list();
    const raw = await readFile(join(dir, "providers.json"), "utf8");
    const account = (JSON.parse(raw) as { providers: { id: string; auth: { secretRef?: { account: string } } }[] })
      .providers.find((p) => p.id === dto?.id)?.auth.secretRef?.account;
    assert.ok(account !== undefined);
    await secrets.set(account, "not json");
    assert.equal(await store.readOauthCredential("claude"), null);
    assert.equal(await store.resolveOauthApiKey("claude"), null);
    assert.equal((await store.list()).length, 1, "列表不能被坏密文拉挂");
  });

  test("remove 删 provider 连带删凭据；换成 api_key 时 oauth 密文也清掉", async () => {
    await upsertOauth();
    await store.saveOauthCredential("claude", credential());
    assert.equal(secrets.values.size, 1);

    // oauth → api_key：旧凭据清掉，新密钥落进来
    await store.upsert({
      provider: {
        id: "claude",
        kind: "claude",
        displayName: "Claude",
        endpoint: { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
        models: { declared: [] },
        auth: { scheme: "api_key" },
      },
      apiKey: "sk-ant-api03-k",
    });
    assert.equal(secrets.values.size, 1, "不得残留 oauth 密文");
    assert.equal(await store.resolveOauthApiKey("claude"), null);

    await store.remove("claude");
    assert.equal(secrets.values.size, 0);
  });
});
