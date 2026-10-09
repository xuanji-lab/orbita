import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { replaceToken, slashMode, slashTokenAt } from "./slash-trigger.ts";

describe("slashTokenAt", () => {
  it("消息开头的 /：主模式，query 是 / 与光标之间的部分（小写）", () => {
    deepStrictEqual(slashTokenAt("/", 1), { start: 0, end: 1, query: "", atMessageStart: true });
    deepStrictEqual(slashTokenAt("/Com", 4), { start: 0, end: 4, query: "com", atMessageStart: true });
    // 前导空白：仍算消息开头（PR #146 语义）
    deepStrictEqual(slashTokenAt("  /com", 6), { start: 2, end: 6, query: "com", atMessageStart: true });
    // 多行：第一行的 token 不受后续行影响
    deepStrictEqual(slashTokenAt("/com\n附加说明", 4), { start: 0, end: 4, query: "com", atMessageStart: true });
  });

  it("句中（空白后）的 /：补全模式，全角空格与换行也是边界", () => {
    deepStrictEqual(slashTokenAt("先跑测试 /pon", 9), {
      start: 5,
      end: 9,
      query: "pon",
      atMessageStart: false,
    });
    deepStrictEqual(slashTokenAt("先跑\u3000/", 4), { start: 3, end: 4, query: "", atMessageStart: false });
    deepStrictEqual(slashTokenAt("第一行\n/pon", 8), { start: 4, end: 8, query: "pon", atMessageStart: false });
  });

  it("光标不在 token 上：越过空白、停在 / 上、越界、普通文字，都是 null", () => {
    deepStrictEqual(slashTokenAt("/com 附加", 5), null); // 越过 token 后的空白
    deepStrictEqual(slashTokenAt("/com", 0), null); // 停在 / 上（插入点在 / 之前）
    deepStrictEqual(slashTokenAt("普通文字", 4), null);
    deepStrictEqual(slashTokenAt("", 0), null);
  });

  it("路径防误触·前导空白闸：Windows 盘符（两种斜杠）、UNC、URL 都不触发", () => {
    deepStrictEqual(slashTokenAt("看下 C:\\Users\\dama\\x.md", 22), null);
    deepStrictEqual(slashTokenAt("看下 C:/Users/dama/x.md", 21), null);
    deepStrictEqual(slashTokenAt("看下 \\\\server\\share\\x.md", 22), null);
    deepStrictEqual(slashTokenAt("访问 https://a.com/b", 18), null);
  });

  it("路径防误触·字符集闸：POSIX 绝对路径打出第二个 / 即判非指令", () => {
    // 裸 /（打完 / 还没打字母）：token 在——全列表弹窗是可发现性（Claude Code 同款）；
    // 打到 t / tm 时 token 仍在（有没有命中是面板层的第三道闸），打到 / 才咬死
    deepStrictEqual(slashTokenAt("看下 /tmp/notes.md", 4), {
      start: 3,
      end: 16,
      query: "",
      atMessageStart: false,
    });
    deepStrictEqual(slashTokenAt("看下 /tmp/notes.md", 5)?.query, "t");
    deepStrictEqual(slashTokenAt("看下 /tmp/notes.md", 8), null); // "tmp/"——/ 不在字符集
    deepStrictEqual(slashTokenAt("看下 /Users/dama/x.md", 10), null);
  });

  it("行首 // 注释与手打全形态 /skill:xxx 都不算（字符集闸）", () => {
    deepStrictEqual(slashTokenAt("// 注释", 2), null);
    deepStrictEqual(slashTokenAt("/skill:pony 说明", 11), null);
  });

  it("中文紧贴 / 不触发（与 Claude Code 同款：要求空白边界）", () => {
    deepStrictEqual(slashTokenAt("看下/pony 文件", 6), null);
  });
});

describe("replaceToken", () => {
  it("只替换 token 本身：同行后续文字与后续行都保留", () => {
    const token = slashTokenAt("/c 附加说明", 2);
    deepStrictEqual(
      token !== null ? replaceToken("/c 附加说明", token, "/skill:code-review ") : "token 为 null",
      "/skill:code-review 附加说明",
    );
  });
  it("句中补全：替换的是整个 token（光标在 token 中间也替换到词尾）", () => {
    const value = "先读 /po 再重构";
    const token = slashTokenAt(value, 6);
    deepStrictEqual(
      token !== null ? replaceToken(value, token, "/skill:ponytail ") : "token 为 null",
      "先读 /skill:ponytail 再重构",
    );
  });
});

describe("replaceToken 的尾随空格", () => {
  it("token 在行尾：插入串的尾随空格保留，光标落在空格后可直接接着打", () => {
    const value = "先读 /po";
    const token = slashTokenAt(value, value.length);
    deepStrictEqual(
      token !== null ? replaceToken(value, token, "/skill:ponytail ") : "token 为 null",
      "先读 /skill:ponytail ",
    );
  });
});

describe("slashMode", () => {
  it("第一行以 / 开头（允许前导空白）即在主模式可能域，// 除外", () => {
    deepStrictEqual(slashMode("/com\n附加说明"), true);
    deepStrictEqual(slashMode("  /new"), true);
    deepStrictEqual(slashMode("// 注释"), false);
    deepStrictEqual(slashMode("hello\n/com"), false);
  });
});
