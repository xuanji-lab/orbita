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
import { CatalogRefresher, createModelRuntime, JsonFileModelsStore, piCatalogIds, refreshCatalogs } from "./model-catalog.ts";
import type { FetchTokenrhythmResult } from "./tokenrhythm-catalog.ts";

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
  test("向 pi.dev 要的只是给出的目录 id，去重；基元律动除外（它读自家接口，不向 pi.dev 要）", () => {
    assert.deepEqual(piCatalogIds(["deepseek", "tokenrhythm", "deepseek", "opencode-go"]), ["deepseek", "opencode-go"]);
    assert.deepEqual(piCatalogIds([]), []);
    // 预置表里每份目录都是合法输入（catalogIdsOfProviders 只会从表里取）
    const all = KNOWN_PROVIDERS.flatMap((provider) => (provider.catalogId === undefined ? [] : [provider.catalogId]));
    assert.equal(piCatalogIds(all).includes("tokenrhythm"), false, "自建目录不该向 pi.dev 刷新");
  });

  test("一份目录都没给：不建 runtime、不联网，直接返回空", async () => {
    const errors = await refreshCatalogs({ ids: [], catalogBaseUrl: "http://127.0.0.1:9", force: true });
    assert.equal(errors.size, 0);
    const onlyTokenrhythm = await refreshCatalogs({ ids: ["tokenrhythm"], catalogBaseUrl: "http://127.0.0.1:9", force: true });
    assert.equal(onlyTokenrhythm.size, 0, "基元律动不走 pi.dev：连不上的地址也不会被碰");
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

/** 记账的假依赖：看 CatalogRefresher 向谁要了什么 */
function fakeDeps(tokenrhythm: FetchTokenrhythmResult = { status: "fetched", models: 3 }) {
  const calls: string[] = [];
  const warnings: string[] = [];
  const deps = {
    refreshPi: async (ids: string[]): Promise<ReadonlyMap<string, Error>> => {
      calls.push(`pi:${ids.join(",")}`);
      return new Map();
    },
    refreshTokenrhythm: async (): Promise<FetchTokenrhythmResult> => {
      calls.push("tokenrhythm");
      return tokenrhythm;
    },
    relist: async (): Promise<void> => {
      calls.push("relist");
    },
    warn: (message: string): void => {
      warnings.push(message);
    },
  };
  return { deps, calls, warnings };
}

describe("CatalogRefresher —— 只刷已添加服务商的目录（审核 F-1）", () => {
  test("主进程还没说添加了谁：4 小时那一拍什么都不拉", async () => {
    const { deps, calls } = fakeDeps();
    await new CatalogRefresher(deps).tick();
    assert.deepEqual(calls, []);
  });

  test("没添加任何服务商（added 为空）：pi.dev 与基元律动都不拉，也不重报目录", async () => {
    const { deps, calls } = fakeDeps();
    const refresher = new CatalogRefresher(deps);
    await refresher.request("added", []);
    await refresher.tick();
    assert.deepEqual(calls, []);
  });

  test("只添加了 pi.dev 的服务商：只刷那几家，不碰基元律动", async () => {
    const { deps, calls } = fakeDeps();
    await new CatalogRefresher(deps).request("added", ["deepseek", "opencode-go"]);
    assert.deepEqual(calls, ["pi:deepseek,opencode-go", "relist"]);
  });

  test("添加了基元律动才拉它；之后的 tick 按最近一次 added 的范围", async () => {
    const { deps, calls } = fakeDeps();
    const refresher = new CatalogRefresher(deps);
    await refresher.request("added", ["deepseek"]);
    // 用户又添加了基元律动：主进程送新的全量，当场补刷
    await refresher.request("added", ["deepseek", "tokenrhythm"]);
    calls.length = 0;
    await refresher.tick();
    assert.deepEqual(calls, ["pi:deepseek", "tokenrhythm", "relist"]);
    // 删掉了 deepseek：之后的 tick 不再刷它
    await refresher.request("added", ["tokenrhythm"]);
    calls.length = 0;
    await refresher.tick();
    assert.deepEqual(calls, ["tokenrhythm", "relist"]);
  });

  test("peek 只刷给出的那份，不进 4 小时循环", async () => {
    const { deps, calls } = fakeDeps();
    const refresher = new CatalogRefresher(deps);
    await refresher.request("peek", ["tokenrhythm"]);
    assert.deepEqual(calls, ["tokenrhythm", "relist"]);
    calls.length = 0;
    await refresher.tick();
    assert.deepEqual(calls, [], "没 added 过：peek 不会让 tick 开始联网");
  });

  test("基元律动落在节流里（fresh）：不重报目录；失败记 warn 也不重报", async () => {
    const fresh = fakeDeps({ status: "fresh" });
    await new CatalogRefresher(fresh.deps).request("added", ["tokenrhythm"]);
    assert.deepEqual(fresh.calls, ["tokenrhythm"]);
    const failed = fakeDeps({ status: "failed", reason: "HTTP 503" });
    await new CatalogRefresher(failed.deps).request("added", ["tokenrhythm"]);
    assert.deepEqual(failed.calls, ["tokenrhythm"]);
    assert.ok(failed.warnings[0]?.includes("HTTP 503"));
  });

  test("刷新排队串行：启动的 added 还在路上时来了 peek，等前一趟完了才开始", async () => {
    const { deps, calls } = fakeDeps();
    const refresher = new CatalogRefresher(deps);
    let releaseFirst: (() => void) | undefined;
    deps.refreshPi = async (ids: string[]): Promise<ReadonlyMap<string, Error>> => {
      calls.push(`pi:${ids.join(",")}`);
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return new Map();
    };
    const first = refresher.request("added", ["deepseek"]);
    const second = refresher.request("peek", ["tokenrhythm"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["pi:deepseek"], "第二趟没有并发开始");
    releaseFirst?.();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ["pi:deepseek", "relist", "tokenrhythm", "relist"]);
  });
});
