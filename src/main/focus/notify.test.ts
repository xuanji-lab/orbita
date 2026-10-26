/**
 * `focus:notify-done` 入参净化的测试（notify.ts）。ipc 只调用它，不另测。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NOTIFY_BODY_MAX, NOTIFY_TITLE_MAX, normalizeFocusNotify } from "./notify.ts";

describe("normalizeFocusNotify", () => {
  test("合法对象：原样通过，首尾空白去掉", () => {
    assert.deepEqual(normalizeFocusNotify({ title: "  专注结束  ", body: " 休息一下\n" }), {
      title: "专注结束",
      body: "休息一下",
    });
  });

  test("多余字段不带到通知上", () => {
    const out = normalizeFocusNotify({ title: "t", body: "b", extra: 1, icon: "/x.png" });
    assert.deepEqual(out, { title: "t", body: "b" });
  });

  test("非对象一律拒绝", () => {
    for (const raw of [null, undefined, "title", 42, true, ["t", "b"]]) {
      assert.equal(normalizeFocusNotify(raw), null);
    }
  });

  test("缺字段 / 非字符串 / 全空白都拒绝", () => {
    assert.equal(normalizeFocusNotify({}), null);
    assert.equal(normalizeFocusNotify({ title: "t" }), null);
    assert.equal(normalizeFocusNotify({ body: "b" }), null);
    assert.equal(normalizeFocusNotify({ title: 1, body: "b" }), null);
    assert.equal(normalizeFocusNotify({ title: "t", body: null }), null);
    assert.equal(normalizeFocusNotify({ title: "   ", body: "b" }), null);
    assert.equal(normalizeFocusNotify({ title: "t", body: "\n\t " }), null);
  });

  test("超长截断而不是丢：title 120、body 300", () => {
    const long = "字".repeat(500);
    const out = normalizeFocusNotify({ title: long, body: long });
    assert.equal(out?.title.length, NOTIFY_TITLE_MAX);
    assert.equal(out?.body.length, NOTIFY_BODY_MAX);
  });

  test("正好等于上限不截断；emoji 按字符截断不切开代理对", () => {
    const exact = "字".repeat(NOTIFY_TITLE_MAX);
    assert.equal(normalizeFocusNotify({ title: exact, body: "b" })?.title, exact);
    const emoji = "🙂".repeat(NOTIFY_TITLE_MAX + 10);
    const cut = normalizeFocusNotify({ title: emoji, body: "b" })?.title ?? "";
    assert.equal(Array.from(cut).length, NOTIFY_TITLE_MAX);
    assert.equal(cut, "🙂".repeat(NOTIFY_TITLE_MAX));
  });
});
