import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { BuiltinProvider } from "../../../../shared/agent-ipc.ts";
import type { ThinkingLevel } from "../../../../shared/thinking.ts";
import { modelThinkingLevels } from "../../../../shared/model-defaults.ts";
import { reconcileThinkingLevel, resolveThinkingLevel } from "./thinking-choice.ts";

/** 目录条目替身：只填这两个函数用得到的字段 */
function entry(id: string, supportedThinkingLevels?: ThinkingLevel[]) {
  return {
    id,
    contextWindow: 128_000,
    maxTokens: 8_192,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...(supportedThinkingLevels === undefined ? {} : { supportedThinkingLevels }),
  };
}

const CATALOG: BuiltinProvider[] = [
  {
    id: "some-gateway",
    name: "Some Gateway",
    baseUrl: "https://example.com",
    api: "openai-completions",
    // 白名单没收录的型号，支持集只有目录这一份——验证「白名单与 observed 都没有才落目录」
    models: [entry("some-catalog-model", ["low", "medium", "high", "xhigh", "max"])],
  },
  {
    id: "kimi-coding",
    name: "Kimi Coding",
    baseUrl: "https://api.moonshot.cn/anthropic",
    api: "anthropic-messages",
    // k3 目录条目本身没给支持集，且白名单里 k3 已经有一份——用来验证白名单压过目录
    models: [entry("k3")],
  },
];

describe("modelThinkingLevels —— 白名单 > observed > 目录，三处都没有就是 null", () => {
  test("白名单最高：glm-5.3-flash 目录查不到，走白名单的 low/high/max", () => {
    assert.deepEqual(modelThinkingLevels("glm-5.3-flash", []), ["low", "high", "max"]);
  });

  test("白名单压过 observed 与目录：k3 白名单有 low/high/max，即使 observed 说别的也不采信", () => {
    assert.deepEqual(modelThinkingLevels("k3", CATALOG, ["off", "minimal"]), ["low", "high", "max"]);
  });

  test("白名单没有时用 observed：模型不在白名单，目录也没给支持集", () => {
    assert.deepEqual(modelThinkingLevels("no-such-model", [], ["low", "high"]), ["low", "high"]);
  });

  test("白名单与 observed 都没有才落目录", () => {
    assert.deepEqual(modelThinkingLevels("some-catalog-model", CATALOG), [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("三处都没有 = null（未知，调用方按全量显示）", () => {
    assert.equal(modelThinkingLevels("no-such-model", []), null);
    assert.equal(modelThinkingLevels("no-such-model", [], null), null);
  });
});

describe("resolveThinkingLevel —— 手选（若仍受支持）> 这个型号的默认档", () => {
  test("手选档被支持就用它", () => {
    assert.equal(
      resolveThinkingLevel({ modelId: "some-catalog-model", supported: ["low", "high", "max"], picked: "low" }),
      "low",
    );
  });

  test("手选档不被支持：落这个型号的默认档，不是随便夹一个", () => {
    // glm-5.3-flash 白名单默认档是 max（见 known-providers.ts），手选的 medium 不在支持集里
    assert.equal(
      resolveThinkingLevel({ modelId: "glm-5.3-flash", supported: ["low", "high", "max"], picked: "medium" }),
      "max",
    );
  });

  test("没手选（picked === null）：落默认档", () => {
    // claude-sonnet-5 白名单默认档是 high（见 known-providers.ts）
    assert.equal(
      resolveThinkingLevel({
        modelId: "claude-sonnet-5",
        supported: ["low", "medium", "high", "xhigh", "max"],
        picked: null,
      }),
      "high",
    );
  });

  test("支持集未知（null）时手选原样保留——不替用户否决他刚选的档", () => {
    assert.equal(resolveThinkingLevel({ modelId: "no-such-model", supported: null, picked: "xhigh" }), "xhigh");
  });

  test("默认档被夹：白名单外型号 + 支持集只有 low/high/max，退 medium 后夹成 high", () => {
    assert.equal(
      resolveThinkingLevel({ modelId: "no-such-model", supported: ["low", "high", "max"], picked: null }),
      "high",
    );
  });
});

describe("reconcileThinkingLevel —— 会话账里的档过一遍这个型号（移植自 PR 180）", () => {
  test("会话记着 off，而这个型号关不掉思考（step-5-preview 三档）：退它的默认档 medium", () => {
    const supported = modelThinkingLevels("step-5-preview", []);
    assert.deepEqual(supported, ["low", "medium", "high"]);
    assert.equal(reconcileThinkingLevel("off", "step-5-preview", supported), "medium");
    // 已经是它能发的档就不动
    assert.equal(reconcileThinkingLevel("low", "step-5-preview", supported), "low");
  });

  test("上一个型号留下的 minimal / xhigh / max 同样纠回默认档", () => {
    const supported = modelThinkingLevels("step-3.7-flash", []);
    for (const stale of ["minimal", "xhigh", "max"] as const) {
      assert.equal(reconcileThinkingLevel(stale, "step-3.7-flash", supported), "medium");
    }
  });

  test("按服务商算支持集：OpenCode Go 上的 kimi-k3 只有 max，旧会话记的 low 纠成 max", () => {
    const opencode: BuiltinProvider = {
      id: "opencode-go",
      name: "OpenCode Go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      api: "openai-completions",
      models: [entry("kimi-k3", ["max"])],
    };
    const prefer = { catalogId: "opencode-go", api: "openai-completions", catalogAuthoritative: true };
    const supported = modelThinkingLevels("kimi-k3", [opencode], null, prefer);
    assert.deepEqual(supported, ["max"]);
    assert.equal(reconcileThinkingLevel("low", "kimi-k3", supported), "max");
    // 同一个 kimi-k3 不在「目录说了算」的服务商上：low 是它能发的档，不动
    assert.equal(reconcileThinkingLevel("low", "kimi-k3", modelThinkingLevels("kimi-k3", [opencode])), "low");
  });

  test("支持集未知（null）时原样保留——不替用户否决，pi 发送前按同规则夹", () => {
    assert.equal(reconcileThinkingLevel("xhigh", "no-such-model", null), "xhigh");
  });
});
