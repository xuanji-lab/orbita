/**
 * 完成卡的打开出口：「导出闭环」的那一条。
 *
 * 导出工具（export_docx / doc_export / slides_export）本来只回一张卡 + 产物路径；
 * 卡如果不能点，用户还得自己去文件树里找刚导出的东西。这里钉住的是：
 *   1. 工具给了 `openPanel` 就照它开（force 之类的意图不能被覆盖）；
 *   2. 导出卡没给 `openPanel` 也退回文件面板打开产物；
 *   3. 非导出卡缺 `openPanel` 不开（doc / slides 有各自的默认，交给调用方）；
 *   4. 坏卡（缺 path / 类型不对）不猜路径。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cardOpenHint, readCommandCard } from "./builtin-command.ts";

describe("完成卡的打开出口", () => {
  it("工具显式给了 openPanel 就照它开（含 force）", () => {
    const details = {
      openPanel: { kind: "files", path: "/w/out.docx", force: true },
      card: { kind: "export", path: "/w/out.docx", title: "out.docx" },
    };
    assert.deepEqual(cardOpenHint(details), { kind: "files", path: "/w/out.docx", force: true });
  });

  it("导出卡没给 openPanel：退回文件面板打开产物（导出闭环）", () => {
    const details = { card: { kind: "export", path: "/w/东京.pptx", title: "东京.pptx" } };
    assert.deepEqual(cardOpenHint(details), { kind: "files", path: "/w/东京.pptx" });
  });

  it("非导出卡没有 openPanel 时不开（slides / doc 的默认由调用方补）", () => {
    assert.equal(cardOpenHint({ card: { kind: "doc", path: "/w/a.md", title: "a.md" } }), null);
    assert.equal(cardOpenHint({ card: { kind: "slides", path: "/w/a.slides.json", title: "a" } }), null);
    assert.equal(cardOpenHint({}), null);
    assert.equal(cardOpenHint(null), null);
  });

  it("坏卡不猜路径：缺 path / 空 path / 未知 kind", () => {
    assert.equal(cardOpenHint({ card: { kind: "export", title: "x" } }), null);
    assert.equal(cardOpenHint({ card: { kind: "export", path: "", title: "x" } }), null);
    assert.equal(cardOpenHint({ card: { kind: "weird", path: "/w/a", title: "x" } }), null);
    assert.equal(readCommandCard({ card: { kind: "export", path: "/w/a", title: "x" } })?.path, "/w/a");
  });
});
