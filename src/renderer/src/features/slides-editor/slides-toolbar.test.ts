import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("./slides-editor.css", import.meta.url), "utf8");
const editor = readFileSync(new URL("./SlidesEditor.tsx", import.meta.url), "utf8");

function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `找不到规则 ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

describe("演示文稿工具条：窄面板（420）也是单行", () => {
  it(".se-bar 不折行，子项不被挤扁", () => {
    assert.match(ruleBody(".se-bar"), /flex-wrap:\s*nowrap/);
    assert.match(ruleBody(".se-bar > *"), /flex-shrink:\s*0/);
  });

  it("三档：≤800 只留图标，≤560 导出 / 比例·主题 / 缩放收进「…」，且 560 档够 420 的面板放下", () => {
    assert.match(css, /@container dp \(max-width: 800px\) \{\s*\.se-tool-label \{\s*display: none/);
    const narrow = /@container dp \(max-width: (\d+)px\) \{\s*\.se-bar-wide \{\s*display: none/.exec(css);
    assert.ok(narrow !== null && Number(narrow[1]) >= 420 && Number(narrow[1]) < 800);
    assert.match(ruleBody(".se-bar-more"), /display:\s*none/);
    assert.match(ruleBody(".se-bar-wide"), /display:\s*contents/);
  });

  it("「…」菜单与平铺是同一批动作：导出、比例、主题、缩放", () => {
    assert.match(editor, /className="se-bar-more"/);
    for (const part of ["...exportMenuItems", "...aspectItems", "...themeItems", "...zoomItems"]) assert.ok(editor.includes(part), part);
  });
});
