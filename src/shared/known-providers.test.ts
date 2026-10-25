import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KNOWN_PROVIDERS,
  KNOWN_PROVIDER_GROUPS,
  catalogIdsOfProviders,
  catalogPreferenceOf,
  isPlanBilling,
  knownProviderDefaultName,
  knownProviderOf,
  knownProviderGroup,
  knownAccessFor,
  knownAccessMethods,
  accessChoicesFor,
  accessFamilyOf,
  endpointHintsOf,
} from "./known-providers.ts";
import { PROVIDER_APIS, type ProviderApi } from "./provider.ts";

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

describe("knownProviderGroup —— 添加服务商目录的四个分区", () => {
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
    assert.equal(groupOf("openai-responses-compatible"), "custom");
  });

  it("浏览器登录的订阅单独一区——不看计费口径（Claude 也是套餐计费，但不进套餐区）", () => {
    assert.equal(groupOf("claude"), "oauth");
    assert.equal(groupOf("openai-codex"), "oauth");
    assert.equal(groupOf("github-copilot"), "oauth");
    assert.equal(groupOf("xai"), "oauth");
    for (const provider of KNOWN_PROVIDERS) {
      assert.equal(knownProviderGroup(provider) === "oauth", provider.auth === "oauth", provider.id);
    }
  });

  it("每个区都不空——空区意味着条目的 auth / billing / baseUrl 写错了", () => {
    const groups = new Set(KNOWN_PROVIDERS.map(knownProviderGroup));
    assert.deepEqual([...groups].sort(), [...KNOWN_PROVIDER_GROUPS].sort());
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
    // Kimi 有了按量 API 一条之后同名，套餐那条也要补区别
    assert.equal(knownProviderDefaultName(byId("kimi-coding")), "Kimi（套餐）");
    assert.equal(knownProviderDefaultName(byId("kimi-api")), "Kimi（按量）");
    assert.equal(knownProviderDefaultName(byId("deepseek")), "DeepSeek");
    assert.equal(knownProviderDefaultName(byId("ark-coding-plan")), "火山方舟 Agent");
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

describe("catalogIdsOfProviders —— 目录联网刷新只拉已添加的服务商", () => {
  it("没添加任何服务商：一份也不拉", () => {
    assert.deepEqual(catalogIdsOfProviders([]), []);
  });
  it("按已添加的服务商取目录 id，去重；老数据靠 id 认回条目；自建网关没有目录", () => {
    assert.deepEqual(
      catalogIdsOfProviders([
        p("my-ds", { kind: "deepseek" }),
        p("deepseek-2"),
        p("tr", { kind: "tokenrhythm" }),
        p("my-gateway", { kind: "openai-compatible" }),
      ]),
      ["deepseek", "tokenrhythm"],
    );
  });
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
    assert.equal(knownProviderOf(p("gw", { api: "openai-responses" })).id, "openai-responses-compatible");
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
      api: "openai-completions",
      catalogId: "zai-coding-cn",
    });
    // 已存的老实例（走 Anthropic）按实例自己的协议查
    assert.deepEqual(catalogPreferenceOf(byId("zhipu-coding"), "anthropic-messages"), {
      api: "anthropic-messages",
      catalogId: "zai-coding-cn",
    });
    assert.deepEqual(catalogPreferenceOf(byId("anthropic-compatible"), "anthropic-messages"), {
      api: "anthropic-messages",
    });
  });

  it("OpenCode Go 与基元律动是「目录说了算」：聚合网关会收窄型号能力（kimi-k3 只开 max）", () => {
    assert.equal(catalogPreferenceOf(byId("opencode-go")).catalogAuthoritative, true);
    assert.equal(catalogPreferenceOf(byId("tokenrhythm")).catalogAuthoritative, true);
    // 其余条目都不是：白名单存在的意义就是赶在目录前面纠错
    for (const provider of KNOWN_PROVIDERS) {
      if (provider.id === "opencode-go" || provider.id === "tokenrhythm") continue;
      assert.equal("catalogAuthoritative" in catalogPreferenceOf(provider), false, provider.id);
    }
  });

  it("「目录说了算」必须有本家目录可依——没有 catalogId 的条目标它没有意义", () => {
    for (const provider of KNOWN_PROVIDERS) {
      if (provider.catalogAuthoritative === true) assert.ok(provider.catalogId !== undefined, provider.id);
    }
  });
});

describe("未实测 —— 还没用真实账号验证过的条目如实标出", () => {
  // 用户用真实账号跑通过的条目（2026-10-24 用户裁决的名单）：不带标记
  const VERIFIED = [
    "deepseek",
    "zhipu",
    "zhipu-coding",
    "claude",
    "zai",
    "stepfun",
    "kimi-coding",
    "opencode-go",
    "anthropic-compatible",
    "openai-compatible",
  ];

  it("已实测的不带标记，其余一律带——新加条目默认是没验过的", () => {
    for (const provider of KNOWN_PROVIDERS) {
      assert.equal(provider.untested === true, !VERIFIED.includes(provider.id), provider.id);
    }
  });

  it("对齐补进来的条目都在（API / 套餐 / 自定义各区）", () => {
    const ids = new Set(KNOWN_PROVIDERS.map((provider) => provider.id));
    for (const id of [
      "anthropic",
      "openai",
      "google",
      "kimi-api",
      "minimax",
      "xiaomi",
      "qwen",
      "doubao-api",
      "openrouter",
      "zhipu-coding-team",
      "qwen-token-plan",
      "xiaomi-token-plan",
      "doubao",
      "ark-coding-plan",
      "openai-responses-compatible",
      "openai-codex",
      "github-copilot",
      "xai",
    ]) {
      assert.ok(ids.has(id), id);
    }
  });
});

describe("接入方式 —— 一家可以开着几种协议", () => {
  it("每条的接入方式：默认那一种在列、排第一；协议合法且不重复（选择器按协议选）；地址是 https", () => {
    for (const provider of KNOWN_PROVIDERS) {
      const methods = knownAccessMethods(provider);
      assert.deepEqual(methods[0], { api: provider.api, baseUrl: provider.baseUrl }, provider.id);
      const apis = methods.map((method) => method.api);
      assert.equal(new Set(apis).size, apis.length, `${provider.id} 有重复协议`);
      for (const method of methods) {
        assert.ok(PROVIDER_APIS.includes(method.api), `${provider.id}：${method.api}`);
        if (provider.baseUrl !== "") assert.match(method.baseUrl, /^https:\/\//, provider.id);
      }
    }
  });

  it("智谱 Coding Plan：三种都在（官方文档第 5 节），默认跟 pi 的 zai-coding-cn 走 OpenAI Chat", () => {
    const zhipu = KNOWN_PROVIDERS.find((item) => item.id === "zhipu-coding");
    assert.ok(zhipu !== undefined);
    assert.equal(zhipu.api, "openai-completions");
    assert.equal(zhipu.baseUrl, "https://open.bigmodel.cn/api/coding/paas/v4");
    assert.equal(knownAccessFor(zhipu, "anthropic-messages")?.baseUrl, "https://open.bigmodel.cn/api/anthropic");
    assert.equal(knownAccessFor(zhipu, "openai-responses")?.baseUrl, "https://open.bigmodel.cn/api/v1");
  });

  it("没声明 access 的就是默认一种；没声明的协议查不到", () => {
    const stepfun = KNOWN_PROVIDERS.find((item) => item.id === "stepfun");
    assert.ok(stepfun !== undefined);
    assert.equal(knownAccessMethods(stepfun).length, 1);
    assert.equal(knownAccessFor(stepfun, "anthropic-messages"), undefined);
  });

  it("别名组与 access 同形：每组协议不重复、都是 access 里有的协议、地址是 https", () => {
    for (const provider of KNOWN_PROVIDERS) {
      const declared = new Set(knownAccessMethods(provider).map((method) => method.api));
      for (const family of provider.accessAliases ?? []) {
        const apis = family.map((method) => method.api);
        assert.equal(new Set(apis).size, apis.length, `${provider.id} 别名组有重复协议`);
        for (const method of family) {
          assert.ok(declared.has(method.api), `${provider.id} 别名组多出 ${method.api}`);
          assert.match(method.baseUrl, /^https:\/\//, provider.id);
        }
      }
    }
  });
});

describe("地址分组 —— OpenCode Go 的 inference/go、旧写法 zen/go、文档子路径是同一个网关", () => {
  const go = KNOWN_PROVIDERS.find((item) => item.id === "opencode-go");
  assert.ok(go !== undefined);
  const zen = { api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" } as const;
  const inference = { api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/v1" } as const;
  const subpath = { api: "openai-completions", baseUrl: "https://opencode.ai/inference/go/openai/v1" } as const;
  const mirror = { api: "openai-completions", baseUrl: "https://mirror.example/zen/go/v1" } as const;

  it("默认是 pi 在线目录那一组（inference/go/v1）", () => {
    assert.equal(go.baseUrl, "https://opencode.ai/inference/go/v1");
    assert.deepEqual(accessFamilyOf(go, inference), knownAccessMethods(go));
  });

  it("换协议跟着当前地址那一组走：存 zen 给 zen、存 inference 给 inference、存文档子路径给子路径", () => {
    assert.equal(knownAccessFor(go, "anthropic-messages", zen)?.baseUrl, "https://opencode.ai/zen/go");
    assert.equal(knownAccessFor(go, "openai-responses", zen)?.baseUrl, "https://opencode.ai/zen/go/v1");
    assert.equal(knownAccessFor(go, "anthropic-messages", inference)?.baseUrl, "https://opencode.ai/inference/go");
    assert.equal(knownAccessFor(go, "openai-responses", inference)?.baseUrl, "https://opencode.ai/inference/go/v1");
    assert.equal(knownAccessFor(go, "anthropic-messages", subpath)?.baseUrl, "https://opencode.ai/inference/go/anthropic");
    assert.equal(knownAccessFor(go, "openai-responses", subpath)?.baseUrl, "https://opencode.ai/inference/go/openai/v1");
    assert.equal(knownAccessFor(go, "google-generative-ai", subpath)?.baseUrl, "https://opencode.ai/inference/go/google/v1beta");
    // 从 Anthropic 那条认回同一组再换回来：一来一回地址不漂
    const back = knownAccessFor(go, "openai-completions", { api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go/" });
    assert.equal(back?.baseUrl, "https://opencode.ai/zen/go/v1");
  });

  it("zen/go 那一组没有 Google 路由：选择器不给这一项，不静默把地址换到另一组", () => {
    assert.deepEqual(
      accessChoicesFor(go, zen).map((method) => method.api),
      ["openai-completions", "anthropic-messages", "openai-responses"],
    );
    assert.equal(knownAccessFor(go, "google-generative-ai", zen), undefined);
    assert.ok(accessChoicesFor(go, inference).some((method) => method.api === "google-generative-ai"));
  });

  it("镜像 / 自建地址认不出组：选择器给默认那组（用户点了才换），会话载荷不带 access", () => {
    assert.equal(accessFamilyOf(go, mirror), undefined);
    assert.deepEqual(accessChoicesFor(go, mirror), knownAccessMethods(go));
    assert.deepEqual(endpointHintsOf(go, mirror), { catalogId: "opencode-go", catalogAuthoritative: true });
  });

  it("会话载荷：多协议网关带上所在那一组；单协议的家（智谱选了 Anthropic）不带", () => {
    const hints = endpointHintsOf(go, zen);
    assert.equal(hints.protocolPerModel, true);
    assert.deepEqual(
      hints.access?.find((method) => method.api === "anthropic-messages"),
      { api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" },
    );
    const zhipu = KNOWN_PROVIDERS.find((item) => item.id === "zhipu-coding");
    assert.ok(zhipu !== undefined);
    assert.deepEqual(endpointHintsOf(zhipu, { api: "anthropic-messages", baseUrl: "https://open.bigmodel.cn/api/anthropic" }), {
      catalogId: "zai-coding-cn",
    });
  });
});
