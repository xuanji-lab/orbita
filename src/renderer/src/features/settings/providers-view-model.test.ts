import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ModelDefaults } from "../../../../shared/model-defaults.ts";
import {
  compactTokens,
  connectionDirty,
  hasCredentials,
  mergeModelCost,
  modelAcceptsImage,
  modelIdIssue,
  modelContextText,
  nextCopyId,
  parseRateInput,
  parseTokenInput,
  reorderIds,
  urlSuffix,
} from "./providers-view-model.ts";
import { KNOWN_PROVIDERS } from "../../../../shared/known-providers.ts";
import { en } from "../../messages-en.ts";

describe("parseTokenInput", () => {
  test("裸数字 / k / M 后缀都认；空串 = 继承", () => {
    assert.equal(parseTokenInput("128000"), 128_000);
    assert.equal(parseTokenInput(" 128k "), 128_000);
    assert.equal(parseTokenInput("1M"), 1_000_000);
    assert.equal(parseTokenInput("0.5m"), 500_000);
    assert.equal(parseTokenInput(""), undefined);
    assert.equal(parseTokenInput("   "), undefined);
  });

  test("负号 / 杂字符 / NaN 都拒成 invalid，不静默当 0", () => {
    for (const bad of ["-128k", "abc", "12x", "1 000", "."]) {
      assert.equal(parseTokenInput(bad), "invalid", `应拒绝 ${bad}`);
    }
  });
});

describe("parseRateInput", () => {
  test("非负数放行；空 = 继承；负数 / 杂字符 = invalid", () => {
    assert.equal(parseRateInput("0.28"), 0.28);
    assert.equal(parseRateInput("0"), 0);
    assert.equal(parseRateInput(""), undefined);
    assert.equal(parseRateInput("-1"), "invalid");
    assert.equal(parseRateInput("$0.28"), "invalid");
  });
});

describe("mergeModelCost", () => {
  const meta = {
    id: "m",
    contextWindow: 204_800,
    maxTokens: 8192,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.2 },
  };

  test("两档都留空 = 纯继承，整份删掉", () => {
    assert.equal(mergeModelCost(undefined, meta, { input: undefined, output: undefined }), undefined);
  });

  test("只填 input：output 与 cache 两档按 现值 → 目录 → 0 兜住", () => {
    assert.deepEqual(mergeModelCost(undefined, meta, { input: 1.2, output: undefined }), {
      input: 1.2,
      output: 1.5,
      cacheRead: 0.1,
      cacheWrite: 0.2,
    });
  });

  test("已有现值优先于目录；都没有的档落 0（四档齐全才合法）", () => {
    assert.deepEqual(mergeModelCost({ input: 9, output: 8, cacheRead: 7, cacheWrite: 6 }, meta, {
      output: 3,
      input: undefined,
    }), { input: 9, output: 3, cacheRead: 7, cacheWrite: 6 });
    assert.deepEqual(mergeModelCost(undefined, undefined, { input: 0.5, output: undefined }), {
      input: 0.5,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("nextCopyId", () => {
  test("无冲突接 -copy；冲突递增 -copy2 / -copy3", () => {
    assert.equal(nextCopyId(["a", "b"], "deepseek"), "deepseek-copy");
    assert.equal(nextCopyId(["deepseek-copy"], "deepseek"), "deepseek-copy2");
    assert.equal(nextCopyId(["deepseek-copy", "deepseek-copy2"], "deepseek"), "deepseek-copy3");
  });
});

describe("modelContextText —— 生效值 = 用户覆盖 > 推断出的基线", () => {
  /** 推断基线的替身：真实排序由 shared/model-defaults 自己的测试盯 */
  const defaults = (contextWindow: number, source: ModelDefaults["source"]): ModelDefaults => ({
    contextWindow,
    maxTokens: 8192,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source,
  });

  test("用户填了就用用户的，没填用基线", () => {
    assert.equal(
      modelContextText({ id: "m", contextWindow: 1_000_000 }, defaults(204_800, "catalog")).text,
      "1M",
    );
    assert.equal(modelContextText(undefined, defaults(204_800, "catalog")).text, "205k");
    assert.equal(modelContextText(undefined, defaults(256_000, "known")).text, "256k");
  });

  test("fallback 只在真的没人说话时为真——用户填过就不该再报兜底", () => {
    assert.deepEqual(modelContextText(undefined, defaults(128_000, "fallback")), {
      text: "128k",
      fallback: true,
    });
    assert.equal(
      modelContextText({ id: "m", contextWindow: 300_000 }, defaults(128_000, "fallback")).fallback,
      false,
    );
    assert.equal(modelContextText(undefined, defaults(1_000_000, "catalog-family")).fallback, false);
  });
});

describe("modelAcceptsImage —— 图片徽标与弹窗 Inherit 共用一个答案", () => {
  const withInput = (input: ("text" | "image")[]): ModelDefaults => ({
    contextWindow: 128_000,
    maxTokens: 8192,
    input,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    source: "catalog",
  });

  test("用户开关优先；没填时看推断出的模态", () => {
    assert.equal(modelAcceptsImage({ id: "m" }, withInput(["text", "image"])), true);
    assert.equal(modelAcceptsImage({ id: "m" }, withInput(["text"])), false);
    // 用户明确关掉：目录说能看图也不显示（他的网关可能真不支持）
    assert.equal(modelAcceptsImage({ id: "m", vision: false }, withInput(["text", "image"])), false);
    assert.equal(modelAcceptsImage({ id: "m", vision: true }, withInput(["text"])), true);
  });
});

describe("hasCredentials —— nav 状态点与模型菜单共用同一个判定", () => {
  test("api_key 且已存密钥 = true；已存字段为 false 时不能显示已配置", () => {
    assert.equal(hasCredentials({ scheme: "api_key", hasSecret: true, masked: "sk-***" }), true);
    assert.equal(hasCredentials({ scheme: "api_key", hasSecret: false, masked: null }), false);
  });
  test("env 档密钥来自环境变量，恒为 true", () => {
    assert.equal(hasCredentials({ scheme: "env", envKeys: ["OPENAI_API_KEY"] }), true);
  });
  test("none 恒为 false", () => {
    assert.equal(hasCredentials({ scheme: "none" }), false);
  });
});

describe("reorderIds —— 拖拽排序：落到目标行的位置，其余行顺移补位", () => {
  test("a 拖到 c 上：a 占 c 的位置，中间行顺移", () => {
    assert.deepEqual(reorderIds(["a", "b", "c", "d"], "a", "c"), ["b", "c", "a", "d"]);
  });
  test("d 拖到 b 上：d 占 b 的位置，b 挤后一位", () => {
    assert.deepEqual(reorderIds(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"]);
  });
  test("相邻拖动一次到位", () => {
    assert.deepEqual(reorderIds(["a", "b", "c"], "a", "b"), ["b", "a", "c"]);
    assert.deepEqual(reorderIds(["a", "b", "c"], "b", "a"), ["b", "a", "c"]);
  });
  test("from = to 或 id 不在表里：原样返回，不动", () => {
    assert.deepEqual(reorderIds(["a", "b"], "a", "a"), ["a", "b"]);
    assert.deepEqual(reorderIds(["a", "b"], "x", "a"), ["a", "b"]);
    assert.deepEqual(reorderIds(["a", "b"], "a", "x"), ["a", "b"]);
  });
});

describe("modelIdIssue —— 手填模型 id 的形状", () => {
  test("内置目录的每个模型 id 都必须过——校验不能拒绝自家目录的格式", () => {
    for (const provider of KNOWN_PROVIDERS) {
      for (const id of Object.keys(provider.modelParams ?? {})) {
        assert.equal(modelIdIssue(id, en), null, `${provider.id}/${id} 被拦`);
      }
    }
  });

  test("带点号的真实 id 过：glm-5.3、gpt-4.1、claude-3.5-sonnet", () => {
    assert.equal(modelIdIssue("glm-5.3", en), null);
    assert.equal(modelIdIssue("gpt-4.1", en), null);
    assert.equal(modelIdIssue("claude-3.5-sonnet", en), null);
  });

  test("不过：空、大写、以点/短横开头、超长、非法字符", () => {
    assert.notEqual(modelIdIssue("", en), null);
    assert.notEqual(modelIdIssue("GLM-5", en), null);
    assert.notEqual(modelIdIssue(".hidden", en), null);
    assert.notEqual(modelIdIssue("-x", en), null);
    assert.notEqual(modelIdIssue("a".repeat(65), en), null);
    assert.notEqual(modelIdIssue("a b", en), null);
    assert.notEqual(modelIdIssue("a_b", en), null);
  });
});

describe("compactTokens", () => {
  test("整数档抹掉 .0：128000 → 128k，1000000 → 1M，且能原样填回输入框", () => {
    assert.equal(compactTokens(128_000), "128k");
    assert.equal(compactTokens(1_000_000), "1M");
    assert.equal(parseTokenInput(compactTokens(200_000)), 200_000);
  });
});

describe("urlSuffix", () => {
  test("anthropic 协议接 /v1/messages，其余接 /chat/completions", () => {
    assert.equal(urlSuffix("anthropic-messages"), "/v1/messages");
    assert.equal(urlSuffix("openai-completions"), "/chat/completions");
  });
});

describe("connectionDirty", () => {
  const saved = { displayName: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" };
  const draft = { ...saved, apiKey: "" };

  test("原样未动、key 留空：没有改动", () => {
    assert.equal(connectionDirty(draft, saved, null), false);
  });

  test("名称或 URL 改了：有改动", () => {
    assert.equal(connectionDirty({ ...draft, displayName: "GLM" }, saved, null), true);
    assert.equal(connectionDirty({ ...draft, baseUrl: `${saved.baseUrl}/` }, saved, null), true);
  });

  test("粘了新 key：有改动", () => {
    assert.equal(connectionDirty({ ...draft, apiKey: "sk-new" }, saved, null), true);
  });

  test("Show 拉出的已存 key 原样不动不算改动，改一个字才算", () => {
    assert.equal(connectionDirty({ ...draft, apiKey: "sk-old" }, saved, "sk-old"), false);
    assert.equal(connectionDirty({ ...draft, apiKey: "sk-old2" }, saved, "sk-old"), true);
  });
});
