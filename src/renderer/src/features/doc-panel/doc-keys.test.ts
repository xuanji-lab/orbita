/**
 * 真按键测试：用生产环境同一份扩展（liveMarkdown + 文档键位 + 标题过滤 + 默认键位）建 state，
 * 经 `runScopeHandlers` 派键盘事件——和浏览器里 keydown 走同一条 keymap 分派。
 * 只调命令函数测不出「谁先抢到回车」：@codemirror/lang-markdown 默认挂高优先级的 Enter，
 * 上一版列表分支在真编辑器里从没跑到，单测却全绿。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultKeymap } from "@codemirror/commands";
import { EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { keymap, runScopeHandlers, type EditorView } from "@codemirror/view";
import { liveMarkdown } from "./cm-live-markdown.ts";
import { documentKeymap, ensureTitle, titleFirstFilter } from "./doc-extensions.ts";

function editor(doc: string, anchor = doc.length) {
  const holder = {
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [liveMarkdown(), documentKeymap(), titleFirstFilter, keymap.of(defaultKeymap)],
    }),
    composing: false,
  };
  const view = {
    get state() {
      return holder.state;
    },
    get composing() {
      return holder.composing;
    },
    dispatch(spec: TransactionSpec) {
      holder.state = holder.state.update(spec).state;
    },
  } as unknown as EditorView;
  const press = (key: string, shift = false): boolean => {
    const event = { key, shiftKey: shift, ctrlKey: false, altKey: false, metaKey: false, defaultPrevented: false, preventDefault() {}, stopPropagation() {} } as unknown as KeyboardEvent;
    return runScopeHandlers(view, event, "editor");
  };
  /** 模拟用户输入一段字（普通 input 事务） */
  const type = (text: string): void => {
    const at = holder.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
  };
  return { view, press, type, text: () => holder.state.doc.toString(), holder };
}

describe("真按键：回车走文档键位（N3）", () => {
  it("列表里回车续项——是 insertParagraph 在跑，不是 lang-markdown 自带的那个", () => {
    const e = editor("- 列表一");
    assert.equal(e.press("Enter"), true);
    assert.equal(e.text(), "- 列表一\n- ");
  });

  it("列表空项再回车：退出列表并补空行，接着打的字不会并进最后一项", () => {
    const e = editor("- 列表一\n- 列表二");
    e.press("Enter");
    e.press("Enter"); // 空项退出
    e.type("第三段");
    assert.equal(e.text(), "- 列表一\n- 列表二\n\n第三段");
  });

  it("只有一项的列表：空项回车同样一次退出（原先要按三次）", () => {
    const e = editor("- 一");
    e.press("Enter");
    e.press("Enter");
    e.type("正文");
    assert.equal(e.text(), "- 一\n\n正文");
  });

  it("有序列表：编号 +1，退出后同样补空行", () => {
    const e = editor("1. 甲");
    e.press("Enter");
    assert.equal(e.text(), "1. 甲\n2. ");
    e.press("Enter");
    e.type("完");
    assert.equal(e.text(), "1. 甲\n\n完");
  });

  it("普通段落回车 = 空行分隔；Shift+回车 = 段内换行", () => {
    const a = editor("第一段");
    a.press("Enter");
    assert.equal(a.text(), "第一段\n\n");
    const b = editor("甲乙", 1);
    b.press("Enter", true);
    assert.equal(b.text(), "甲  \n乙");
  });

  it("引用块里回车：普通段落分隔（不再是 `>` 续行出不来）", () => {
    const e = editor("> 引语");
    e.press("Enter");
    e.type("正文");
    assert.equal(e.text(), "> 引语\n\n正文");
  });

  it("围栏代码块里回车：单换行", () => {
    const e = editor("```\ncode1");
    e.press("Enter");
    e.type("code2");
    assert.equal(e.text(), "```\ncode1\ncode2");
  });
});

describe("输入法组合与第一个字成标题（N1）", () => {
  it("普通输入：空文档里第一个字补成 `# 字`", () => {
    const e = editor("", 0);
    e.type("中");
    assert.equal(e.text(), "# 中");
    assert.equal(e.holder.state.selection.main.head, 3);
  });

  it("组合中不改写：拼音字母原样留在组合区里（不再变成 `# z`）", () => {
    const e = editor("", 0);
    e.view.dispatch({ changes: { from: 0, insert: "z" }, selection: { anchor: 1 }, userEvent: "input.type.compose" });
    assert.equal(e.text(), "z");
    e.view.dispatch({ changes: { from: 0, to: 1, insert: "zhong" }, selection: { anchor: 5 }, userEvent: "input.type.compose" });
    assert.equal(e.text(), "zhong");
    // 上屏：浏览器把组合区换成「中」，事务仍带 compose 标记
    e.view.dispatch({ changes: { from: 0, to: 5, insert: "中" }, selection: { anchor: 1 }, userEvent: "input.type.compose" });
    assert.equal(e.text(), "中", "组合没结束前一直不动它");
  });

  it("组合结束后补标题：整份是从空组合出来的 → 补 `# `，光标跟着后移；幂等", () => {
    const e = editor("", 0);
    e.view.dispatch({ changes: { from: 0, insert: "中" }, selection: { anchor: 1 }, userEvent: "input.type.compose" });
    assert.equal(ensureTitle(e.view, true), true);
    assert.equal(e.text(), "# 中");
    assert.equal(e.holder.state.selection.main.head, 3);
    assert.equal(ensureTitle(e.view, true), false);
    assert.equal(e.text(), "# 中");
  });

  it("组合还没结束（view.composing）不补；组合开始时文档不是空的也不补；已有 # 不重复加", () => {
    const a = editor("", 0);
    a.view.dispatch({ changes: { from: 0, insert: "中" }, userEvent: "input.type.compose" });
    a.holder.composing = true;
    assert.equal(ensureTitle(a.view, true), false);
    const b = editor("已有内容", 4);
    assert.equal(ensureTitle(b.view, false), false);
    const c = editor("# 已是标题", 6);
    assert.equal(ensureTitle(c.view, true), false);
  });

  it("组合后接着正常打字：不再补标题", () => {
    const e = editor("", 0);
    e.view.dispatch({ changes: { from: 0, insert: "中" }, selection: { anchor: 1 }, userEvent: "input.type.compose" });
    ensureTitle(e.view, true);
    e.type("文");
    assert.equal(e.text(), "# 中文");
  });
});

describe("外部改动不触发标题补全", () => {
  it("External 标记的事务（agent 写入空文档）原样进来", async () => {
    const { External } = await import("./doc-extensions.ts");
    const e = editor("", 0);
    e.view.dispatch({ changes: { from: 0, insert: "agent 写的" }, annotations: [External.of(true), Transaction.userEvent.of("input")] });
    assert.equal(e.text(), "agent 写的");
  });
});
