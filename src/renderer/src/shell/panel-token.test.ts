import { deepStrictEqual, equal } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LONG_PRESS_MS,
  LONG_PRESS_MOVE_TOLERANCE_PX,
  decodeTokenPayload,
  diffInsertion,
  encodeTokenPayload,
  insertToken,
  longPressArmed,
  mcpToken,
  skillToken,
  slashSpaceOpensPanel,
} from "./panel-token.ts";

describe("skillToken / mcpToken", () => {
  it("带尾随空格（与 replaceToken 插入指令同款）", () => {
    equal(skillToken("orbita-always-open-pr"), "/skill:orbita-always-open-pr ");
    equal(mcpToken("miyo"), "/mcp:miyo ");
  });
});

describe("encodeTokenPayload / decodeTokenPayload", () => {
  it("roundtrip", () => {
    const payload = { kind: "skill" as const, token: skillToken("a") };
    deepStrictEqual(decodeTokenPayload(encodeTokenPayload(payload)), payload);
  });
  it("坏负载一律 null，不抛异常", () => {
    equal(decodeTokenPayload(null), null);
    equal(decodeTokenPayload(""), null);
    equal(decodeTokenPayload("not json"), null);
    equal(decodeTokenPayload("42"), null);
    equal(decodeTokenPayload('{"kind":"other","token":"/x "}'), null);
    equal(decodeTokenPayload('{"kind":"skill","token":"x "}'), null);
    equal(decodeTokenPayload('{"kind":"mcp"}'), null);
  });
});

describe("insertToken", () => {
  it("句中插入：前后都补空格，光标落在尾随空格后；text 是实际插入段（execCommand 用）", () => {
    deepStrictEqual(insertToken("helloworld", 5, "/skill:x "), {
      value: "hello /skill:x world",
      cursor: 5 + " /skill:x ".length,
      text: " /skill:x ",
    });
  });
  it("行首 / 空白后：不补前导空格", () => {
    equal(insertToken("world", 0, "/skill:x ").value, "/skill:x world");
    equal(insertToken("先跑 world", 3, "/skill:x ").value, "先跑 /skill:x world");
  });
  it("前一个字符已是空白：不补前导", () => {
    equal(insertToken("hello world", 6, "/mcp:m ").value, "hello /mcp:m world");
  });
  it("落点后已是空白：省掉尾随空格，不叠双空格", () => {
    equal(insertToken("hello world", 5, "/mcp:m ").value, "hello /mcp:m world");
    // 前面已是空白 + 后面已有空白：前后都不补，原有空白保留
    equal(insertToken("a  b", 2, "/x ").value, "a /x b");
  });
  it("文末：保留尾随空格（继续打字不用补间隔），光标在空格后", () => {
    deepStrictEqual(insertToken("hello", 5, "/skill:x "), {
      value: "hello /skill:x ",
      cursor: "hello /skill:x ".length,
      text: " /skill:x ",
    });
    deepStrictEqual(insertToken("", 0, "/skill:x "), {
      value: "/skill:x ",
      cursor: "/skill:x ".length,
      text: "/skill:x ",
    });
  });
  it("position 越界夹回 [0, len]", () => {
    equal(insertToken("abc", -3, "/x ").value, "/x abc");
    equal(insertToken("abc", 99, "/x ").value, "abc /x ");
  });
  it("尾随全角空格也算空白，省掉尾随空格", () => {
    equal(insertToken("你好\u3000世界", 2, "/x ").value, "你好 /x\u3000世界");
  });
});

describe("diffInsertion", () => {
  it("找出原生 drop 的插入点", () => {
    deepStrictEqual(diffInsertion("helloworld", "hello/skill:x world", "/skill:x "), {
      start: 5,
      end: 5 + "/skill:x ".length,
    });
  });
  it("重复文本下贪婪前缀会把插入点切在最靠后的等价位置，内容对得上即可", () => {
    // aaaa 中插入 aa：贪婪前缀吃到第 4 位，插入段仍是 aa（等价插入点）
    deepStrictEqual(diffInsertion("aaaa", "aaaaaa", "aa"), { start: 4, end: 6 });
  });
  it("内容 / 长度对不上返回 null（等待态自愈的钥匙）", () => {
    equal(diffInsertion("abc", "abcd", "/x "), null);
    equal(diffInsertion("abc", "abc/x y", "/x "), null);
    equal(diffInsertion("abc", "abXc", "/x "), null);
  });
});

describe("slashSpaceOpensPanel", () => {
  it("消息开头孤立的 /：返回 / 的下标", () => {
    equal(slashSpaceOpensPanel("/", 1), 0);
    equal(slashSpaceOpensPanel("  /", 3), 2);
    equal(slashSpaceOpensPanel("\n/", 2), 1);
    equal(slashSpaceOpensPanel("\u3000/", 2), 1);
  });
  it("句中的 / 不触发：「a / b」是普通文字", () => {
    equal(slashSpaceOpensPanel("a /", 3), null);
    equal(slashSpaceOpensPanel("a / b", 3), null);
    equal(slashSpaceOpensPanel("第一行\n/", 6), null);
    equal(slashSpaceOpensPanel("先按住 /", 5), null);
  });
  it("/ 后已打出内容、光标不在 / 紧后、停在 / 上：都不触发", () => {
    equal(slashSpaceOpensPanel("/c", 2), null);
    equal(slashSpaceOpensPanel("/c ", 3), null);
    equal(slashSpaceOpensPanel("/", 0), null);
    equal(slashSpaceOpensPanel("普通文字", 4), null);
    equal(slashSpaceOpensPanel("", 0), null);
  });
});

describe("longPressArmed", () => {
  it("时长与位移双闸", () => {
    equal(longPressArmed(LONG_PRESS_MS - 1, 0), false);
    equal(longPressArmed(LONG_PRESS_MS, 0), true);
    equal(longPressArmed(LONG_PRESS_MS, LONG_PRESS_MOVE_TOLERANCE_PX), true);
    equal(longPressArmed(LONG_PRESS_MS, LONG_PRESS_MOVE_TOLERANCE_PX + 0.5), false);
    equal(longPressArmed(LONG_PRESS_MS + 5000, LONG_PRESS_MOVE_TOLERANCE_PX + 1), false);
  });
});
