import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { toggleTaskChange } from "./cm-live-markdown.ts";

const DOC = "- [x] 做完\n- [ ] **做** 编辑\n1. [ ] 有序\n- 普通";

function stateOf(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
}

describe("编辑视图的任务列表复选框", () => {
  it("语法树：ListMark 的下一个兄弟是 Task，Task 首子是 TaskMarker（装饰逻辑靠这个结构）", () => {
    const state = stateOf(DOC);
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    assert.ok(tree !== null);
    const markers: string[] = [];
    tree.iterate({
      enter: (node) => {
        if (node.name !== "ListMark") return;
        const task = node.node.nextSibling;
        const marker = task !== null && task.name === "Task" ? task.firstChild : null;
        markers.push(marker !== null && marker.name === "TaskMarker" ? state.sliceDoc(marker.from, marker.to) : "-");
      },
    });
    assert.deepEqual(markers, ["[x]", "[ ]", "[ ]", "-"]);
  });

  it("点击翻转：[ ] → [x]，[x] / [X] → [ ]，位置不是方括号 = null", () => {
    let state = stateOf(DOC);
    const apply = (from: number): void => {
      const change = toggleTaskChange(state, from);
      assert.ok(change !== null);
      state = state.update({ changes: change }).state;
    };
    apply(2);
    assert.equal(state.doc.line(1).text, "- [ ] 做完");
    apply(2);
    assert.equal(state.doc.line(1).text, "- [x] 做完");
    const second = state.doc.line(2).from + 2;
    apply(second);
    assert.equal(state.doc.line(2).text, "- [x] **做** 编辑");
    assert.equal(toggleTaskChange(stateOf("- [X] a"), 2) !== null, true);
    assert.equal(toggleTaskChange(state, state.doc.line(4).from + 2), null);
    // 其余行不动
    assert.equal(state.doc.line(3).text, "1. [ ] 有序");
  });
});
