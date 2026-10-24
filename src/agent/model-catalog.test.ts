import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Api, type Model } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { KNOWN_PROVIDERS } from "../shared/known-providers.ts";
import { catalogIdsToRefresh, createModelRuntime, JsonFileModelsStore, refreshCatalogs } from "./model-catalog.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "orbita-catalog-"));
}

/** 拿一条真的内建目录条目当模板，只换 id——远端目录的条目与内建同构 */
async function templateModel(providerId: string, id: string): Promise<Model<Api>> {
  const runtime = await createModelRuntime(new InMemoryModelsStore());
  const first = runtime.getModels(providerId)[0];
  assert.ok(first, `${providerId} 的内建目录不该是空的`);
  return { ...first, id, name: id };
}

describe("JsonFileModelsStore", () => {
  test("写了能读回，换一个实例（下次启动）也读得到", async () => {
    const path = join(tempDir(), "cache.json");
    const model = await templateModel("opencode-go", "persisted-model");
    const store = new JsonFileModelsStore(path);
    await store.write("opencode-go", { models: [model], checkedAt: 1, lastModified: 2, etag: '"x"' });
    assert.equal((await store.read("opencode-go"))?.models[0]?.id, "persisted-model");
    const reopened = new JsonFileModelsStore(path);
    assert.deepEqual(await reopened.read("opencode-go"), await store.read("opencode-go"));
    await reopened.delete("opencode-go");
    assert.equal(await new JsonFileModelsStore(path).read("opencode-go"), undefined);
  });

  test("两家同时写完，两条都在（写入排队、序列化执行时的全量）", async () => {
    const path = join(tempDir(), "cache.json");
    const store = new JsonFileModelsStore(path);
    await Promise.all([store.write("a", { models: [] }), store.write("b", { models: [] })]);
    const onDisk: unknown = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(onDisk as object).sort(), ["a", "b"]);
    assert.deepEqual(readdirSync(join(path, "..")), ["cache.json"], "原子写不留临时文件");
  });

  test("文件读坏了当空缓存，不抛", async () => {
    const path = join(tempDir(), "cache.json");
    writeFileSync(path, '{"opencode-go": {"models": [');
    assert.equal(await new JsonFileModelsStore(path).read("opencode-go"), undefined);
  });

  test("读出来的是拷贝：调用方改它不会改到缓存", async () => {
    const store = new JsonFileModelsStore(join(tempDir(), "cache.json"));
    await store.write("x", { models: [], checkedAt: 1 });
    const read = await store.read("x");
    assert.ok(read);
    read.checkedAt = 999;
    assert.equal((await store.read("x"))?.checkedAt, 1);
  });
});

describe("createModelRuntime 不读 pi CLI 的 ~/.pi/agent", () => {
  test("pi 配置目录里的自定义 provider 与登录凭据都不进来（对照：pi 的默认选项会读进来）", async () => {
    const agentDir = tempDir();
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          leaky: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "sk-leaky",
            models: [{ id: "leaky-model" }],
          },
        },
      }),
    );
    writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-from-pi-cli" } }));
    const previous = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    try {
      // 对照组：证明这份配置 pi 确实读得懂，下面的「没读进来」才有意义
      const piDefault = await ModelRuntime.create({ modelsStore: new InMemoryModelsStore() });
      assert.ok(piDefault.getModel("leaky", "leaky-model"), "对照组应读到 models.json 里的自定义 provider");
      assert.equal(piDefault.hasConfiguredAuth("anthropic"), true, "对照组应读到 auth.json 里的凭据");

      const ours = await createModelRuntime(new InMemoryModelsStore());
      assert.equal(ours.getModel("leaky", "leaky-model"), undefined);
      assert.equal(ours.hasConfiguredAuth("anthropic"), false);
      assert.ok(ours.getModels("anthropic").length > 0, "内建目录照旧在");
    } finally {
      if (previous === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = previous;
    }
  });
});

describe("refreshCatalogs", () => {
  test("刷新的是预置服务商用到的目录，去重", () => {
    const ids = catalogIdsToRefresh();
    assert.equal(new Set(ids).size, ids.length);
    for (const provider of KNOWN_PROVIDERS) {
      if (provider.catalogId !== undefined) assert.ok(ids.includes(provider.catalogId), provider.catalogId);
    }
    assert.ok(ids.includes("opencode-go"));
  });

  test("从目录服务拉到新型号，落进缓存；下次建 runtime 不联网也看得到；占位凭据不外发", async () => {
    const fresh = await templateModel("opencode-go", "brand-new-model");
    const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", headers: req.headers });
      if (req.url === "/api/models/providers/opencode-go") {
        res.writeHead(200, {
          "content-type": "application/json",
          // 比内建快照新，pi 才会采用（remoteModels 按 lastModified 比）
          "last-modified": new Date(Date.now() + 60_000).toUTCString(),
          etag: '"v1"',
        });
        res.end(JSON.stringify({ models: [fresh] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const store = new JsonFileModelsStore(join(tempDir(), "cache.json"));
      const before = await createModelRuntime(store);
      assert.equal(before.getModel("opencode-go", "brand-new-model"), undefined);
      const builtinCount = before.getModels("opencode-go").length;

      const errors = await refreshCatalogs({
        store,
        ids: ["opencode-go"],
        catalogBaseUrl: `http://127.0.0.1:${port}`,
        force: true,
      });
      assert.equal(errors.size, 0);
      assert.deepEqual(
        seen.map((request) => request.url),
        ["/api/models/providers/opencode-go"],
        "只请求了指定的那一家",
      );
      const sent = JSON.stringify(seen[0]?.headers ?? {});
      assert.equal(sent.includes("orbita-catalog-refresh-placeholder"), false, "占位凭据不该出现在请求里");
      assert.equal(seen[0]?.headers.authorization, undefined);

      // 对照组：不放占位凭据、只开 pi 自己的联网开关，一个请求都不会发——闸门确实存在，
      // 「只传 allowModelNetwork: true」在 Orbita 里等于什么都没做
      await ModelRuntime.create({
        modelsPath: null,
        modelsStore: new JsonFileModelsStore(join(tempDir(), "cache.json")),
        credentials: new InMemoryCredentialStore(),
        allowModelNetwork: true,
        catalogBaseUrl: `http://127.0.0.1:${port}`,
      });
      assert.equal(seen.length, 1, "没有凭据时 pi 不联网");

      const after = await createModelRuntime(store);
      assert.ok(after.getModel("opencode-go", "brand-new-model"), "新型号进了目录");
      assert.equal(after.getModels("opencode-go").length, builtinCount + 1, "覆盖层是合并，内建条目一条不少");
      assert.equal(after.hasConfiguredAuth("opencode-go"), false, "会话用的 runtime 看不到占位凭据");
    } finally {
      server.close();
    }
  });

  test("目录服务连不上：返回这家的错误，缓存不动", async () => {
    const store = new JsonFileModelsStore(join(tempDir(), "cache.json"));
    const errors = await refreshCatalogs({
      store,
      ids: ["opencode-go"],
      // 9 号端口（discard）在本机通常没人听：连接直接被拒
      catalogBaseUrl: "http://127.0.0.1:9",
      force: true,
      signal: AbortSignal.timeout(20_000),
    });
    assert.ok(errors.has("opencode-go"));
    const after = await createModelRuntime(store);
    assert.equal(after.getModel("opencode-go", "brand-new-model"), undefined);
  });
});
