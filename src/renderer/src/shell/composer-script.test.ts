import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { composerScript } from "./composer-script.ts";

describe("composerScript", () => {
  it("以英文为主算拉丁，取消一字一格的字距", () => {
    deepStrictEqual(composerScript("cjk", "Please check how pi resizes images before sending them.", false), "latin");
    deepStrictEqual(composerScript("cjk", "The 输入框 looks wrong when the prompt is mostly English.", false), "latin");
  });

  // 第二张截图那样的输入：中文句子里夹 click to enlarge、image resize，仍按格排
  it("中文里夹英文词仍算中文", () => {
    deepStrictEqual(
      composerScript("latin", "刚刚测试的时候，我 click to enlarge，enlarge 的那个图片很糊，这个我们用的 pi 的这个 image resize 的逻辑是什么样的？", false),
      "cjk",
    );
  });

  it("没有字母的输入按中文排：空输入框（占位文字是中文）、纯数字与标点", () => {
    deepStrictEqual(composerScript("latin", "", false), "cjk");
    deepStrictEqual(composerScript("latin", "12345 · —", false), "cjk");
    deepStrictEqual(composerScript("latin", "   ", false), "cjk");
  });

  // 拼音字母在组词期间就进了 value：不冻住的话，空输入框打第一个中文词时会先按英文排
  it("输入法组词期间沿用上一次的结果", () => {
    deepStrictEqual(composerScript("cjk", "women", true), "cjk");
    deepStrictEqual(composerScript("latin", "Fix the bug in 我们", true), "latin");
  });

  it("组词结束后按上屏的内容重新判", () => {
    deepStrictEqual(composerScript("cjk", "我们", false), "cjk");
    deepStrictEqual(composerScript("cjk", "women", false), "latin");
  });
});
