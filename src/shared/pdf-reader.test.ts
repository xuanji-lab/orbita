import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationsFileName,
  mergeAnnotations,
  parseAnnotation,
  parseAnnotationsFile,
  parseReaderEvent,
  readerColorScheme,
  readerLocale,
  READER_BRAND_FTL,
  removeAnnotations,
  type ReaderAnnotation,
} from "./pdf-reader.ts";

test("数据文件名：PDF 文件名后缀 .annotations.json", () => {
  assert.equal(annotationsFileName("Deep Residual.pdf"), "Deep Residual.pdf.annotations.json");
});

test("批注只校验 id 与 type，其余字段原样保留", () => {
  assert.deepEqual(parseAnnotation({ id: "QQVQEHWQ", type: "note", comment: "<b>x</b>", position: { pageIndex: 2 } }), {
    id: "QQVQEHWQ",
    type: "note",
    comment: "<b>x</b>",
    position: { pageIndex: 2 },
  });
  assert.equal(parseAnnotation({ id: "a/b", type: "highlight" }), null);
  assert.equal(parseAnnotation({ id: "", type: "highlight" }), null);
  assert.equal(parseAnnotation({ id: "A", type: "comment" }), null);
  assert.equal(parseAnnotation(["A"]), null);
  assert.equal(parseAnnotation(null), null);
});

test("数据文件：认得的读出来，坏条目丢掉；读不懂的整份标原因", () => {
  const ok = parseAnnotationsFile(JSON.stringify({ schema: 1, kind: "orbita.pdf-annotations", pdf: "a.pdf", annotations: [{ id: "A", type: "ink" }, { id: 3 }] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.file.annotations, [{ id: "A", type: "ink" }]);
  assert.deepEqual(parseAnnotationsFile("{"), { ok: false, reason: "corrupt" });
  assert.deepEqual(parseAnnotationsFile("[]"), { ok: false, reason: "corrupt" });
  assert.deepEqual(parseAnnotationsFile(JSON.stringify({ schema: 1, annotations: [] })), { ok: false, reason: "foreign" });
  assert.deepEqual(parseAnnotationsFile(JSON.stringify({ schema: 2, kind: "orbita.pdf-annotations" })), { ok: false, reason: "newer" });
  assert.deepEqual(parseAnnotationsFile(JSON.stringify({ schema: "1", kind: "orbita.pdf-annotations" })), { ok: false, reason: "corrupt" });
});

test("合并：浅合并已有的、追加新的、按 sortIndex 排（没有的排后且保持原序）；删除按 id", () => {
  const current: ReaderAnnotation[] = [
    { id: "A", type: "highlight", sortIndex: "00002", color: "red" },
    { id: "N", type: "note" },
  ];
  const merged = mergeAnnotations(current, [{ id: "A", type: "highlight", comment: "c" }, { id: "B", type: "underline", sortIndex: "00001" }, { id: "M", type: "ink" }]);
  assert.deepEqual(merged.map((a) => a.id), ["B", "A", "N", "M"]);
  assert.equal(merged[1]?.["color"], "red");
  assert.equal(merged[1]?.["comment"], "c");
  assert.equal(current[0]?.["comment"], undefined, "不改入参");
  assert.deepEqual(removeAnnotations(merged, ["A", "zzz"]).map((a) => a.id), ["B", "N", "M"]);
});

test("主题映射：黛、玄两档暗色 → dark，其余（含纸面、未解析）→ light；语言 zh → zh-CN", () => {
  assert.equal(readerColorScheme("graphite"), "dark");
  assert.equal(readerColorScheme("black"), "dark");
  for (const theme of ["light", "copybook", "typescript", undefined]) assert.equal(readerColorScheme(theme), "light");
  assert.equal(readerLocale("zh"), "zh-CN");
  assert.equal(readerLocale("en"), "en-US");
});

test("品牌 ftl 不出现 Zotero，且覆盖阅读器引用的 -app-name", () => {
  assert.doesNotMatch(READER_BRAND_FTL, /Zotero/);
  assert.match(READER_BRAND_FTL, /^-app-name = Orbita$/m);
});

test("面板收消息：形状不对的丢掉；state 的缺字段有兜底", () => {
  assert.equal(parseReaderEvent(null), null);
  assert.equal(parseReaderEvent({ type: "eval", code: "x" }), null);
  assert.equal(parseReaderEvent({ type: "delete", ids: [1] }), null);
  assert.deepEqual(parseReaderEvent({ type: "delete", ids: ["A"] }), { type: "delete", ids: ["A"] });
  assert.deepEqual(parseReaderEvent({ type: "save", annotations: [{ id: "A", type: "highlight" }, { id: "bad id", type: "highlight" }] }), {
    type: "save",
    annotations: [{ id: "A", type: "highlight" }],
  });
  assert.deepEqual(parseReaderEvent({ type: "state", pageIndex: 2, pagesCount: 9, sidebarOpen: false, tool: "lasso" }), {
    type: "state",
    pageIndex: 2,
    pageLabel: "3",
    pagesCount: 9,
    sidebarOpen: false,
    tool: "pointer",
    color: "#ffd400",
  });
});
