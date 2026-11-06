import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitColumns } from "./slide-columns.ts";

describe("splitColumns —— 安全的分栏写法", () => {
  it("三栏：标题 / 前后文留在普通块里", () => {
    const text = "# 对比\n\n::: columns\n### 左\n甲\n+++\n### 中\n乙\n+++\n### 右\n丙\n:::\n\n结尾";
    const blocks = splitColumns(text);
    assert.deepEqual(blocks.map((b) => b.kind), ["md", "columns", "md"]);
    const cols = blocks[1];
    assert.equal(cols?.kind === "columns" && cols.columns.length, 3);
    assert.deepEqual(cols?.kind === "columns" ? cols.columns.map((c) => c.split("\n")[0]) : [], ["### 左", "### 中", "### 右"]);
    assert.equal(blocks[0]?.kind === "md" && blocks[0].text.trim(), "# 对比");
    assert.equal(blocks[2]?.kind === "md" && blocks[2].text.trim(), "结尾");
  });

  it("没有分栏：原文一块，一字不差", () => {
    const text = "# A\n\n- x\n- y";
    assert.deepEqual(splitColumns(text), [{ kind: "md", text }]);
  });

  it("没收尾的 ::: columns 不吞后面的内容，原样当文字", () => {
    const text = "::: columns\n一\n+++\n二\n\n后面还有一大段";
    const blocks = splitColumns(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.kind === "md" && blocks[0].text, text);
  });

  it("围栏代码块里的 ::: / +++ 不算语法", () => {
    const text = "```\n::: columns\n+++\n:::\n```\n\n::: columns\n甲\n+++\n```\n:::\n```\n:::";
    const blocks = splitColumns(text);
    assert.deepEqual(blocks.map((b) => b.kind), ["md", "columns"]);
    const cols = blocks[1];
    assert.equal(cols?.kind === "columns" && cols.columns.length, 2);
    assert.match(cols?.kind === "columns" ? (cols.columns[1] as string) : "", /:::/);
  });

  it("两栏与 CRLF", () => {
    const blocks = splitColumns("::: columns\r\n左\r\n+++\r\n右\r\n:::\r\n");
    assert.equal(blocks.some((b) => b.kind === "columns" && b.columns.length === 2), true);
  });
});
