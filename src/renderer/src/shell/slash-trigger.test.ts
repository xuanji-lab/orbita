import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { replaceFirstLine, slashMode, slashQuery } from "./slash-trigger.ts";

describe("slashQuery", () => {
  it("首字符是 / 时返回过滤词（小写、去空白）", () => {
    deepStrictEqual(slashQuery("/", 1), "");
    deepStrictEqual(slashQuery("/Com", 4), "com");
    deepStrictEqual(slashQuery("/new ", 5), "new");
  });

  it("允许前导空白（Gemini 规则）", () => {
    deepStrictEqual(slashQuery("  /com", 6), "com");
    deepStrictEqual(slashQuery("\t/new", 5), "new");
  });

  it("多行输入只看第一行：后续行不影响指令模式", () => {
    // 旧实现含 \n 就整个不弹——这是本次修掉的主缺陷
    deepStrictEqual(slashQuery("/com\n附加说明", 4), "com");
    deepStrictEqual(slashQuery("/\n第二行", 1), "");
  });

  it("光标在后续行上时不触发：方向键要还给文本编辑", () => {
    // "/com" 长 4，光标 5 起在第二行
    deepStrictEqual(slashQuery("/com\n附加说明", 5), null);
    deepStrictEqual(slashQuery("/com\n附加说明", 8), null);
  });

  it("光标在第一行末尾（换行符之前）仍触发", () => {
    deepStrictEqual(slashQuery("/com\n附加说明", 4), "com");
  });

  it("非 / 开头与 // 注释不触发", () => {
    deepStrictEqual(slashQuery("", 0), null);
    deepStrictEqual(slashQuery("hello/world", 5), null);
    deepStrictEqual(slashQuery("// 注释", 4), null);
    deepStrictEqual(slashQuery("hello\n/com", 8), null);
  });
});

describe("slashMode", () => {
  it("第一行是 / 前缀即在指令模式，与光标无关", () => {
    deepStrictEqual(slashMode("/com\n附加说明"), true);
    deepStrictEqual(slashMode("  /new"), true);
    deepStrictEqual(slashMode("// 注释"), false);
    deepStrictEqual(slashMode("hello\n/com"), false);
  });
});

describe("replaceFirstLine", () => {
  it("单行整体替换（旧行为不变）", () => {
    deepStrictEqual(replaceFirstLine("/c", "/skill:code-review "), "/skill:code-review ");
  });

  it("多行只替换第一行（连同前导空白），其余行保留", () => {
    deepStrictEqual(replaceFirstLine("  /c\n附加说明", "/skill:code-review "), "/skill:code-review \n附加说明");
  });
});
