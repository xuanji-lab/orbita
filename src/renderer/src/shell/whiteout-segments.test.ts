import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { WHITEOUT_MAX_LENGTH, whiteoutSegments } from "./whiteout-segments.ts";

const plain = (text: string) => ({ text, whiteout: false });
const white = (text: string) => ({ text, whiteout: true });

describe("whiteoutSegments", () => {
  it("中文里的英文词一段一块", () => {
    deepStrictEqual(whiteoutSegments("给orbita开发browser功能"), [
      plain("给"),
      white("orbita"),
      plain("开发"),
      white("browser"),
      plain("功能"),
    ]);
  });

  it("段内空格一起涂，两头的空白与全角标点不涂", () => {
    deepStrictEqual(whiteoutSegments("我 click to enlarge，好"), [
      plain("我 "),
      white("click to enlarge"),
      plain("，好"),
    ]);
  });

  it("不跨行", () => {
    deepStrictEqual(whiteoutSegments("hello\nworld"), [white("hello"), plain("\n"), white("world")]);
  });

  it("数字算，只有标点的一段不算", () => {
    deepStrictEqual(whiteoutSegments("稻草人 249 格"), [plain("稻草人 "), white("249"), plain(" 格")]);
    deepStrictEqual(whiteoutSegments("他说——“好”"), [plain("他说——“好”")]);
  });

  it("整段英文整段涂", () => {
    deepStrictEqual(whiteoutSegments("Fix the resize bug."), [white("Fix the resize bug.")]);
  });

  // 拼音字母在组词期间就进了 value：这一截不涂，上屏成汉字后自然也不涂
  it("组词中的一截不涂", () => {
    deepStrictEqual(whiteoutSegments("我们women", { start: 2, end: 7 }), [plain("我们women")]);
  });

  it("组词排除后剩下的英文照涂，剩下的空白不涂", () => {
    deepStrictEqual(whiteoutSegments("fix bug wo", { start: 8, end: 10 }), [white("fix bug"), plain(" wo")]);
  });

  it("空输入没有段；太长的输入整段不涂", () => {
    deepStrictEqual(whiteoutSegments(""), []);
    const long = "a".repeat(WHITEOUT_MAX_LENGTH + 1);
    deepStrictEqual(whiteoutSegments(long), [plain(long)]);
  });

  it("各段拼回去就是原文", () => {
    const text = "  我们来计划一下给orbita开发。\n\nagent in browser 之前 v2.1 有没有留计划？  ";
    deepStrictEqual(whiteoutSegments(text).map((segment) => segment.text).join(""), text);
  });
});
