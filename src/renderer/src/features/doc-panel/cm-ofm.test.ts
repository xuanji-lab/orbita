import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { codeRanges, standardImages } from "./cm-ofm-code.ts";

function stateOf(doc: string): EditorState {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** 与 build() 同口径：整篇一次算好代码区，再逐行取标准图片 */
function imagesOf(doc: string): { url: string; alt: string; text: string }[] {
  const state = stateOf(doc);
  const code = codeRanges(state, 0, state.doc.length);
  const out: { url: string; alt: string; text: string }[] = [];
  for (let n = 1; n <= state.doc.lines; n += 1) {
    const line = state.doc.line(n);
    const lineCode = code.filter((range) => range.from < line.to + 1 && range.to > line.from);
    for (const image of standardImages(line.text, line.from, lineCode)) out.push({ url: image.url, alt: image.alt, text: state.sliceDoc(image.from, image.to) });
  }
  return out;
}

describe("编辑视图的标准图片 ![](相对路径)", () => {
  it("语法树里图片的 URL 子节点被标成 imageUrl（根因：它在代码集合里，图片分支曾因此永远 continue）", () => {
    const state = stateOf("![](../attachments/x.png)");
    const ranges = codeRanges(state, 0, state.doc.length);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.imageUrl, true);
  });

  it("插图工具写的 ![](../attachments/x.png) 与手写的 ![替代文字](相对路径) 都识别成图片", () => {
    assert.deepEqual(imagesOf("前文\n\n![](../attachments/x.png)\n\n后文"), [{ url: "../attachments/x.png", alt: "", text: "![](../attachments/x.png)" }]);
    assert.deepEqual(
      imagesOf("![替代文字](../资料/图.png) 和 ![](<带 空格.png>)").map((i) => [i.url, i.alt]),
      [
        ["../资料/图.png", "替代文字"],
        ["带 空格.png", ""],
      ],
    );
    assert.equal(imagesOf("![图](a.png \"标题\")")[0]?.url, "a.png");
  });

  it("行内代码 / 围栏里的图片语法不是图片；外链（带协议）图不处理", () => {
    assert.deepEqual(imagesOf("`![](a.png)`"), []);
    assert.deepEqual(imagesOf("```\n![](a.png)\n```"), []);
    assert.deepEqual(imagesOf("![](https://example.com/a.png) ![](data:image/png;base64,AAA)"), []);
  });

  it("普通链接不被当成图片；链接地址里的 URL 仍算代码区（不在地址里认 #锚点）", () => {
    assert.deepEqual(imagesOf("[文字](../a.png) 与 <https://example.com/#x>"), []);
    const state = stateOf("[文字](https://example.com/#x)");
    const ranges = codeRanges(state, 0, state.doc.length);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0]?.imageUrl, false);
  });
});
