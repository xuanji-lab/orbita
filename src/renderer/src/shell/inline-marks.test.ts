import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inlineMarks, inlinePlain } from "./inline-marks.ts";

describe("inlineMarks —— 章节标题里的行内 markdown", () => {
  it("反引号包着的拆成代码段，其余是文字", () => {
    assert.deepEqual(inlineMarks("先看 `Sidebar.tsx` 里分组怎么渲染"), [
      { kind: "text", text: "先看 " },
      { kind: "code", text: "Sidebar.tsx" },
      { kind: "text", text: " 里分组怎么渲染" },
    ]);
  });

  it("一行几段代码、代码打头结尾都行", () => {
    assert.deepEqual(inlineMarks("`a` 和 `b`"), [
      { kind: "code", text: "a" },
      { kind: "text", text: " 和 " },
      { kind: "code", text: "b" },
    ]);
  });

  it("粗体记号剥掉，不留星号；代码段里的星号不动", () => {
    assert.deepEqual(inlineMarks("**重大发现**：`a**b` 被覆盖"), [
      { kind: "text", text: "重大发现：" },
      { kind: "code", text: "a**b" },
      { kind: "text", text: " 被覆盖" },
    ]);
    assert.equal(inlinePlain("__注意__ 这里"), "注意 这里");
  });

  it("不配对的反引号原样留着，不吞后文", () => {
    assert.deepEqual(inlineMarks("用 ` 分隔"), [{ kind: "text", text: "用 ` 分隔" }]);
  });

  it("纯文本原样一段；空串没有段", () => {
    assert.deepEqual(inlineMarks("跑一遍检查"), [{ kind: "text", text: "跑一遍检查" }]);
    assert.deepEqual(inlineMarks(""), []);
  });
});
