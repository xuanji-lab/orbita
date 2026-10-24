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
import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
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
  ui: { contextWindow: number; maxTokens: number; image: boolean; levels: readonly ThinkingLevel[] | null };
  runtime: { contextWindow: number; maxTokens: number; image: boolean; levels: ThinkingLevel[]; api: string; baseUrl: string } | undefined;
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
      image: defaults.input.includes("image"),
      levels: modelThinkingLevels(modelId, catalog, null, prefer),
    },
    runtime:
      model === undefined
        ? undefined
        : {
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            image: model.input.includes("image"),
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
  // 图片徽标说能看图、会话里却被 pi 当纯文本剥图（或反过来），是同一类两套话
  assert.equal(sides.runtime.image, sides.ui.image, `${label} 收不收图`);
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

/** pi 真正要发出去的请求体：onPayload 里截下后抛错，请求不出进程 */
async function outgoingPayload(model: Model<"anthropic-messages">, reasoning: "low" | "high" | "max"): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const events = streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: 0 }] },
    {
      apiKey: "sk-test",
      reasoning,
      onPayload: (payload) => {
        captured = payload as Record<string, unknown>;
        throw new Error("stop before network");
      },
    },
  );
  for await (const _event of events) {
    // 抛错后流以 error 事件收尾，排干即可
  }
  assert.ok(captured !== undefined, "pi 没有走到构造请求体那一步");
  return captured;
}

describe("Kimi K3.1 Pro 在 Kimi 套餐上（目录还没收录，全靠白名单）", () => {
  test("会话里拿到 1M / 131072，选的档以 adaptive + effort 原样送到——不是被无视的 budget_tokens", async () => {
    const known = KNOWN_PROVIDERS.find((provider) => provider.id === "kimi-coding");
    assert.ok(known !== undefined && known.api === "anthropic-messages");
    const runtime = await freshRuntime();
    // 前提：目录真的没收录（收录了的话这条测的就是目录，不是白名单）
    assert.equal(runtime.getModel("kimi-coding", "k3.1-pro"), undefined);
    const model = registerAndResolveModel(
      runtime,
      {
        id: known.id,
        apiKey: "sk-test",
        baseUrl: known.baseUrl,
        api: known.api,
        models: [{ id: "k3.1-pro" }],
        ...catalogPreferenceOf(known),
      },
      "k3.1-pro",
    );
    assert.ok(model !== undefined);
    assert.equal(model.contextWindow, 1_048_576);
    assert.equal(model.maxTokens, 131_072);
    assert.deepEqual(getSupportedThinkingLevels(model), ["low", "high", "max"]);
    const anthropicModel = { ...model, api: "anthropic-messages" } as Model<"anthropic-messages">;
    for (const level of ["low", "high", "max"] as const) {
      const payload = await outgoingPayload(anthropicModel, level);
      assert.deepEqual(payload["output_config"], { effort: level }, `${level} 档的 effort`);
      assert.equal((payload["thinking"] as { type?: string } | undefined)?.type, "adaptive", `${level} 档的 thinking`);
    }
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
  test("每个预填了地址的条目：本家目录型号、同名内建条目的型号与白名单型号都按条目的 api / baseUrl 注册", async () => {
    const piRuntime = await freshRuntime();
    const piModels = (id: string | undefined) =>
      piRuntime.getProviders().find((provider) => provider.id === id)?.getModels() ?? [];
    const checked: string[] = [];
    for (const known of KNOWN_PROVIDERS) {
      if (known.baseUrl === "") continue;
      // 本家目录（catalogId）的全部型号 + 与我们的 id **同名**的 pi 内建条目的型号（qwen-token-plan 的坑）
      // + 一个白名单型号（走补注册那条路）
      const ids = new Set([...piModels(known.catalogId), ...piModels(known.id)].map((model) => model.id));
      ids.add("glm-5.3");
      for (const modelId of ids) {
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
        if (model.api === known.api) {
          assert.equal(model.baseUrl, known.baseUrl, `${known.id}/${modelId} 的地址被改道了`);
        } else {
          // 多协议网关（OpenCode Go 的 gpt-5.6-luna 走 Responses、minimax-m3 走 Messages）：协议可以与
          // 条目不同，但协议与地址必须**成对**取自本家目录给这个型号的那一条——不能协议取目录的、
          // 地址却是条目的（/zen/go/v1/v1/messages 的坑）
          const pair = piModels(known.catalogId).some(
            (entry) => entry.id === modelId && entry.api === model.api && entry.baseUrl === model.baseUrl,
          );
          assert.ok(pair, `${known.id}/${modelId} 的协议被改道了（${model.api} @ ${model.baseUrl}）`);
        }
        checked.push(`${known.id}/${modelId}`);
      }
    }
    // 前提断言：真的核对过条目（不会因为全被跳过而永远为真），且智谱两条与 minimax-m3 在里面
    assert.ok(checked.length >= 50, `只核对了 ${checked.length} 条`);
    for (const must of ["zhipu/glm-5.3", "zhipu-coding/glm-5.3", "opencode-go/minimax-m3"]) {
      assert.ok(checked.includes(must), `${must} 没被核对`);
    }
  });
});
