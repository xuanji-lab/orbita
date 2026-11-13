import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { docxFacts, docxRepackReasons, type DocxFactsNode } from "./docx-change.ts";

/** 最小假节点：判定只看 type.name / attrs / 子节点，不需要 schema */
function node(name: string, attrs: Record<string, unknown> = {}, children: DocxFactsNode[] = []): DocxFactsNode {
  return {
    type: { name },
    attrs,
    forEach: (fn) => {
      for (const child of children) fn(child);
    },
  };
}

function doc(body: DocxFactsNode[]): DocxFactsNode {
  return node("doc", {}, body);
}

describe("docxFacts", () => {
  test("数段落 / 表格 / 图片，编号 id 去重排序", () => {
    const tree = doc([
      node("paragraph", { numPr: { numId: 1001, ilvl: 0 } }),
      node("paragraph", {}),
      node("table", {}, [node("tableRow", {}, [node("tableCell", {}, [node("paragraph", { numPr: { numId: 1000 } })])])]),
      node("paragraph", { numPr: { numId: 1001, ilvl: 1 } }),
      node("image", {}),
    ]);
    deepStrictEqual(docxFacts(tree), { paragraphs: 4, tables: 1, images: 1, numberingIds: [1000, 1001] });
  });

  test("没有编号 / 图片时是空集合与零", () => {
    deepStrictEqual(docxFacts(doc([node("paragraph")])), {
      paragraphs: 1,
      tables: 0,
      images: 0,
      numberingIds: [],
    });
  });

  test("numId 不是数字（老快照 / 缺字段）不算编号定义", () => {
    const tree = doc([node("paragraph", { numPr: { numId: "1000" } }), node("paragraph", { numPr: null })]);
    deepStrictEqual(docxFacts(tree).numberingIds, []);
  });
});

describe("docxRepackReasons", () => {
  const base = { paragraphs: 3, tables: 1, images: 1, numberingIds: [1000] };

  test("同样的文档事实：选择性保存能覆盖，不提示", () => {
    deepStrictEqual(docxRepackReasons(base, { ...base, numberingIds: [1000] }), []);
  });

  test("增删段落 = 结构变化", () => {
    deepStrictEqual(docxRepackReasons(base, { ...base, paragraphs: 4 }), ["structure"]);
    deepStrictEqual(docxRepackReasons(base, { ...base, paragraphs: 2 }), ["structure"]);
  });

  test("增删表格 = 结构变化", () => {
    deepStrictEqual(docxRepackReasons(base, { ...base, tables: 2 }), ["structure"]);
  });

  test("新图片", () => {
    deepStrictEqual(docxRepackReasons(base, { ...base, images: 2 }), ["image"]);
    // 删图不是「新图片」，但图片节点在段落里，删图通常同时改段落数 → 由结构变化接住
    deepStrictEqual(docxRepackReasons(base, { ...base, images: 0 }), []);
  });

  test("新编号定义", () => {
    deepStrictEqual(docxRepackReasons(base, { ...base, numberingIds: [1000, 1001] }), ["numbering"]);
    // 只是不再引用某个已有定义：没有新定义，选择性保存照旧
    deepStrictEqual(docxRepackReasons(base, { ...base, numberingIds: [] }), []);
  });

  test("多个原因同时出现时按固定顺序给出", () => {
    deepStrictEqual(
      docxRepackReasons(base, { paragraphs: 9, tables: 1, images: 3, numberingIds: [1000, 1002] }),
      ["structure", "image", "numbering"],
    );
  });

  test("判定是纯的：不修改传入的事实", () => {
    const before = { ...base, numberingIds: [1000] };
    const after = { paragraphs: 4, tables: 1, images: 1, numberingIds: [1000] };
    docxRepackReasons(before, after);
    deepStrictEqual(before.numberingIds, [1000]);
    strictEqual(after.paragraphs, 4);
  });
});
