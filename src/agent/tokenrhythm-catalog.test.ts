/**
 * 基元律动目录适配的测试：解析与过滤、字段映射、官方单价、注册进 pi 运行时、
 * 缓存与拉取退回。样本取自 2026-10-24 的真实抓取（字段名与取值照抄，只裁剪条数）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { BuiltinProvider } from "../shared/agent-ipc.ts";
import { CATALOG_CACHE_ENV } from "../shared/agent-ipc.ts";
import { KNOWN_PROVIDERS } from "../shared/known-providers.ts";
import { resolveModelDefaults } from "../shared/model-defaults.ts";
import { registerAndResolveModel, toBuiltinProvider } from "./model-registration.ts";
import {
  applyTokenrhythmCatalog,
  applyTokenrhythmFromCache,
  fetchTokenrhythmCatalog,
  loadTokenrhythmCache,
  parseTokenrhythmCatalog,
  tokenrhythmCacheFetchedAt,
  tokenrhythmCachePath,
  tokenrhythmOfficialRates,
  tokenrhythmRegistration,
  TOKENRHYTHM_BASE_URL,
  TOKENRHYTHM_CATALOG_ID,
} from "./tokenrhythm-catalog.ts";

/** 2026-10-24 抓的 /api/models 原样字段（裁剪到测试要用的几条，字段名不改） */
function samplePayload(): Record<string, unknown> {
  return {
    code: 0,
    message: "ok",
    traceId: "tr-test",
    data: [
      {
        id: "glm-5.3",
        name: "GLM-5.3",
        type: "chat",
        status: "online",
        effectiveAvailable: true,
        contextWindow: 1048576,
        maxOutputTokens: 131072,
        supportsVision: false,
        supportsReasoning: true,
        reasoningMode: "required",
        reasoningDefault: "provider",
        reasoningSupportedEfforts: [],
        protocolCapabilities: { openai: { available: true }, anthropic: { available: true } },
      },
      {
        id: "kimi-k3",
        name: "Kimi K3",
        type: "chat",
        status: "testing",
        contextWindow: 1048576,
        maxOutputTokens: 1048576,
        supportsVision: true,
        supportsReasoning: true,
        reasoningMode: "optional",
        reasoningSupportedEfforts: [],
        protocolCapabilities: { openai: { available: true }, anthropic: { available: false } },
      },
      {
        id: "minimax-m3.1-flash",
        name: "MiniMax M3.1-Flash",
        type: "chat",
        status: "testing",
        contextWindow: 1000000,
        maxOutputTokens: 524288,
        supportsVision: true,
        supportsReasoning: true,
        reasoningMode: "required",
        reasoningSupportedEfforts: ["low", "medium", "high", "max"],
        protocolCapabilities: { openai: { available: true }, anthropic: { available: true } },
      },
      {
        id: "deepseek-v4.1-flash-1017",
        name: "DeepSeek V4.1 Flash 1017",
        type: "chat",
        status: "online",
        contextWindow: 1000000,
        maxOutputTokens: 393216,
        supportsVision: true,
        supportsReasoning: true,
        reasoningMode: "optional",
        reasoningSupportedEfforts: [],
        protocolCapabilities: { openai: { available: true }, anthropic: { available: true } },
      },
      // 以下都是该被过滤掉的
      { id: "qwen-image-2.0", name: "Qwen Image 2.0", type: "image", status: "online", contextWindow: 0, protocolCapabilities: { openai: { available: true } } },
      { id: "wan3.0-video", name: "Wan 3.0", type: "video", status: "testing", protocolCapabilities: { openai: { available: false } } },
      { id: "paused-model", name: "Paused", type: "chat", status: "offline", contextWindow: 100000, protocolCapabilities: { openai: { available: true } } },
      { id: "fixing-model", name: "Fixing", type: "chat", status: "maintenance", contextWindow: 100000, protocolCapabilities: { openai: { available: true } } },
      { id: "gray-model", name: "Gray", type: "chat", status: "online", effectiveAvailable: false, contextWindow: 100000, protocolCapabilities: { openai: { available: true } } },
      { id: "anthropic-only", name: "Anthropic Only", type: "chat", status: "online", contextWindow: 100000, protocolCapabilities: { openai: { available: false }, anthropic: { available: true } } },
      { id: "no-window", name: "No Window", type: "chat", status: "online", protocolCapabilities: { openai: { available: true } } },
    ],
  };
}

describe("parseTokenrhythmCatalog —— 容错解析与过滤", () => {
  test("chat + OpenAI 协议可用 + 未下线的留下，字段按我们的注册形状映射", () => {
    const parsed = parseTokenrhythmCatalog(samplePayload());
    assert.ok(parsed !== null);
    assert.deepEqual(
      parsed.models.map((model) => model.id),
      ["glm-5.3", "kimi-k3", "minimax-m3.1-flash", "deepseek-v4.1-flash-1017"],
    );
    const glm = parsed.models[0];
    assert.ok(glm !== undefined);
    assert.equal(glm.name, "GLM-5.3");
    assert.equal(glm.contextWindow, 1_048_576);
    assert.equal(glm.maxTokens, 131_072);
    assert.deepEqual(glm.input, ["text"]);
    assert.equal(glm.reasoning, true);
    // 命中过滤的都记下来（offline / maintenance / effectiveAvailable=false / OpenAI 不可用 / 缺窗口）
    assert.deepEqual(parsed.dropped, ["paused-model", "fixing-model", "gray-model", "anthropic-only", "no-window"]);
  });

  test("minimal 一律不提供：optional / required / efforts 清单三种都不含（真 key 实测发 minimal 会 400）", () => {
    const parsed = parseTokenrhythmCatalog(samplePayload());
    assert.ok(parsed !== null);
    assert.equal(parsed.models.length, 4);
    const glm = parsed.models[0];
    const kimi = parsed.models[1];
    const minimax = parsed.models[2];
    assert.ok(glm !== undefined && kimi !== undefined && minimax !== undefined);
    // required、无清单：off 与 minimal 都去掉
    assert.deepEqual(glm.thinkingLevelMap, { off: null, minimal: null });
    // optional、无清单：只去掉 minimal，其余交给 pi 默认
    assert.deepEqual(kimi.thinkingLevelMap, { minimal: null });
    // required、low…max 清单：照清单收窄，minimal 也不给
    assert.deepEqual(minimax.thinkingLevelMap, { off: null, minimal: null, xhigh: null, max: "max" });
  });

  test("reasoningMode=required 不给「关」；efforts 清单里的 xhigh / max 落字符串", () => {
    const parsed = parseTokenrhythmCatalog(samplePayload());
    assert.ok(parsed !== null);
    const glm = parsed.models[0];
    const minimax = parsed.models[2];
    assert.ok(glm !== undefined && minimax !== undefined);
    assert.equal(glm.thinkingLevelMap?.off, null);
    assert.equal(minimax.thinkingLevelMap?.max, "max");
    assert.equal(minimax.thinkingLevelMap?.xhigh, null);
  });

  test("目录的 efforts 清单里真写了 minimal 也不提供——一律 null，不冒 400 的险", () => {
    const base = {
      type: "chat",
      status: "online",
      contextWindow: 100000,
      supportsReasoning: true,
      protocolCapabilities: { openai: { available: true } },
    };
    const parsed = parseTokenrhythmCatalog({
      code: 0,
      data: [{ ...base, id: "odd-model", name: "Odd", reasoningMode: "optional", reasoningSupportedEfforts: ["minimal", "low", "high"] }],
    });
    assert.ok(parsed !== null);
    assert.deepEqual(parsed.models[0]?.thinkingLevelMap, {
      off: null,
      minimal: null,
      medium: null,
      xhigh: null,
      max: null,
    });
  });

  test("reasoningMode=unsupported 的型号不能思考，也不给表", () => {
    const parsed = parseTokenrhythmCatalog({
      code: 0,
      data: [
        {
          id: "plain-model",
          name: "Plain",
          type: "chat",
          status: "online",
          contextWindow: 128000,
          maxOutputTokens: 8192,
          supportsReasoning: false,
          reasoningMode: "unsupported",
          protocolCapabilities: { openai: { available: true } },
        },
      ],
    });
    assert.ok(parsed !== null);
    const plain = parsed.models[0];
    assert.ok(plain !== undefined);
    assert.equal(plain.reasoning, false);
    assert.equal(plain.thinkingLevelMap, undefined);
  });

  test("名字缺省用 id；输出上限缺省 8192；同 id 去重", () => {
    const base = {
      type: "chat",
      status: "online",
      contextWindow: 100000,
      supportsReasoning: false,
      protocolCapabilities: { openai: { available: true } },
    };
    const parsed = parseTokenrhythmCatalog({
      code: 0,
      data: [
        { ...base, id: "bare-id" },
        { ...base, id: "bare-id", contextWindow: 200000 },
        { ...base, id: "no-max", name: "No Max", maxOutputTokens: 0 },
      ],
    });
    assert.ok(parsed !== null);
    assert.deepEqual(
      parsed.models.map((model) => [model.id, model.name, model.contextWindow, model.maxTokens]),
      [
        ["bare-id", "bare-id", 100000, 8192],
        ["no-max", "No Max", 100000, 8192],
      ],
    );
  });

  test("整体形状变了返回 null（当拉取失败，不落缓存）：data 缺席、code 非 0、不是对象", () => {
    assert.equal(parseTokenrhythmCatalog({ code: 0, message: "ok" }), null);
    assert.equal(parseTokenrhythmCatalog({ code: 401, message: "unauthorized", data: [] }), null);
    assert.equal(parseTokenrhythmCatalog("not an object"), null);
    assert.equal(parseTokenrhythmCatalog([1, 2, 3]), null);
  });

  test("老形状（顶层 capabilities.openai）也能认出 OpenAI 可用", () => {
    const parsed = parseTokenrhythmCatalog({
      code: 0,
      data: [{ id: "legacy", type: "chat", status: "online", contextWindow: 64000, capabilities: { openai: true } }],
    });
    assert.ok(parsed !== null);
    const legacy = parsed.models[0];
    assert.ok(legacy !== undefined);
    assert.equal(legacy.id, "legacy");
  });
});

/** 造一个只有两条的 pi 目录（官方单价查找示范用） */
function priceCatalogFixture(): BuiltinProvider[] {
  const model = (id: string, input: number, output: number) => ({
    id,
    contextWindow: 100000,
    maxTokens: 8192,
    input: ["text" as const],
    reasoning: false,
    cost: { input, output, cacheRead: 0, cacheWrite: 0 },
  });
  return [
    { id: "zai", name: "Z.AI", baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", models: [model("glm-5.3", 1.4, 4.4)] },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com", api: "openai-completions", models: [model("deepseek-v4.1-flash", 0.2, 0.6)] },
  ];
}

describe("官方美元单价 —— 复用 officialRates，日期后缀去掉再找", () => {
  test("精确 id 命中官方价；-MMDD 后缀的去掉再找；找不到的零价（如实「缺官方单价」）", () => {
    const catalog = priceCatalogFixture();
    assert.deepEqual(tokenrhythmOfficialRates(catalog, "glm-5.3"), { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(tokenrhythmOfficialRates(catalog, "deepseek-v4.1-flash-1017"), { input: 0.2, output: 0.6, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(tokenrhythmOfficialRates(catalog, "kimi-k3"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("注册条目把官方价烧进 cost，型号不带自己的 api / baseUrl（跟着服务商层走）", () => {
    const parsed = parseTokenrhythmCatalog(samplePayload());
    assert.ok(parsed !== null);
    const registration = tokenrhythmRegistration(parsed.models, priceCatalogFixture());
    assert.equal(registration.api, "openai-completions");
    assert.equal(registration.baseUrl, TOKENRHYTHM_BASE_URL);
    assert.equal(registration.name, "基元律动");
    const glm = registration.models.find((model) => model.id === "glm-5.3");
    assert.ok(glm !== undefined);
    assert.deepEqual(glm.cost, { input: 1.4, output: 4.4, cacheRead: 0, cacheWrite: 0 });
    assert.equal("api" in glm, false);
    assert.equal("baseUrl" in glm, false);
  });

  test("真 pi 目录：静态快照里能命中的几家（glm-5.3 / deepseek 日期后缀）拿到官方价", async () => {
    const runtime = await freshRuntime();
    const catalog = runtime.getProviders().map(toBuiltinProvider);
    const glm = tokenrhythmOfficialRates(catalog, "glm-5.3");
    assert.ok(glm.input > 0 && glm.output > 0);
    const deepseek = tokenrhythmOfficialRates(catalog, "deepseek-v4-flash-0731");
    assert.ok(deepseek.input > 0 && deepseek.output > 0);
    // 快照里没有 deepseek-v4.1-flash 的非零价：去后缀后落到型号白名单的官方价（DeepSeek 峰时价）
    assert.deepEqual(tokenrhythmOfficialRates(catalog, "deepseek-v4.1-flash-1017"), {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      cacheWrite: 0,
    });
  });
});

/** 真 pi 运行时（不读 ~/.pi/agent、不联网），whitelist-consistency.test 同款 */
async function freshRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null,
    authPath: join(mkdtempSync(join(tmpdir(), "orbita-tokenrhythm-")), "auth.json"),
  });
}

describe("注册进 pi 运行时 —— 下游当普通目录条目用", () => {
  test("apply 后 getProviders 里有它；菜单与会话两边对同一个型号说同一句话", async () => {
    const payload = samplePayload();
    const runtime = await freshRuntime();
    const count = applyTokenrhythmCatalog(runtime, payload);
    assert.equal(count, 4);
    const entry = runtime.getProviders().find((provider) => provider.id === TOKENRHYTHM_CATALOG_ID);
    assert.ok(entry !== undefined);
    assert.equal(entry.name, "基元律动");

    // 会话注册（用户实例 id 与目录 id 同名的第一条路）：参数来自目录条目
    const model = registerAndResolveModel(
      runtime,
      {
        id: TOKENRHYTHM_CATALOG_ID,
        apiKey: "sk-test",
        baseUrl: TOKENRHYTHM_BASE_URL,
        api: "openai-completions",
        models: [{ id: "glm-5.3" }],
        catalogId: TOKENRHYTHM_CATALOG_ID,
        catalogAuthoritative: true,
      },
      "glm-5.3",
    );
    assert.ok(model !== undefined);
    assert.equal(model.contextWindow, 1_048_576);
    assert.equal(model.maxTokens, 131_072);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, TOKENRHYTHM_BASE_URL);
    // required：菜单与会话都没有 off；minimal 一律不提供（真 key 实测会 400）
    assert.equal(getSupportedThinkingLevels(model).includes("off"), false);
    assert.equal(getSupportedThinkingLevels(model).includes("minimal"), false);

    // 设置页那一侧（model-defaults 按本家目录优先）算出同一组参数
    const catalog = runtime.getProviders().map(toBuiltinProvider);
    const defaults = resolveModelDefaults(catalog, "glm-5.3", { catalogId: TOKENRHYTHM_CATALOG_ID, catalogAuthoritative: true, api: "openai-completions" });
    assert.equal(defaults.source, "catalog");
    assert.equal(defaults.contextWindow, model.contextWindow);
    assert.equal(defaults.maxTokens, model.maxTokens);
    assert.deepEqual([...defaults.input].sort(), [...model.input].sort());
  });

  test("第二个实例（id 不同）与选了 Anthropic 接入方式的实例：协议与地址听条目的", async () => {
    const runtime = await freshRuntime();
    applyTokenrhythmCatalog(runtime, samplePayload());
    for (const instance of [
      { id: "tokenrhythm-2", api: "openai-completions", baseUrl: TOKENRHYTHM_BASE_URL },
      { id: "tokenrhythm-3", api: "anthropic-messages", baseUrl: "https://tokenrhythm.studio" },
    ]) {
      const model = registerAndResolveModel(
        runtime,
        {
          ...instance,
          apiKey: "sk-test",
          models: [{ id: "kimi-k3" }],
          catalogId: TOKENRHYTHM_CATALOG_ID,
          catalogAuthoritative: true,
        },
        "kimi-k3",
      );
      assert.ok(model !== undefined, instance.id);
      assert.equal(model.api, instance.api, `${instance.id} 协议`);
      assert.equal(model.baseUrl, instance.baseUrl, `${instance.id} 地址`);
      // 参数仍然来自目录（保留合并没有把 1M 拍成兜底）
      assert.equal(model.contextWindow, 1_048_576);
    }
  });

  test("形状不对或一条不剩：什么都不注册", async () => {
    const runtime = await freshRuntime();
    assert.equal(applyTokenrhythmCatalog(runtime, { code: 500 }), 0);
    assert.equal(applyTokenrhythmCatalog(runtime, { code: 0, data: [] }), 0);
    assert.equal(runtime.getProviders().some((provider) => provider.id === TOKENRHYTHM_CATALOG_ID), false);
  });
});

describe("缓存与拉取退回", () => {
  test("拉取成功 → 原子写缓存；load 读回的还能解析注册", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbita-tr-cache-"));
    const cachePath = join(dir, "tokenrhythm-catalog.json");
    const ok = await fetchTokenrhythmCatalog({
      cachePath,
      fetchImpl: (async () => new Response(JSON.stringify(samplePayload()), { status: 200 })) as typeof fetch,
    });
    assert.deepEqual(ok, { status: "fetched", models: 4 });
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as { fetchedAt: string; payload: unknown };
    assert.equal(typeof cached.fetchedAt, "string");
    assert.deepEqual(parseTokenrhythmCatalog(cached.payload)?.models.map((model) => model.id), ["glm-5.3", "kimi-k3", "minimax-m3.1-flash", "deepseek-v4.1-flash-1017"]);

    const runtime = await freshRuntime();
    assert.equal(applyTokenrhythmCatalog(runtime, loadTokenrhythmCache(cachePath)), 4);
    rmSync(dir, { recursive: true, force: true });
  });

  test("拉取失败 / 形状坏了：缓存不动，返回失败原因", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbita-tr-cache-"));
    const cachePath = join(dir, "tokenrhythm-catalog.json");
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: "2026-10-24T00:00:00.000Z", payload: samplePayload() }));
    const before = readFileSync(cachePath, "utf8");

    const unreachable = await fetchTokenrhythmCatalog({
      cachePath,
      fetchImpl: (async () => {
        throw new Error("ETIMEDOUT");
      }) as typeof fetch,
    });
    assert.equal(unreachable.status, "failed");

    const reshaped = await fetchTokenrhythmCatalog({
      cachePath,
      fetchImpl: (async () => new Response(JSON.stringify({ code: 0, message: "ok" }), { status: 200 })) as typeof fetch,
    });
    assert.equal(reshaped.status, "failed");

    const emptied = await fetchTokenrhythmCatalog({
      cachePath,
      fetchImpl: (async () => new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 })) as typeof fetch,
    });
    assert.equal(emptied.status, "failed");

    // 非 2xx：即便响应体是一份能解析的目录也不落（网关错误页偶尔会带 JSON）
    const unavailable = await fetchTokenrhythmCatalog({
      cachePath,
      fetchImpl: (async () => new Response(JSON.stringify(samplePayload()), { status: 503 })) as typeof fetch,
    });
    assert.equal(unavailable.status, "failed");
    assert.ok(unavailable.status === "failed" && unavailable.reason.includes("503"));

    // 超过体积上限：报了 content-length 的当场拒；没报长度的边读边数，超了中止
    const body = JSON.stringify(samplePayload());
    const declared = await fetchTokenrhythmCatalog({
      cachePath,
      maxBytes: 100,
      fetchImpl: (async () =>
        new Response(body, { status: 200, headers: { "content-length": String(body.length) } })) as typeof fetch,
    });
    assert.equal(declared.status, "failed");
    const streamed = await fetchTokenrhythmCatalog({
      cachePath,
      maxBytes: 100,
      fetchImpl: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              const bytes = new TextEncoder().encode(body);
              for (let i = 0; i < bytes.length; i += 64) controller.enqueue(bytes.slice(i, i + 64));
              controller.close();
            },
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    assert.equal(streamed.status, "failed");
    assert.ok(streamed.status === "failed" && streamed.reason.includes("上限"));

    assert.equal(readFileSync(cachePath, "utf8"), before, "失败的各种形态都不许动缓存");
    rmSync(dir, { recursive: true, force: true });
  });

  test("4 小时节流：缓存的 fetchedAt 未过期不联网；过期了、没缓存、缓存时间在未来都照常拉", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orbita-tr-cache-"));
    const cachePath = join(dir, "tokenrhythm-catalog.json");
    const hour = 60 * 60 * 1000;
    const now = Date.parse("2026-10-25T12:00:00.000Z");
    let requests = 0;
    const fetchImpl = (async () => {
      requests += 1;
      return new Response(JSON.stringify(samplePayload()), { status: 200 });
    }) as typeof fetch;
    const input = { cachePath, fetchImpl, minIntervalMs: 4 * hour, now: () => now };

    assert.equal((await fetchTokenrhythmCatalog(input)).status, "fetched", "没缓存：拉");
    assert.equal(requests, 1);
    assert.equal(tokenrhythmCacheFetchedAt(cachePath), now);
    assert.equal((await fetchTokenrhythmCatalog(input)).status, "fresh", "刚拉过：不拉");
    assert.equal(requests, 1);

    writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date(now - 5 * hour).toISOString(), payload: samplePayload() }));
    assert.equal((await fetchTokenrhythmCatalog(input)).status, "fetched", "过期：拉");
    writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date(now + 5 * hour).toISOString(), payload: samplePayload() }));
    assert.equal((await fetchTokenrhythmCatalog(input)).status, "fetched", "时间在未来（改过时钟）：拉");
    assert.equal(requests, 3);
    rmSync(dir, { recursive: true, force: true });
  });

  test("进程内缓存（F-6）：缓存文件没变就不重读重算；文件变了（mtime）按新的注册", async () => {
    const previous = process.env[CATALOG_CACHE_ENV];
    const dir = mkdtempSync(join(tmpdir(), "orbita-tr-memo-"));
    try {
      process.env[CATALOG_CACHE_ENV] = join(dir, "model-catalog-cache.json");
      const cachePath = join(dir, "tokenrhythm-catalog.json");
      writeFileSync(cachePath, JSON.stringify({ fetchedAt: "x", payload: samplePayload() }));
      const stamp = new Date("2026-10-25T00:00:00.000Z");
      utimesSync(cachePath, stamp, stamp);
      assert.equal(applyTokenrhythmFromCache(await freshRuntime()), 4);

      // 换成等长的另一份内容、把 mtime 拨回原值：戳不变 → 命中进程内缓存，仍是旧型号（证明没重读）
      writeFileSync(cachePath, readFileSync(cachePath, "utf8").replace(/"glm-5\.3"/g, '"glm-9.9"'));
      utimesSync(cachePath, stamp, stamp);
      const cached = await freshRuntime();
      applyTokenrhythmFromCache(cached);
      assert.ok(cached.getModel(TOKENRHYTHM_CATALOG_ID, "glm-5.3"), "戳没变：用的是进程内缓存");
      assert.equal(cached.getModel(TOKENRHYTHM_CATALOG_ID, "glm-9.9"), undefined);

      // mtime 变了：重读，新型号进来
      const later = new Date("2026-10-25T01:00:00.000Z");
      utimesSync(cachePath, later, later);
      const reread = await freshRuntime();
      applyTokenrhythmFromCache(reread);
      assert.ok(reread.getModel(TOKENRHYTHM_CATALOG_ID, "glm-9.9"), "戳变了：按新文件注册");
      assert.equal(reread.getModel(TOKENRHYTHM_CATALOG_ID, "glm-5.3"), undefined);

      // 缓存文件删了：不注册
      rmSync(cachePath);
      assert.equal(applyTokenrhythmFromCache(await freshRuntime()), 0);
    } finally {
      if (previous === undefined) delete process.env[CATALOG_CACHE_ENV];
      else process.env[CATALOG_CACHE_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("缓存路径挨着 pi 目录缓存（CATALOG_CACHE_ENV 的同目录）；读坏的当没有；applyTokenrhythmFromCache 从环境变量给的路径读", async () => {
    const previous = process.env[CATALOG_CACHE_ENV];
    try {
      // 期望值也过 join：实现用 path.join，Windows 上分隔符是反斜杠（写死 POSIX 串在 Windows 上必挂）
      const base = join(tmpdir(), "orbita-test");
      process.env[CATALOG_CACHE_ENV] = join(base, "model-catalog-cache.json");
      assert.equal(tokenrhythmCachePath(), join(base, "tokenrhythm-catalog.json"));
      const dir = mkdtempSync(join(tmpdir(), "orbita-tr-cache-"));
      const bad = join(dir, "tokenrhythm-catalog.json");
      writeFileSync(bad, "{ not json");
      assert.equal(loadTokenrhythmCache(bad), undefined);
      // 环境变量指到这个目录后，建运行时自动把缓存里的目录灌进去
      process.env[CATALOG_CACHE_ENV] = join(dir, "model-catalog-cache.json");
      writeFileSync(join(dir, "tokenrhythm-catalog.json"), JSON.stringify({ fetchedAt: "x", payload: samplePayload() }));
      const runtime = await freshRuntime();
      assert.equal(applyTokenrhythmFromCache(runtime), 4);
      assert.ok(runtime.getProviders().some((provider) => provider.id === TOKENRHYTHM_CATALOG_ID));
      rmSync(dir, { recursive: true, force: true });
    } finally {
      if (previous === undefined) delete process.env[CATALOG_CACHE_ENV];
      else process.env[CATALOG_CACHE_ENV] = previous;
    }
  });
});

describe("与服务商条目的对接", () => {
  test("条目存在：catalogId 指向自建目录、目录说了算、已实测（不挂「未实测」）、按量计费、两种接入方式", () => {
    const known = KNOWN_PROVIDERS.find((provider) => provider.id === TOKENRHYTHM_CATALOG_ID);
    assert.ok(known !== undefined);
    assert.equal(known.catalogId, TOKENRHYTHM_CATALOG_ID);
    assert.equal(known.catalogAuthoritative, true);
    assert.equal(known.untested, undefined);
    assert.notEqual(known.billing, "plan");
    assert.deepEqual(
      known.access?.map((access) => [access.api, access.baseUrl]),
      [
        ["openai-completions", "https://tokenrhythm.studio/v1"],
        ["anthropic-messages", "https://tokenrhythm.studio"],
      ],
    );
  });
});
