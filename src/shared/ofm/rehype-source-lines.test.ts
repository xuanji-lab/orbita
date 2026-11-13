import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import { rehypeSourceLines } from "./rehype-source-lines.ts";

async function render(md: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSourceLines)
    .use(rehypeStringify)
    .process(md);
  return String(file);
}

describe("rehypeSourceLines", () => {
  it("段落 / 标题 / 列表项 / 代码块 / 表格行带上源码起止行（1 起）", async () => {
    const html = await render("# 标题\n\n段落\n\n- 一\n- 二\n\n```js\nlet a;\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
    assert.match(html, /<h1 data-sl="1" data-el="1">/);
    assert.match(html, /<p data-sl="3" data-el="3">段落<\/p>/);
    assert.match(html, /<li data-sl="5" data-el="5">一<\/li>/);
    assert.match(html, /<li data-sl="6" data-el="6">二<\/li>/);
    assert.match(html, /<pre data-sl="8" data-el="10">/);
    assert.match(html, /<tr data-sl="12" data-el="12">/);
    assert.match(html, /<tr data-sl="14" data-el="14">/);
  });

  it("行内元素与表格本体不标", async () => {
    const html = await render("文字 **粗** 与 [链](http://a.b)\n");
    assert.doesNotMatch(html, /<strong data-sl/);
    assert.doesNotMatch(html, /<a [^>]*data-sl/);
  });
});
