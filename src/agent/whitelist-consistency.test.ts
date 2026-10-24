/**
 * 设置页 / 底栏菜单看到的型号参数，必须与会话里 pi 真正拿到的一致——用**真的** pi 目录跑。
 *
 * 起因（2026-10-24 审计）：白名单的思考档只进菜单、不进会话。kimi-for-coding 菜单里
 * 有 max、会话里没有；OpenCode Go 的 deepseek-v4.1-flash 选 max 实际发 high；
 * OpenCode Go 的 kimi-k3 菜单给三档、会话只有 max。每一条都是「两边各算各的」，
 * 单测替身发现不了——替身就是照着其中一边写的。这里不造替身：遍历每个服务商条目 ×
 * 它会遇到的型号，两边各算一遍，逐字段比。以后往白名单加型号，这条测试自动把它纳入。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { KNOWN_MODELS } from "../shared/known-models.ts";
import { KNOWN_PROVIDERS, catalogPreferenceOf, type KnownProvider } from "../shared/known-providers.ts";
import { modelThinkingLevels, resolveModelDefaults } from "../shared/model-defaults.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/thinking.ts";
import { protocolAddress, registerAndResolveModel, toBuiltinProvider } from "./model-registration.ts";

/** 真 pi 运行时，但不读用户的 ~/.pi/agent（凭据文件放临时目录，models.json 跳过，不联网） */
async function freshRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({
    modelsPath: null,
    authPath: join(mkdtempSync(join(tmpdir(), "orbita-whitelist-")), "auth.json"),
  });
}

const ordered = (levels: readonly ThinkingLevel[]) =>
  [...levels].sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));

interface Sides {
  ui: { contextWindow: number; maxTokens: number; levels: readonly ThinkingLevel[] | null };
  runtime: { contextWindow: number; maxTokens: number; levels: ThinkingLevel[]; api: string; baseUrl: string } | undefined;
  /** 这家服务商条目配的协议与地址（会话必须照这个发） */
  endpoint: { api: string; baseUrl: string };
}

/** 兼容条目没有预填地址（用户自己填），测试里给一个占位 */
function baseUrlOf(known: KnownProvider): string {
  return known.baseUrl === "" ? "https://gateway.example/v1" : known.baseUrl;
}

/** 一个（服务商条目，型号）在两边各算出什么 */
async function bothSides(known: KnownProvider, modelId: string): Promise<Sides> {
  // 设置页的目录快照来自一个没注册过任何东西的运行时（runtime.ts 的 listBuiltins 同款）
  const catalog = (await freshRuntime()).getProviders().map(toBuiltinProvider);
  const prefer = catalogPreferenceOf(known);
  const defaults = resolveModelDefaults(catalog, modelId, prefer);
  const runtime = await freshRuntime();
  const model = registerAndResolveModel(
    runtime,
    {
      id: known.id,
      apiKey: "sk-test",
      baseUrl: baseUrlOf(known),
      api: known.api,
      models: [{ id: modelId }],
      ...(known.catalogId === undefined ? {} : { catalogId: known.catalogId }),
      ...(known.catalogAuthoritative === true ? { catalogAuthoritative: true } : {}),
    },
    modelId,
  );
  return {
    ui: {
      contextWindow: defaults.contextWindow,
      maxTokens: defaults.maxTokens,
      levels: modelThinkingLevels(modelId, catalog, null, prefer),
    },
    runtime:
      model === undefined
        ? undefined
        : {
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            levels: getSupportedThinkingLevels(model),
            api: model.api,
            baseUrl: model.baseUrl,
          },
    // 期望值按没注册过的目录算：注册之后运行时里的同 id 服务商已被我们的条目替换
    endpoint: expectedEndpoint(known, modelId, await freshRuntime()),
  };
}

/**
 * 会话该用的端点：本家目录描述的就是这家端点（有条目协议、地址都与服务商条目一样——多协议网关
 * OpenCode Go）且收录了这个型号时，协议听型号自己的（minimax-m3 走 Anthropic 协议），地址换成
 * 目录里该协议的（/zen/go，不是 /zen/go/v1）；否则协议、地址都听条目的。
 */
function expectedEndpoint(known: KnownProvider, modelId: string, runtime: ModelRuntime): { api: string; baseUrl: string } {
  const entry = { api: known.api, baseUrl: baseUrlOf(known) };
  if (known.catalogId === undefined) return entry;
  const home = runtime.getModels(known.catalogId);
  const describes = home.some(
    (model) => model.api === known.api && model.baseUrl.replace(/\/+$/, "") === entry.baseUrl.replace(/\/+$/, ""),
  );
  const own = home.find((model) => model.id === modelId);
  if (!describes || own === undefined) return entry;
  return { api: own.api, baseUrl: protocolAddress(known.catalogId, entry, own.api) ?? entry.baseUrl };
}

function assertAgree(label: string, sides: Sides): void {
  assert.ok(sides.runtime !== undefined, `${label}：会话里解析不出这个型号`);
  // 协议与地址听服务商条目的：目录只借参数。以前目录条目的 api / baseUrl 会盖掉条目配的，
  // zhipu-coding 的会话一直悄悄发到 OpenAI 协议的 Coding Plan 端点（2026-10-24 查出）
  assert.equal(sides.runtime.api, sides.endpoint.api, `${label} 协议`);
  assert.equal(sides.runtime.baseUrl, sides.endpoint.baseUrl, `${label} 地址`);
  assert.equal(sides.runtime.contextWindow, sides.ui.contextWindow, `${label} 窗口`);
  assert.equal(sides.runtime.maxTokens, sides.ui.maxTokens, `${label} 输出上限`);
  // 菜单说「未知」（null）时按全量显示、开轮后由 thinking 事件纠真——那不是撒谎，不比
  if (sides.ui.levels !== null) {
    assert.deepEqual(ordered(sides.runtime.levels), ordered(sides.ui.levels), `${label} 思考档`);
  }
}

describe("白名单一致性 —— 菜单里能选的，就是会话里真能发出去的", () => {
  test("每个服务商条目 × 白名单型号与它本家目录的型号：窗口、输出、思考档两边一致", async () => {
    const catalog = (await freshRuntime()).getProviders().map(toBuiltinProvider);
    for (const known of KNOWN_PROVIDERS) {
      const home = catalog.find((provider) => provider.id === known.catalogId)?.models.map((model) => model.id) ?? [];
      const ids = new Set([...Object.keys(KNOWN_MODELS), ...home]);
      for (const modelId of ids) {
        assertAgree(`${known.id}/${modelId}`, await bothSides(known, modelId));
      }
    }
  });

  const entry = (id: string) => {
    const known = KNOWN_PROVIDERS.find((item) => item.id === id);
    assert.ok(known !== undefined, id);
    return known;
  };

  test("OpenCode Go 的 kimi-k3：目录说了算，两边都只有 max（白名单的三档不适用于这家网关）", async () => {
    const sides = await bothSides(entry("opencode-go"), "kimi-k3");
    assert.deepEqual(sides.ui.levels, ["max"]);
    assert.deepEqual(sides.runtime?.levels, ["max"]);
  });

  test("OpenCode Go 的 deepseek-v4.1-flash：目录还没收录，白名单补上——max 在会话里也能选", async () => {
    const sides = await bothSides(entry("opencode-go"), "deepseek-v4.1-flash");
    assert.deepEqual(sides.ui.levels, ["off", "low", "high", "max"]);
    assert.deepEqual(ordered(sides.runtime?.levels ?? []), ["off", "low", "high", "max"]);
  });

  test("OpenCode Go 是多协议网关：minimax-m3 照目录走 Anthropic 协议，声明里混了白名单型号（走补注册）也不变", async () => {
    for (const declared of [["minimax-m3"], ["minimax-m3", "deepseek-v4.1-flash"]]) {
      const known = entry("opencode-go");
      const model = registerAndResolveModel(
        await freshRuntime(),
        {
          id: known.id,
          apiKey: "sk-test",
          baseUrl: known.baseUrl,
          api: known.api,
          models: declared.map((id) => ({ id })),
          ...catalogPreferenceOf(known),
        },
        "minimax-m3",
      );
      assert.equal(model?.api, "anthropic-messages", declared.join(","));
      // Anthropic 客户端自己接 /v1/messages：地址必须是 /zen/go，/zen/go/v1 会变成 /v1/v1/messages → 404
      assert.equal(model?.baseUrl, "https://opencode.ai/zen/go", declared.join(","));
    }
  });

  test("OpenCode Go 换成镜像地址时不猜另一协议的地址：原样用条目的（与修之前一样）", async () => {
    const known = entry("opencode-go");
    const model = registerAndResolveModel(
      await freshRuntime(),
      {
        id: known.id,
        apiKey: "sk-test",
        baseUrl: "https://mirror.example/zen/go/v1",
        api: known.api,
        models: [{ id: "minimax-m3" }],
        ...catalogPreferenceOf(known),
      },
      "minimax-m3",
    );
    assert.equal(model?.baseUrl, "https://mirror.example/zen/go/v1");
  });

  test("智谱 Coding Plan 的 glm-5.3：本家目录（zai-coding-cn）是 OpenAI 协议，会话仍走条目配的 Anthropic 端点", async () => {
    const sides = await bothSides(entry("zhipu-coding"), "glm-5.3");
    // 前提：目录条目的协议真的不一样，否则这条测的不是「不被目录改道」
    const catalogEntry = (await freshRuntime()).getModel("zai-coding-cn", "glm-5.3");
    assert.equal(catalogEntry?.api, "openai-completions");
    assert.equal(sides.runtime?.api, "anthropic-messages");
    assert.equal(sides.runtime?.baseUrl, "https://open.bigmodel.cn/api/anthropic");
    // 档位表照带（型号能力跟 id 走）
    assert.deepEqual(ordered(sides.runtime?.levels ?? []), ["low", "high", "max"]);
  });

  test("按量的智谱：地址是 paas/v4，不被带进 Coding Plan 的 coding/paas/v4", async () => {
    const sides = await bothSides(entry("zhipu"), "glm-5.3");
    assert.equal(sides.runtime?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
  });

  test("Claude 订阅的 claude-opus-5：本家目录收录，白名单的档位照样进会话（不再多出 minimal）", async () => {
    const sides = await bothSides(entry("claude"), "claude-opus-5");
    assert.deepEqual(sides.runtime?.levels.includes("minimal"), false);
    assert.deepEqual(ordered(sides.runtime?.levels ?? []), ["off", "low", "medium", "high", "xhigh", "max"]);
  });
});

/**
 * 会话里真正发请求的协议与地址，必须就是条目自己声明的那一套。
 *
 * 起因（2026-10-24 服务商对齐）：目录模型带着自己的 api / baseUrl 进注册（保留合并），我们的
 * id 又常与 pi 内建 id 同名——条目挂了一个协议或地址不同的 catalogId、或 id 撞上协议不同的
 * 内建条目时，请求被悄悄改道到目录那边（qwen-token-plan 填 Anthropic 端点时，会话实际拿
 * openai-completions 去打 /apps/anthropic）。每条取两个型号：本家目录里同协议的第一个
 * （走「只注册 auth 面」那条路），与一个白名单型号（走补注册那条路）。
 */
describe("接入方式一致性 —— 会话里的协议与地址就是条目自己的", () => {
  /**
   * 已知例外（main 上就存在，不在服务商对齐里修）——**fix/registration-keeps-endpoint 合并后删除**
   * （那边的规则：会话里型号的协议与地址以服务商条目为准，目录只借参数）。值是会被改道的那个型号：
   * - 智谱两条挂的 zai-coding-cn 是 `open.bigmodel.cn/api/coding/paas/v4` 上的 OpenAI 协议，
   *   会话被改道到那里——套餐版不走我们配的 /api/anthropic，标准版不走 /api/paas/v4；
   * - OpenCode Go 的 minimax-m3 在目录里只有 Anthropic 协议一条，注册时协议取目录的、地址却是
   *   我们的 `/zen/go/v1`，客户端再接 /v1/messages 就成了 `/zen/go/v1/v1/messages`。
   */
  const KNOWN_REROUTED = new Map([
    ["zhipu", "glm-5.3"],
    ["zhipu-coding", "glm-5.3"],
    ["opencode-go", "minimax-m3"],
  ]);

  test("每个预填了地址的条目：本家同协议型号与白名单型号都按条目的 api / baseUrl 注册", async () => {
    const piRuntime = await freshRuntime();
    const catalog = piRuntime.getProviders().map(toBuiltinProvider);
    const checked: string[] = [];
    for (const known of KNOWN_PROVIDERS) {
      if (known.baseUrl === "") continue;
      // 智谱两条的改道不止一个型号（挂的整个 zai-coding-cn 目录都会），整条跳过
      if (known.id === "zhipu" || known.id === "zhipu-coding") continue;
      const home = catalog.find((provider) => provider.id === known.catalogId);
      const piModels = (id: string | undefined) =>
        (piRuntime.getProviders().find((provider) => provider.id === id)?.getModels() ?? []);
      const sameApi = piModels(known.catalogId).find((model) => model.api === known.api)?.id;
      assert.ok(
        known.catalogId === undefined || (home !== undefined && sameApi !== undefined),
        `${known.id}：catalogId ${known.catalogId ?? ""} 在 pi 目录里没有同协议（${known.api}）的型号——会话会被改道`,
      );
      // 与我们的 id **同名**的 pi 内建条目里的型号：注册时会直接继承它的协议（qwen-token-plan 的坑）
      const sameIdModels = piModels(known.id).map((model) => model.id);
      for (const modelId of new Set([sameApi, ...sameIdModels, "glm-5.3"])) {
        if (modelId === undefined || KNOWN_REROUTED.get(known.id) === modelId) continue;
        const model = registerAndResolveModel(
          await freshRuntime(),
          {
            id: known.id,
            apiKey: "sk-test",
            baseUrl: known.baseUrl,
            api: known.api,
            models: [{ id: modelId }],
            ...(known.catalogId === undefined ? {} : { catalogId: known.catalogId }),
            ...(known.catalogAuthoritative === true ? { catalogAuthoritative: true } : {}),
          },
          modelId,
        );
        assert.ok(model !== undefined, `${known.id}/${modelId}：会话里解析不出这个型号`);
        assert.equal(model.baseUrl, known.baseUrl, `${known.id}/${modelId} 的地址被改道了`);
        // 多协议网关（OpenCode Go 的 gpt-5.6-luna 走 Responses）：协议可以与条目不同，但必须是
        // 目录在**同一个地址**上给这个型号的协议——否则就是协议被目录顶掉了
        const legit = [...piModels(known.catalogId), ...piModels(known.id)].some(
          (entry) => entry.id === modelId && entry.api === model.api && entry.baseUrl === known.baseUrl,
        );
        assert.ok(model.api === known.api || legit, `${known.id}/${modelId} 的协议被改道了（${model.api}）`);
        checked.push(`${known.id}/${modelId}`);
      }
    }
    // 前提断言：真的核对过条目（不会因为全被跳过而永远为真）
    assert.ok(checked.length >= 20, `只核对了 ${checked.length} 条`);
  });

  test("已知例外确实还在改道——修好之后这条会红，提醒把例外删掉", async () => {
    for (const [id, modelId] of KNOWN_REROUTED) {
      const known = KNOWN_PROVIDERS.find((item) => item.id === id);
      assert.ok(known !== undefined, id);
      const model = registerAndResolveModel(
        await freshRuntime(),
        {
          id: known.id,
          apiKey: "sk-test",
          baseUrl: known.baseUrl,
          api: known.api,
          models: [{ id: modelId }],
          ...(known.catalogId === undefined ? {} : { catalogId: known.catalogId }),
          ...(known.catalogAuthoritative === true ? { catalogAuthoritative: true } : {}),
        },
        modelId,
      );
      assert.ok(model !== undefined, `${id}/${modelId}`);
      assert.ok(
        model.api !== known.api || model.baseUrl !== known.baseUrl,
        `${id}/${modelId} 不再改道了：从 KNOWN_REROUTED 里删掉它`,
      );
    }
  });
});
