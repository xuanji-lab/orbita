import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ModelDecl } from "@shared/provider";
import { buildModelDecl, contextWindowWarning, parseCostRates, parseOverrideNumber } from "./model-meta.ts";

describe("parseOverrideNumber —— 空串不覆盖", () => {
  test("空与空白 → undefined；数字串 → 数值（容忍首尾空白）", () => {
    assert.equal(parseOverrideNumber(""), undefined);
    assert.equal(parseOverrideNumber("   "), undefined);
    assert.equal(parseOverrideNumber("160000"), 160000);
    assert.equal(parseOverrideNumber(" 160000 "), 160000);
  });

  test("非法串得 NaN——合法性由 upsert 校验层拦，这里只管读", () => {
    assert.ok(Number.isNaN(parseOverrideNumber("abc")));
  });
});

describe("parseCostRates —— 四格费率", () => {
  test("全空 → undefined（整份撤掉覆盖，用目录/兜底价）", () => {
    assert.equal(parseCostRates({ input: "", output: "", cacheRead: "", cacheWrite: "" }), undefined);
  });

  test("填一格其余按 0 计——明确报价，不把没填的冒充成免费", () => {
    assert.deepEqual(parseCostRates({ input: "0.6", output: "", cacheRead: "", cacheWrite: "" }), {
      input: 0.6,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("buildModelDecl —— 本地输入拼回覆盖声明", () => {
  const base: ModelDecl = { id: "step-3.7-flash", name: "step-3.7-flash" };

  test("全空只剩 id + name（覆盖全撤）", () => {
    assert.deepEqual(
      buildModelDecl(base, { ctx: "", maxOut: "", rates: { input: "", output: "", cacheRead: "", cacheWrite: "" } }),
      { id: "step-3.7-flash", name: "step-3.7-flash" },
    );
  });

  test("填了的字段才落，没填的不出现（不写显式 undefined）", () => {
    const decl = buildModelDecl(base, {
      ctx: "160000",
      maxOut: "",
      rates: { input: "0.6", output: "", cacheRead: "", cacheWrite: "" },
    });
    assert.deepEqual(decl, {
      id: "step-3.7-flash",
      name: "step-3.7-flash",
      contextWindow: 160000,
      cost: { input: 0.6, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    assert.equal("maxTokens" in decl, false);
  });
});

describe("contextWindowWarning —— 过小窗口防呆", () => {
  test("没填（用目录/兜底）与 ≥40k 不警示", () => {
    assert.equal(contextWindowWarning(undefined), null);
    assert.equal(contextWindowWarning(40_000), null);
    assert.equal(contextWindowWarning(160_000), null);
  });

  test("低于 40k 警示——26000 正是那次「思考两个字就截止」的事故值", () => {
    const warning = contextWindowWarning(26_000);
    assert.ok(warning !== null);
    assert.match(warning, /26k/);
  });
});
