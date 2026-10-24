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
import { registerAndResolveModel, toBuiltinProvider } from "./model-registration.ts";

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
  runtime: { contextWindow: number; maxTokens: number; levels: ThinkingLevel[] } | undefined;
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
      baseUrl: known.baseUrl === "" ? "https://gateway.example/v1" : known.baseUrl,
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
        : { contextWindow: model.contextWindow, maxTokens: model.maxTokens, levels: getSupportedThinkingLevels(model) },
  };
}

function assertAgree(label: string, sides: Sides): void {
  assert.ok(sides.runtime !== undefined, `${label}：会话里解析不出这个型号`);
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

  test("Claude 订阅的 claude-opus-5：本家目录收录，白名单的档位照样进会话（不再多出 minimal）", async () => {
    const sides = await bothSides(entry("claude"), "claude-opus-5");
    assert.deepEqual(sides.runtime?.levels.includes("minimal"), false);
    assert.deepEqual(ordered(sides.runtime?.levels ?? []), ["off", "low", "medium", "high", "xhigh", "max"]);
  });
});
