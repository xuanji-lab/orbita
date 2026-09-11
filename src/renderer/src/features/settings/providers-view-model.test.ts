import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  mergeModelCost,
  modelContextText,
  nextCopyId,
  parseRateInput,
  parseTokenInput,
  reorderIds,
} from "./providers-view-model.ts";

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

describe("modelContextText —— 生效值 = 用户覆盖 > 目录 > 白名单 > 兜底", () => {
  test("四级依次兜底", () => {
    assert.equal(modelContextText({ id: "m", contextWindow: 1_000_000 }, undefined).text, "1M");
    assert.equal(
      modelContextText(
        undefined,
        { id: "m", contextWindow: 204_800, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      ).text,
      "205k",
    );
    assert.equal(modelContextText(undefined, undefined, { contextWindow: 256_000 }).text, "256k");
    assert.deepEqual(modelContextText(undefined, undefined), { text: "128k", fallback: true });
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
