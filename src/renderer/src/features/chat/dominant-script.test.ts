import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dominantScript } from "./dominant-script.ts";

describe("dominantScript", () => {
  test("中文句子夹英文术语、路径、数字仍算中文为主", () => {
    assert.equal(dominantScript("把规划要素的「影响半径」做成明示数值参数（星露谷）：稻草人 249 格"), "cjk");
    assert.equal(dominantScript("Token 层：globals.css 是唯一数据源"), "cjk");
    assert.equal(dominantScript("Chap3 的 L1 若给每个政策/设施标注影响范围，布局行为本身即成可比较数据"), "cjk");
  });

  test("英文、英文里偶尔一两个汉字、没有字母的都算拉丁", () => {
    assert.equal(dominantScript("Set in motion, kept in order."), "latin");
    assert.equal(dominantScript("The 小学作业 theme is a green-grid exercise book with red pen marks for bold text."), "latin");
    assert.equal(dominantScript("12345 · —"), "latin");
    assert.equal(dominantScript(""), "latin");
  });
});
