import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentClipped, pageCaption, splitColumns } from "./slide-columns.ts";

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

describe("pageCaption —— 缩略图下的标题", () => {
  it("取第一个非空行，去掉标题 / 列表 / 引用标记与行内记号；空页返回空串", () => {
    assert.equal(pageCaption("\n\n# **插件**是什么\n正文"), "插件是什么");
    assert.equal(pageCaption("- 要点一"), "要点一");
    assert.equal(pageCaption("> 引语"), "引语");
    assert.equal(pageCaption("   \n  "), "");
  });
});

describe("contentClipped —— 只有真被裁的页才点名（S1）", () => {
  // 页体 720 高、下内边距 64：内容底在 700（落进下内边距，但还在页体里）= 没被裁
  it("内容落进下内边距、没出页体：不算被裁（原先 scrollHeight 判据会误报）", () => {
    assert.equal(contentClipped(700, 720), false);
    assert.equal(contentClipped(720, 720), false);
    assert.equal(contentClipped(720.8, 720), false, "亚像素误差不算");
  });
  it("内容的最低一点超出页体底边：被裁", () => {
    assert.equal(contentClipped(722.5, 720), true);
    assert.equal(contentClipped(900, 720), true);
  });
  it("缩放后的坐标同样成立（容差随调用方给）", () => {
    assert.equal(contentClipped(288.4, 288, 1), false);
    assert.equal(contentClipped(290, 288, 1), true);
  });
});
