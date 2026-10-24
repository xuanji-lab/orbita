import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_PROVIDERS,
  catalogPreferenceOf,
  isPlanBilling,
  knownProviderDefaultName,
  knownProviderOf,
  knownProviderGroup,
} from "./known-providers.ts";
import type { ProviderApi } from "./provider.ts";

// 与 validateProvider 的 ID_PATTERN 同一条规则（那边未导出，这里镜像一份；改要同步）
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,64}$/;

test("KNOWN_PROVIDERS：id 合法且不重复——下拉框的 key 与 upsert 的 id 都靠它", () => {
  const ids = KNOWN_PROVIDERS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "id 重复会让下拉框 key 撞车");
  for (const provider of KNOWN_PROVIDERS) {
    assert.match(provider.id, ID_PATTERN, `${provider.id} 过不了 upsert 校验`);
    assert.ok(provider.label !== "", `${provider.id} 缺显示名`);
  }
});

describe("knownProviderGroup —— 添加服务商目录的三个分区", () => {
  const groupOf = (id: string) => {
    const provider = KNOWN_PROVIDERS.find((item) => item.id === id);
    assert.ok(provider !== undefined, id);
    return knownProviderGroup(provider);
  };

  it("按量的官方 API 进 api，套餐进 plan，没有预填地址的兼容入口进 custom", () => {
    assert.equal(groupOf("deepseek"), "api");
    assert.equal(groupOf("zhipu"), "api");
    assert.equal(groupOf("zhipu-coding"), "plan");
    assert.equal(groupOf("kimi-coding"), "plan");
    assert.equal(groupOf("opencode-go"), "plan");
    assert.equal(groupOf("anthropic-compatible"), "custom");
    assert.equal(groupOf("openai-compatible"), "custom");
  });

  it("每个区都不空——空区意味着条目的 billing / baseUrl 写错了", () => {
    const groups = new Set(KNOWN_PROVIDERS.map(knownProviderGroup));
    assert.deepEqual([...groups].sort(), ["api", "custom", "plan"]);
  });
});

describe("命名 —— label 是厂商名，计费方式交给分区", () => {
  it("label 不带 Coding Plan / API 一类的计费后缀", () => {
    for (const provider of KNOWN_PROVIDERS) {
      assert.doesNotMatch(provider.label, /coding plan|\bapi\b|套餐|按量/i, provider.id);
    }
  });

  it("同名的两条（智谱按量 / 套餐）实例默认名带上计费方式，不同名的就是 label", () => {
    const byId = (id: string) => {
      const provider = KNOWN_PROVIDERS.find((item) => item.id === id);
      assert.ok(provider !== undefined, id);
      return provider;
    };
    assert.equal(knownProviderDefaultName(byId("zhipu")), "智谱（按量）");
    assert.equal(knownProviderDefaultName(byId("zhipu-coding")), "智谱（套餐）");
    assert.equal(knownProviderDefaultName(byId("kimi-coding")), "Kimi");
    const names = KNOWN_PROVIDERS.map(knownProviderDefaultName);
    assert.equal(new Set(names).size, names.length, "默认名撞了，服务商列表里分不出来");
  });
});

/** 一个已配置 provider 的最小形状（knownProviderOf 的入参） */
const p = (id: string, extra: { kind?: string; api?: ProviderApi } = {}) => ({
  id,
  ...(extra.kind === undefined ? {} : { kind: extra.kind }),
  endpoint: { api: extra.api ?? ("openai-completions" as ProviderApi) },
});

describe("knownProviderOf —— 同一家的第二个实例也认得出", () => {
  it("显式 kind 优先", () => {
    assert.equal(knownProviderOf(p("my-ds", { kind: "deepseek" })).id, "deepseek");
  });
  it("老数据没有 kind：id 本身、-N 与 -copy 后缀都认回目录条目", () => {
    assert.equal(knownProviderOf(p("deepseek")).id, "deepseek");
    assert.equal(knownProviderOf(p("deepseek-2")).id, "deepseek");
    assert.equal(knownProviderOf(p("kimi-coding-3", { api: "anthropic-messages" })).id, "kimi-coding");
    assert.equal(knownProviderOf(p("zhipu-coding-copy2", { api: "anthropic-messages" })).id, "zhipu-coding");
  });
  it("后缀剥离不误伤：zhipu-coding 不会被认成 zhipu", () => {
    assert.equal(knownProviderOf(p("zhipu-coding", { api: "anthropic-messages" })).id, "zhipu-coding");
  });
  it("认不出的按协议落兼容；不认识的 kind 当没写", () => {
    assert.equal(knownProviderOf(p("proma")).id, "openai-compatible");
    assert.equal(knownProviderOf(p("gw", { api: "anthropic-messages" })).id, "anthropic-compatible");
    assert.equal(knownProviderOf(p("gw", { kind: "nope" })).id, "openai-compatible");
  });
  it("第二个套餐实例同样按套餐计费", () => {
    assert.equal(isPlanBilling(p("kimi-coding-2", { api: "anthropic-messages" })), true);
    assert.equal(isPlanBilling(p("my-kimi", { kind: "kimi-coding", api: "anthropic-messages" })), true);
  });
});

describe("isPlanBilling —— 两句话不能混", () => {
  it("Coding Plan 与 Step Plan 是订阅制", () => {
    assert.equal(isPlanBilling(p("zhipu-coding")), true);
    assert.equal(isPlanBilling(p("zai")), true);
    assert.equal(isPlanBilling(p("stepfun")), true);
  });

  it("标准 API 按量计费", () => {
    assert.equal(isPlanBilling(p("zhipu")), false);
    assert.equal(isPlanBilling(p("deepseek")), false);
  });

  it("认不得的 id（自建网关）一律当按量算——藏起真实花费比多一行估价更坏", () => {
    assert.equal(isPlanBilling(p("my-own-gateway")), false);
    assert.equal(isPlanBilling(p("")), false);
  });
});

describe("catalogPreferenceOf —— 设置页、菜单与会话装配共用的查目录偏好", () => {
  const byId = (id: string) => {
    const provider = KNOWN_PROVIDERS.find((item) => item.id === id);
    assert.ok(provider !== undefined, id);
    return provider;
  };

  it("带上本家目录与协议；实例协议优先于条目协议", () => {
    assert.deepEqual(catalogPreferenceOf(byId("zhipu-coding")), {
      api: "anthropic-messages",
      catalogId: "zai-coding-cn",
    });
    assert.deepEqual(catalogPreferenceOf(byId("anthropic-compatible"), "anthropic-messages"), {
      api: "anthropic-messages",
    });
  });

  it("OpenCode Go 是「目录说了算」：聚合网关会收窄型号能力（kimi-k3 只开 max）", () => {
    assert.equal(catalogPreferenceOf(byId("opencode-go")).catalogAuthoritative, true);
    // 其余条目都不是：白名单存在的意义就是赶在目录前面纠错
    for (const provider of KNOWN_PROVIDERS) {
      if (provider.id === "opencode-go") continue;
      assert.equal("catalogAuthoritative" in catalogPreferenceOf(provider), false, provider.id);
    }
  });

  it("「目录说了算」必须有本家目录可依——没有 catalogId 的条目标它没有意义", () => {
    for (const provider of KNOWN_PROVIDERS) {
      if (provider.catalogAuthoritative === true) assert.ok(provider.catalogId !== undefined, provider.id);
    }
  });
});
