import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { documentHtml, markdownToHtmlBody } from "./doc-html.ts";

const OFM = [
  "---",
  "tags: [周报]",
  "---",
  "# 周报",
  "",
  "见 [[页|别名]]，==亮== #标签 <script>alert(1)</script>",
  "",
  "![[a.png]] ![](rel/b.png) ![[丢了.png]] ![x](https://e.com/t.png)",
  "",
  "> [!warning] 风险",
  "> 内容",
  "",
  "> [!tip]- 折叠",
  "> 里面",
  "",
  "> [!custom] 自定义",
  "> 内容",
  "",
  "```",
  "[[不转]] ==不转==",
  "```",
].join("\n");

describe("文档 → HTML（PDF 导出用）", () => {
  it("OFM 元素都有渲染：属性表、双链、高亮、标签、提醒框（折叠的强制展开、自定义类型当 note）", async () => {
    const body = await markdownToHtmlBody(OFM, async (target) => (target === "a.png" || target === "rel/b.png" ? "data:image/png;base64,AAAA" : null));
    assert.match(body, /<div class="ofm-properties">/);
    assert.match(body, /<span class="ofm-tag"[^>]*>#周报<\/span>/);
    assert.match(body, /<a class="ofm-wikilink"[^>]*>别名<\/a>/);
    assert.match(body, /<mark class="ofm-mark">亮<\/mark>/);
    assert.match(body, /<div class="callout"[^>]*data-callout="warning"[^>]*data-kind="warning"/);
    assert.match(body, /<details class="callout" open[^>]*data-callout="tip"/);
    assert.match(body, /data-callout="note"[\s\S]*?自定义/);
    // 代码块里的不转换
    assert.match(body, /\[\[不转\]\] ==不转==/);
  });

  it("图片：读到的内联成 data URL；读不到 / 远程图是占位文字，不留会联网的 img", async () => {
    const body = await markdownToHtmlBody(OFM, async (target) => (target === "a.png" ? "data:image/png;base64,AAAA" : null));
    assert.equal((body.match(/<img /g) ?? []).length, 1);
    assert.match(body, /src="data:image\/png;base64,AAAA"/);
    assert.match(body, /<span class="ofm-missing">\[丢了\.png\]<\/span>/);
    assert.match(body, /<span class="ofm-missing">\[b\.png\]<\/span>/);
    assert.equal(body.includes("https://e.com/t.png"), false);
  });

  it("原始 HTML 不放行：script 标签成了文字，页面带 CSP", async () => {
    const body = await markdownToHtmlBody(OFM);
    assert.equal(body.includes("<script"), false);
    const page = documentHtml("t<>", body);
    assert.match(page, /Content-Security-Policy/);
    assert.match(page, /<title>t&lt;&gt;<\/title>/);
  });
});
