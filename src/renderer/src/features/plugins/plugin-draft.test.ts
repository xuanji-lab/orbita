import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { draftOf, dropDraft, putDraft, shouldOpenDraft, type PluginDrafts } from "./plugin-draft.ts";

describe("草稿按会话记", () => {
  test("各记各的；同一个值再放回同一个引用（不触发多余渲染）；离开只清当前会话的", () => {
    const empty: PluginDrafts = new Map();
    const a = putDraft(empty, "s1", "plugins/lit");
    const b = putDraft(a, "s2", "plugins/other");
    assert.equal(draftOf(b, "s1"), "plugins/lit");
    assert.equal(draftOf(b, "s2"), "plugins/other");
    assert.equal(putDraft(b, "s1", "plugins/lit"), b);
    const c = dropDraft(b, "s1");
    assert.equal(draftOf(c, "s1"), null);
    assert.equal(draftOf(c, "s2"), "plugins/other");
    assert.equal(dropDraft(c, "nope"), c);
    assert.equal(draftOf(b, null), null, "首页没有草稿");
  });

  test("agent 对同一会话换了一个文件夹预览：换成新的", () => {
    const next = putDraft(putDraft(new Map(), "s1", "plugins/a"), "s1", "plugins/b");
    assert.equal(draftOf(next, "s1"), "plugins/b");
  });
});

describe("shouldOpenDraft：只在正看着该会话、且插件实验功能开着时打开右栏", () => {
  test("四种情形", () => {
    const base = { eventSessionId: "s1", viewedSessionId: "s1", pluginsEnabled: true };
    assert.equal(shouldOpenDraft(base), true);
    assert.equal(shouldOpenDraft({ ...base, viewedSessionId: "s2" }), false, "别的会话：只记下，不抢右栏");
    assert.equal(shouldOpenDraft({ ...base, viewedSessionId: null }), false, "首页");
    assert.equal(shouldOpenDraft({ ...base, pluginsEnabled: false }), false, "实验开关关着");
  });
});
