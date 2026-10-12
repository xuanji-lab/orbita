import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { BuiltinProvider } from "./agent-ipc.ts";
import {
  FALLBACK_MODEL,
  FALLBACK_THINKING_LEVEL,
  defaultThinkingLevel,
  lookupCatalogModel,
  resolveModelDefaults,
} from "./model-defaults.ts";

/** 目录条目替身：数值照 pi 的 `providers/data/*.json` 实录，别编数 */
function entry(id: string, contextWindow: number, maxTokens: number, image: boolean) {
  return {
    id,
    contextWindow,
    maxTokens,
    input: image ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  };
}

/** pi 目录的最小切片：anthropic / kimi-coding / zai（数值取自 pi-ai 0.84.3 的实际条目） */
const CATALOG: BuiltinProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    models: [
      entry("claude-fable-5", 1_000_000, 128_000, true),
      entry("claude-opus-4-6", 1_000_000, 128_000, true),
      entry("claude-opus-4-7", 999_999, 128_000, true),
      entry("claude-opus-5", 1_000_000, 128_000, true),
      entry("claude-sonnet-5", 1_000_000, 128_000, true),
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi Coding",
    baseUrl: "https://api.moonshot.cn/anthropic",
    api: "anthropic-messages",
    models: [entry("k3", 1_048_576, 131_072, true)],
  },
  {
    id: "zai",
    name: "Z.AI",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    api: "openai-completions",
    models: [entry("glm-5.3", 1_000_000, 131_072, false)],
  },
  {
    // 同名 id 的另一家：用来验证「同家 / 同 api 优先」，窗口故意给个不一样的数
    id: "mirror-gateway",
    name: "Mirror",
    baseUrl: "https://mirror.example/v1",
    api: "openai-completions",
    models: [entry("claude-opus-5", 200_000, 8_192, false)],
  },
];

describe("lookupCatalogModel —— 按模型 id 跨目录找官方条目", () => {
  test("偏好那家的精确 id 最优先：同名 id 在别家参数不同也不会串", () => {
    const hit = lookupCatalogModel(CATALOG, "claude-opus-5", { catalogId: "mirror-gateway" });
    assert.equal(hit?.contextWindow, 200_000);
  });

  test("没有偏好那家（自建网关）：跨全目录精确匹配，同 api 的先", () => {
    // anthropic-messages 的网关拿到 anthropic 的 1M，而不是 mirror-gateway 的 200k
    const viaAnthropic = lookupCatalogModel(CATALOG, "claude-opus-5", { api: "anthropic-messages" });
    assert.equal(viaAnthropic?.contextWindow, 1_000_000);
    const viaOpenai = lookupCatalogModel(CATALOG, "claude-opus-5", { api: "openai-completions" });
    assert.equal(viaOpenai?.contextWindow, 200_000);
  });

  test("k3 挂在 kimi-coding 名下，anthropic 兼容网关照样借得到", () => {
    const hit = lookupCatalogModel(CATALOG, "k3", { api: "anthropic-messages" });
    assert.equal(hit?.contextWindow, 1_048_576);
    assert.deepEqual(hit?.input, ["text", "image"]);
  });

  test("fable 的小版本借大版本：claude-fable-5-1 → claude-fable-5", () => {
    const hit = lookupCatalogModel(CATALOG, "claude-fable-5-1", { api: "anthropic-messages" });
    assert.equal(hit?.id, "claude-fable-5");
    assert.equal(hit?.contextWindow, 1_000_000);
  });

  test("其余 Claude 家族要 major+minor 都相同：opus-4-6 不借 opus-4-7", () => {
    assert.equal(lookupCatalogModel(CATALOG, "claude-opus-4-6")?.contextWindow, 1_000_000);
    // 目录里没有 4-9：家族匹配不许降到别的小版本上
    assert.equal(lookupCatalogModel(CATALOG, "claude-opus-4-9"), undefined);
  });

  test("写法差异归一：claude-opus-4.6 与 claude-4-6-opus 都认", () => {
    assert.equal(lookupCatalogModel(CATALOG, "claude-opus-4.6")?.id, "claude-opus-4-6");
    assert.equal(lookupCatalogModel(CATALOG, "claude-4-6-opus")?.id, "claude-opus-4-6");
  });

  test("非 Claude 的陌生 id 不做家族猜测：宁可没有，不要借错", () => {
    assert.equal(lookupCatalogModel(CATALOG, "glm-5.3-flash"), undefined);
    assert.equal(lookupCatalogModel(CATALOG, "my-gateway-model"), undefined);
  });
});

describe("resolveModelDefaults —— 白名单 > 目录 > 兜底", () => {
  test("目录命中：窗口 / 输出 / 图片能力一起借，source 记 catalog", () => {
    const defaults = resolveModelDefaults(CATALOG, "claude-opus-5", { api: "anthropic-messages" });
    assert.equal(defaults.contextWindow, 1_000_000);
    assert.equal(defaults.maxTokens, 128_000);
    assert.deepEqual(defaults.input, ["text", "image"]);
    assert.equal(defaults.source, "catalog");
  });

  test("glm-5.3 是纯文本：目录说没有 image 就不给 image", () => {
    const defaults = resolveModelDefaults(CATALOG, "glm-5.3", { api: "anthropic-messages" });
    assert.equal(defaults.contextWindow, 1_000_000);
    assert.deepEqual(defaults.input, ["text"]);
  });

  test("家族借参标成 catalog-family：调用方要能区分「精确」与「借的」", () => {
    const defaults = resolveModelDefaults(CATALOG, "claude-fable-5-1", { api: "anthropic-messages" });
    assert.equal(defaults.contextWindow, 1_000_000);
    assert.equal(defaults.source, "catalog-family");
  });

  test("目录没有、白名单有：glm-5.3-flash 拿到 1M（白名单跨网关也生效）", () => {
    const defaults = resolveModelDefaults(CATALOG, "glm-5.3-flash", { api: "anthropic-messages" });
    assert.equal(defaults.contextWindow, 1_000_000);
    assert.equal(defaults.maxTokens, 131_072);
    assert.equal(defaults.source, "known");
  });

  test("reasoning 同一条链：白名单补丁 > 目录条目 > 兜底 false（不确定就不发）", () => {
    // 白名单：glm-5.3-flash 在目录里查不到，reasoning: true 是唯一来源
    assert.equal(resolveModelDefaults(CATALOG, "glm-5.3-flash", { api: "anthropic-messages" }).reasoning, true);
    // 目录：条目带 reasoning 就透传（替身目录见文件头的 CATALOG）
    const withReasoning: BuiltinProvider[] = [
      {
        id: "x",
        name: "x",
        baseUrl: "",
        api: "anthropic-messages",
        models: [{ id: "m1", contextWindow: 1000, maxTokens: 100, input: ["text"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      },
    ];
    assert.equal(resolveModelDefaults(withReasoning, "m1", {}).reasoning, true);
    // 兜底：谁都不认识 = false
    assert.equal(resolveModelDefaults([], "ghost-model", {}).reasoning, false);
  });

  test("白名单盖目录：它存在就是为了赶在目录前面纠错", () => {
    const stale: BuiltinProvider[] = [
      {
        id: "stepfun",
        name: "StepFun",
        baseUrl: "https://api.stepfun.com/step_plan/v1",
        api: "openai-completions",
        models: [entry("step-3.7-flash", 128_000, 8_192, false)],
      },
    ];
    const defaults = resolveModelDefaults(stale, "step-3.7-flash");
    assert.equal(defaults.contextWindow, 256_000); // 白名单的确知值
    assert.equal(defaults.maxTokens, 8_192); // 白名单没写的字段仍走目录
    assert.equal(defaults.source, "catalog");
  });

  test("白名单也能纠模态：纯文本的 step-3.5-flash 不给 image（目录里没有它，否则会落兜底的 image）", () => {
    const defaults = resolveModelDefaults(CATALOG, "step-3.5-flash");
    assert.deepEqual(defaults.input, ["text"]);
    assert.equal(defaults.source, "known");
    // 白名单与目录都不知道的型号仍然赌 image——静默剥图比网关 400 更坏
    assert.deepEqual(resolveModelDefaults(CATALOG, "step-9-flash").input, ["text", "image"]);
  });

  test("两边都没有：落兜底，且 input 带 image——图片被静默剥掉比网关 400 更坏", () => {
    const defaults = resolveModelDefaults(CATALOG, "my-gateway-model");
    assert.equal(defaults.contextWindow, FALLBACK_MODEL.contextWindow);
    assert.equal(defaults.maxTokens, FALLBACK_MODEL.maxTokens);
    assert.deepEqual(defaults.input, ["text", "image"]);
    assert.equal(defaults.source, "fallback");
  });

  test("空目录（builtins 还没拉回来）不抛，如实走兜底", () => {
    assert.equal(resolveModelDefaults([], "claude-opus-5").source, "fallback");
  });

  test("返回的是副本：调用方改了不会污染目录条目", () => {
    const defaults = resolveModelDefaults(CATALOG, "claude-opus-5", { api: "anthropic-messages" });
    defaults.input.push("text");
    defaults.cost.input = 999;
    const again = resolveModelDefaults(CATALOG, "claude-opus-5", { api: "anthropic-messages" });
    assert.deepEqual(again.input, ["text", "image"]);
    assert.equal(again.cost.input, 1);
  });
});

describe("defaultThinkingLevel —— 白名单默认档 > medium，再按支持集夹", () => {
  test("白名单没有的型号退 medium（与 pi 的全局默认同值）", () => {
    assert.equal(FALLBACK_THINKING_LEVEL, "medium");
    assert.equal(defaultThinkingLevel("no-such-model"), "medium");
  });

  test("退 medium 后按支持集夹：只有 low/high/max 的型号落 high", () => {
    assert.equal(defaultThinkingLevel("no-such-model", ["low", "high", "max"]), "high");
  });

  test("支持集未知时不夹——主进程派子会话拿不到目录，交给 pi 发送前按同规则夹", () => {
    assert.equal(defaultThinkingLevel("no-such-model", undefined), "medium");
  });
});
