/**
 * 选区 → 锚点：干净偏移、哈希、跨段落拒绝、表格坐标。
 *
 * 用引擎自己的 schema 造一份最小 PM 文档（带 deletion / insertion 标记），这样测的就是
 * 「真实节点形状」而不是我们编的替身：干净偏移的语义（跳过删除的字）只有对着真标记才立得住。
 * 单测只跑纯逻辑（`node --test` 里没有 DOM，也不需要——这套计算不碰视图）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { schema } from "@stll/folio-core/prosemirror/schema";
import { hashFolioAIBlockText, normalizeFolioAIBlockText } from "@stll/folio-core/ai-edits";
import type { Node } from "prosemirror-model";
import {
  anchorFromSelection,
  blockAt,
  blockOrdinal,
  cleanBlockOf,
  cleanOffsetOf,
  paragraphBlockId,
  tableLocationOf,
} from "./docx-anchor.ts";

// schema 的节点表是 Record<string, NodeType|undefined>：测试里按名字取，缺了就该当场炸
function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`folio schema 变了：缺 ${name}`);
  return value;
}

const paraType = need(schema.nodes["paragraph"], "paragraph");
const cellType = need(schema.nodes["tableCell"], "tableCell");
const rowType = need(schema.nodes["tableRow"], "tableRow");
const tableType = need(schema.nodes["table"], "table");
const docType = need(schema.nodes["doc"], "doc");
const DEL = need(schema.marks["deletion"], "deletion").create({ revisionId: 1, author: "T", date: "2026-01-01T00:00:00Z" });
const INS = need(schema.marks["insertion"], "insertion").create({ revisionId: 2, author: "T", date: "2026-01-01T00:00:00Z" });

/** 一段：`keep GONE(删除) added(插入) tail`，paraId 给个固定值 */
function paragraph(text: string, paraId = "1A2B3C4D"): Node {
  return paraType.create({ paraId }, [schema.text(text)]);
}

function docOf(...blocks: Node[]): Node {
  return docType.create(null, blocks);
}

/** 带真实修订标记的那一段（干净视图 = "keep added tail"） */
function markedParagraph(paraId = "11112222"): Node {
  return paraType.create({ paraId }, [
    schema.text("keep "),
    schema.text("GONE", [DEL]),
    schema.text("added", [INS]),
    schema.text(" tail"),
  ]);
}

describe("blockAt / cleanOffsetOf", () => {
  it("位置 → 所在段落与它的起点；选区端点落在 doc 层返回 null", () => {
    const doc = docOf(paragraph("hello"), paragraph("world"));
    const first = blockAt(doc, 2);
    assert.notEqual(first, null);
    assert.equal(first?.node.textContent, "hello");
    assert.equal(first?.from, 0);
    const second = blockAt(doc, 9);
    assert.equal(second?.node.textContent, "world");
    assert.equal(second?.from, 7);
    assert.equal(blockAt(doc, 0), null);
  });

  it("干净偏移：跳删除的字，插入的字照常计入", () => {
    const doc = docOf(markedParagraph());
    const block = blockAt(doc, 2);
    assert.notEqual(block, null);
    if (block === null) return;
    const clean = cleanBlockOf(block);
    assert.equal(clean.text, "keep added tail");
    // 段落内容从位置 1 开始：干净文本第 0 个字符在 PM 位置 1
    assert.equal(cleanOffsetOf(clean, 1), 0);
    assert.equal(cleanOffsetOf(clean, 6), 5);
    // 位置 8 落在删除的 "GONE" 中间：落回它前面那个干净边界（5），不产生半截偏移
    assert.equal(cleanOffsetOf(clean, 8), 5);
    // 块尾：饱和到干净长度
    assert.equal(cleanOffsetOf(clean, 100), clean.text.length);
  });

  it("段落的 blockId 来自 w14:paraId", () => {
    const doc = docOf(paragraph("x", "DEADBEEF"));
    const block = blockAt(doc, 1);
    assert.equal(paragraphBlockId((block as { node: Node }).node), "DEADBEEF");
  });

  it("序号：只数带文本的段落（与引擎 seq-NNNN 同语义）", () => {
    const doc = docOf(paragraph("一"), paraType.create(), paragraph("二"));
    assert.equal(blockOrdinal(doc, 0), 1);
    assert.equal(blockOrdinal(doc, 5), 2);
  });
});

describe("anchorFromSelection", () => {
  const input = (doc: Node, from: number, to: number) => {
    const block = blockAt(doc, from);
    assert.notEqual(block, null);
    if (block === null) throw new Error("no block");
    return {
      path: "C:/p/a.docx",
      docHash: "abc",
      editSeq: 3,
      block,
      from,
      to,
      doc,
    };
  };

  it("选中一段 → 块内干净偏移 + 两级哈希 + 引文与前后文", () => {
    const doc = docOf(paragraph("abcdefghij"));
    // "cdef"：PM 位置 3..7（段落内容从 1 开始）
    const anchor = anchorFromSelection(input(doc, 3, 7));
    assert.notEqual(anchor, null);
    if (anchor === null) return;
    assert.equal(anchor.v, 1);
    assert.equal(anchor.path, "C:/p/a.docx");
    assert.equal(anchor.blockId, "1A2B3C4D");
    assert.equal(anchor.blockOrdinal, 1);
    assert.deepEqual([anchor.startOffset, anchor.endOffset], [2, 6]);
    assert.equal(anchor.quote, "cdef");
    assert.equal(anchor.selectedTextHash, hashFolioAIBlockText("cdef"));
    assert.equal(anchor.blockTextHash, hashFolioAIBlockText(normalizeFolioAIBlockText("abcdefghij")));
    assert.equal(anchor.contextBefore, "ab");
    assert.equal(anchor.contextAfter, "ghij");
    assert.equal(anchor.table, null);
    assert.equal(anchor.docHash, "abc");
    assert.equal(anchor.editSeq, 3);
    assert.equal(Array.from(anchor.quote).length, 4);
  });

  it("选区碰到删除的字：引文取干净文本，不含被删的字", () => {
    const doc = docOf(markedParagraph());
    // PM 1..24 覆盖整段（含 "GONE"）
    const anchor = anchorFromSelection(input(doc, 1, 20));
    assert.notEqual(anchor, null);
    if (anchor === null) return;
    assert.equal(anchor.quote, "keep added tail");
    assert.equal(anchor.quote.includes("GONE"), false);
  });

  it("跨段落拒绝（返回 null，不截半句）", () => {
    const doc = docOf(paragraph("hello"), paragraph("world"));
    // 从第一段第 2 个字符选到第二段
    assert.equal(anchorFromSelection(input(doc, 2, 10)), null);
  });

  it("空选区 / 纯空白选区不建锚点", () => {
    const doc = docOf(paragraph("a   b"));
    assert.equal(anchorFromSelection(input(doc, 2, 2)), null);
    assert.equal(anchorFromSelection(input(doc, 2, 4)), null);
  });

  it("偏移漂移：同一段前面插了字，同样的偏移指向别的文字（哈希不再相等）", () => {
    const before = anchorFromSelection(input(docOf(paragraph("abcdefghij")), 3, 7));
    const after = anchorFromSelection(input(docOf(paragraph("XXabcdefghij")), 3, 7));
    assert.notEqual(before, null);
    assert.notEqual(after, null);
    if (before === null || after === null) return;
    assert.notEqual(after.quote, before.quote);
    assert.notEqual(after.selectedTextHash, before.selectedTextHash);
  });
});

describe("tableLocationOf", () => {
  const cell = (text: string, paraId: string): Node =>
    cellType.create(null, [paraType.create({ paraId }, [schema.text(text)])]);
  const row = (...cells: Node[]): Node => rowType.create(null, cells);
  const table = (...rows: Node[]): Node => tableType.create(null, rows);

  it("段落落在表格里：表 / 行 / 格 / 格内段落序号（全零基）", () => {
    const doc = docOf(paragraph("前言"), table(row(cell("A1", "AA"), cell("B1", "BB")), row(cell("A2", "CC"), cell("D2", "DD"))));
    // 找 B1 这个格里的段落位置
    let target = -1;
    doc.descendants((node, pos) => {
      if (node.isTextblock && node.attrs["paraId"] === "BB") {
        target = pos;
        return false;
      }
      return true;
    });
    assert.ok(target > 0);
    const block = blockAt(doc, target + 1);
    const location = tableLocationOf(doc, target + 1);
    assert.deepEqual(location, { tableIndex: 0, rowIndex: 0, cellIndex: 1, paragraphIndex: 0 });
    // 同一处建出来的锚点带着表格坐标
    if (block === null) return;
    const anchor = anchorFromSelection({ path: "p", docHash: "h", editSeq: 0, block, from: target + 1, to: target + 3, doc });
    assert.deepEqual(anchor?.table, { tableIndex: 0, rowIndex: 0, cellIndex: 1, paragraphIndex: 0 });
    assert.equal(anchor?.blockId, "BB");
  });

  it("不在表格里回 null", () => {
    assert.equal(tableLocationOf(docOf(paragraph("正文")), 1), null);
  });
});
