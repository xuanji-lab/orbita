import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderStore, ProviderValidationError, type SecretsPort } from "./store.ts";
import type { ProviderUpsertInput } from "../../shared/provider.ts";

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

// ── 删密钥是显式动作（wafo 2026-09-03：清空输入框保存删不掉 key）──

describe("removeApiKey", () => {
  test("删掉密钥，auth 退回 none；masked 不再显示", async () => {
    const store = new ProviderStore(dir, secrets);
    await store.upsert({
      provider: input({ id: "stepfun", endpoint: { baseUrl: "https://api.stepfun.com/step_plan/v1", api: "openai-completions" } }).provider,
      apiKey: "sk-live",
    });
    await store.removeApiKey("stepfun");
    const after = (await store.list()).find((p) => p.id === "stepfun");
    assert.equal(after?.auth.scheme, "none");
    assert.equal(await store.resolveApiKey("stepfun"), null);
  });

  test("没有密钥的（env / none）是 no-op，不报错", async () => {
    const store = new ProviderStore(dir, secrets);
    await store.upsert({
      provider: {
        ...input().provider,
        id: "gw",
        endpoint: { baseUrl: "https://gw.local/v1", api: "openai-completions" },
        auth: { scheme: "none" },
      },
    });
    await store.removeApiKey("gw");
    assert.equal((await store.list()).find((p) => p.id === "gw")?.auth.scheme, "none");
  });

  test("删了还能再填——account 复用同一个，不留孤儿密钥", async () => {
    const store = new ProviderStore(dir, secrets);
    await store.upsert({ provider: input({ id: "stepfun" }).provider, apiKey: "sk-1" });
    await store.removeApiKey("stepfun");
    await store.upsert({ provider: input({ id: "stepfun" }).provider, apiKey: "sk-2" });
    assert.equal(await store.resolveApiKey("stepfun"), "sk-2");
    assert.equal(secrets.values.size, 1, "钥匙串里只有最后一把，没有孤儿");
  });
});
