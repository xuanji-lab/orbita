import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./doc-panel.css", import.meta.url), "utf8");
const pane = readFileSync(new URL("./DocEditPane.tsx", import.meta.url), "utf8");

/** 取出某个选择器的第一个规则体 */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `找不到规则 ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

describe("文档工具栏：窄面板也是单行", () => {
  it(".dp-bar 不折行", () => {
    const body = ruleBody(".dp-bar");
    assert.match(body, /flex-wrap:\s*nowrap/);
    assert.doesNotMatch(body, /flex-wrap:\s*wrap\b/);
  });

  it("窄档：先收成图标（隐藏文字标签），再把纸面 / 插图 / 导出收进「…」", () => {
    assert.match(css, /@container dp \(max-width: \d+px\) \{[^@]*\.dp-act-label \{\s*display: none/);
    assert.match(css, /\.dp-bar-wide \{\s*display: none/);
    assert.match(css, /\.dp-bar-more \{\s*display: inline-flex/);
    // 默认（够宽）时「…」不显示、平铺组不占自己的盒子
    assert.match(ruleBody(".dp-bar-more"), /display:\s*none/);
    assert.match(ruleBody(".dp-bar-wide"), /display:\s*contents/);
  });

  it("编辑视图多一组格式键，收起阈值比阅读视图宽", () => {
    const edit = /@container dp \(max-width: (\d+)px\) \{\s*\.dp\[data-view="edit"\] \.dp-bar-wide/.exec(css);
    const read = /@container dp \(max-width: (\d+)px\) \{\s*\.dp\[data-view="read"\] \.dp-bar-wide/.exec(css);
    assert.ok(edit !== null && read !== null);
    assert.ok(Number(edit[1]) > Number(read[1]));
  });

  it("「…」菜单与平铺组装的是同一批动作（纸面 / 插图 / 导出四种格式）", () => {
    assert.match(pane, /className="dp-bar-more"/);
    for (const id of ["insert-image", "export-docx", "export-pdf", "export-md", "export-md-plain"]) {
      // 导出项 id 由格式 id 前缀拼出，这里直接核对格式清单与前缀逻辑
      if (id.startsWith("export-")) assert.match(pane, new RegExp(`id: "${id.slice(7)}"`));
      else assert.match(pane, new RegExp(`id: "${id}"`));
    }
    assert.match(pane, /id: `export-\$\{item\.id\}`/);
  });
});
