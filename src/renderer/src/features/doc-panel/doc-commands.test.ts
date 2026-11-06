import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { insertParagraph, insertSoftBreak } from "./doc-commands.ts";

/** 够命令用的假 view：只有 state 与 dispatch（命令不碰 DOM） */
function fake(doc: string, anchor: number): { view: EditorView; text: () => string; cursor: () => number } {
  const holder = { state: EditorState.create({ doc, selection: { anchor }, extensions: [markdown({ base: markdownLanguage })] }) };
  const view = {
    get state() {
      return holder.state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      holder.state = holder.state.update(spec).state;
    },
  } as unknown as EditorView;
  return { view, text: () => holder.state.doc.toString(), cursor: () => holder.state.selection.main.head };
}

describe("回车 = 新段落（M2）", () => {
  it("普通段落末尾：写成空行分隔，光标在新段开头", () => {
    const f = fake("第一段", 3);
    insertParagraph(f.view);
    assert.equal(f.text(), "第一段\n\n");
    assert.equal(f.cursor(), 5);
  });

  it("段落中间回车：拆成两段", () => {
    const f = fake("前半后半", 2);
    insertParagraph(f.view);
    assert.equal(f.text(), "前半\n\n后半");
  });

  it("Shift+回车：段内换行（两个空格 + 换行）", () => {
    const f = fake("甲乙", 1);
    insertSoftBreak(f.view);
    assert.equal(f.text(), "甲  \n乙");
  });

  it("列表项里：接着开下一项；有序列表编号 +1；空项再回车退出列表", () => {
    const a = fake("- 一项", 4);
    insertParagraph(a.view);
    assert.equal(a.text(), "- 一项\n- ");
    insertParagraph(a.view);
    assert.equal(a.text(), "- 一项\n");
    const b = fake("1. 第一步", 6);
    insertParagraph(b.view);
    assert.equal(b.text(), "1. 第一步\n2. ");
  });

  it("围栏代码块里：普通换行", () => {
    const text = "```\nconst a = 1;";
    const f = fake(text, text.length);
    insertParagraph(f.view);
    assert.equal(f.text(), `${text}\n`);
  });

  it("选中一段再回车：选区被换成段落分隔", () => {
    const holder = fake("abcdef", 0);
    holder.view.dispatch({ selection: { anchor: 1, head: 4 } });
    insertParagraph(holder.view);
    assert.equal(holder.text(), "a\n\nef");
  });
});
