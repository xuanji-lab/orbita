import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acceptReaderMessage,
  blockedMessage,
  isNarrowReader,
  isOpenableLink,
  pendingAfterDelete,
  pendingAfterSave,
  pageRectToPdf,
  READER_SIDE_BY_SIDE_MIN,
} from "./pdf-reader-view.ts";

test("窄宽度：400–700 都是浮层（批注栏默认收起），够宽才并排", () => {
  for (const width of [400, 550, 700, READER_SIDE_BY_SIDE_MIN - 1]) assert.equal(isNarrowReader(width), true);
  assert.equal(isNarrowReader(READER_SIDE_BY_SIDE_MIN), false);
});

test("只收自己那个 iframe、来自阅读器源的消息", () => {
  const frame = {};
  const ok = { source: frame, origin: "orbita-reader://app", data: { type: "ready" } };
  assert.deepEqual(acceptReaderMessage(ok, frame), { type: "ready" });
  assert.equal(acceptReaderMessage({ ...ok, source: {} }, frame), null);
  assert.equal(acceptReaderMessage({ ...ok, origin: "orbita-panel://doc" }, frame), null);
  assert.equal(acceptReaderMessage(ok, null), null);
  assert.equal(acceptReaderMessage({ ...ok, data: { type: "nope" } }, frame), null);
});

test("外链只放网页与邮件", () => {
  assert.equal(isOpenableLink("https://doi.org/10.1/x"), true);
  assert.equal(isOpenableLink("mailto:a@b.c"), true);
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "orbita-reader://app/x", "not a url"]) assert.equal(isOpenableLink(bad), false);
});

test("没存上的批注：按 id 留最新的一份，删掉的拿掉", () => {
  let pending = pendingAfterSave(new Map(), [{ id: "A", type: "highlight", color: "red" }]);
  pending = pendingAfterSave(pending, [{ id: "A", type: "highlight", comment: "x" }, { id: "B", type: "note" }]);
  assert.deepEqual(pending.get("A"), { id: "A", type: "highlight", color: "red", comment: "x" });
  pending = pendingAfterDelete(pending, ["B"]);
  assert.deepEqual([...pending.keys()], ["A"]);
});

test("写不了的四种原因各有一句话", () => {
  const t = { readOnly: "ro", corrupt: (f: string) => `c:${f}`, foreign: (f: string) => `f:${f}`, newer: (f: string) => `n:${f}` };
  assert.equal(blockedMessage("read-only", "a.json", t), "ro");
  assert.equal(blockedMessage("corrupt", "a.json", t), "c:a.json");
  assert.equal(blockedMessage("foreign", "a.json", t), "f:a.json");
  assert.equal(blockedMessage("newer", "a.json", t), "n:a.json");
});

test("页面像素 → PDF 用户空间：y 轴翻转、加上 viewBox 原点", () => {
  assert.deepEqual(pageRectToPdf({ left: 10, top: 20, width: 100, height: 12 }, [0, 0, 612, 792]), [10, 760, 110, 772]);
  assert.deepEqual(pageRectToPdf({ left: 0, top: 0, width: 1, height: 1 }, [5, 10, 600, 800]), [5, 799, 6, 800]);
});

test("工具栏只用字号角色档，没有裸 px 字号与裸 hex", () => {
  const css = readFileSync(new URL("./pdf-reader.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /font-size:\s*\d/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i);
  // 三档：> 560 平铺、≤ 560 缩放进「…」、≤ 460 批注工具合成一个菜单
  assert.match(css, /@container pdr \(max-width: 560px\)[\s\S]*?\.pdr-zoom[\s\S]*?display: none/);
  assert.match(css, /@container pdr \(max-width: 460px\)[\s\S]*?\.pdr-tools-all[\s\S]*?display: inline-flex/);
});
