import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, rateInputText, shownAmount, usdOf } from "./money.ts";

const CNY = { symbol: "¥", perUsd: 6.718 };
const USD = { symbol: "$", perUsd: 1 };

describe("花费的显示币种：数据是美元，显示时按界面语言换算", () => {
  test("人民币：按汇率换算，≥ 1 两位小数、< 1 两位有效数字、0 写 0", () => {
    assert.equal(formatMoney(10, CNY), "¥67.18");
    assert.equal(formatMoney(0.03, CNY), "¥0.20");
    assert.equal(formatMoney(0, CNY), "¥0");
  });

  test("美元原样", () => {
    assert.equal(formatMoney(1.5, USD), "$1.50");
    assert.equal(formatMoney(0.031, USD), "$0.031");
  });

  test("弹窗单价：换算后最多四位小数；填进来的人民币换回美元，原样换算回去不走样", () => {
    // DeepSeek V4.1 Flash 峰时输入价 $0.3 / M
    assert.equal(rateInputText(0.3, CNY), "2.0154");
    assert.equal(rateInputText(1.2, USD), "1.2");
    const usd = usdOf(2, CNY);
    assert.equal(rateInputText(usd, CNY), "2");
    assert.ok(Math.abs(shownAmount(usdOf(13.5, CNY), CNY) - 13.5) < 1e-12);
  });
});
