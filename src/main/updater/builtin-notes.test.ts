/**
 * 发版兜底：package.json 必须给当前版本写了应用内说明（builtin-notes.ts 的出处）。
 * 没写 / 写成了带 HTML 的文本时 builtinNotes() 是 null，设置页「当前版本」展开只剩一句
 * 「这一版没有更新说明」——那不该等到发布后才发现，这里在提交阶段就拦下。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { builtinNotes } from "./builtin-notes.ts";

describe("builtinNotes —— 当前版本的应用内说明", () => {
  test("package.json 写了说明，且解析出至少一条有正文的条目", () => {
    const notes = builtinNotes();
    assert.notEqual(notes, null);
    assert.ok(notes !== null && notes.length > 0);
    for (const note of notes) {
      assert.ok(note.text.trim() !== "", "条目正文不能是空的");
    }
  });
});
