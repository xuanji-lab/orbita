/**
 * 文字定位（锚点失效后的降级）：`searchText` / `pickOccurrence`。
 *
 * 两条硬要求：**唯一命中才写**（出现两次宁可拒绝，绝不猜），以及引文的空白写法与原文不同
 * 形时（排版产生的 nbsp / 换行）仍能找到同一处——但要如实回报命中了几个。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickOccurrence, searchText } from "./docx-apply.ts";

describe("searchText", () => {
  it("逐字命中：每一处都给出起止偏移", () => {
    assert.deepEqual(searchText("abc abc", "abc"), [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it("没有命中就是空数组；空引文 / 全空白不返回零宽命中", () => {
    assert.deepEqual(searchText("abc", "zzz"), []);
    assert.deepEqual(searchText("abc", ""), []);
    assert.deepEqual(searchText("abc", "   "), []);
  });

  it("空白不同形（nbsp / 连续空格）：压平后仍能找到，偏移映射回原文", () => {
    const text = "结果\u00a0是   这样";
    const hits = searchText(text, "结果 是 这样");
    assert.deepEqual(hits, [{ start: 0, end: text.length }]);
  });

  it("逐字命中优先：原文里有同样空白时不会被压平后的匹配顶掉", () => {
    const hits = searchText("a  b", "a  b");
    assert.deepEqual(hits, [{ start: 0, end: 4 }]);
  });
});

describe("pickOccurrence", () => {
  it("只有一处才算定位成功", () => {
    assert.deepEqual(pickOccurrence([{ start: 2, end: 5 }]), { start: 2, end: 5 });
    assert.equal(pickOccurrence([]), null);
    assert.equal(
      pickOccurrence([
        { start: 0, end: 1 },
        { start: 3, end: 4 },
      ]),
      null,
    );
  });
});

/* ── 锚点寻址的证据要求（验收 R1） ────────────────────────────────────────
 *
 * 「写哪」是这一刀的安全底线：块内偏移只对「选中那一刻」的文档成立。三项文本佐证
 * （selectedTextHash / quote / find）都缺时，偏移就是盲猜——**必须拒绝**，且一条 op
 * 都不能交给引擎。这里用真 snapshot + 假编辑器跑 resolveRange 分支（不碰 DOM）。
 */

import { schema } from "@stll/folio-core/prosemirror/schema";
import { createFolioAIEditSnapshot, hashFolioAIBlockText } from "@stll/folio-core/ai-edits";
import type { DocxEditorRef } from "@stll/folio-react";
import type { DocxAgentEditRequest } from "@shared/docx";
import { applyDocxEdit } from "./docx-apply.ts";

const paragraphType = schema.nodes["paragraph"];
const docType = schema.nodes["doc"];
const PARAGRAPH_ID = "AAAA1111";
const BLOCK_TEXT = "今天我去了公园，流域出了结果。";

/** 一份只有一个段落的文档 + 它的快照 */
function fixture(): { doc: unknown; snapshot: unknown } {
  if (paragraphType === undefined || docType === undefined) throw new Error("folio schema 变了");
  const doc = docType.create(null, [paragraphType.create({ paraId: PARAGRAPH_ID }, [schema.text(BLOCK_TEXT)])]);
  return { doc, snapshot: createFolioAIEditSnapshot(doc) };
}

/** 假编辑器：只实现 applyDocxEdit 用到的那几处；`applied` 记下引擎被调用过几次 */
function fakeRef(doc: unknown, snapshot: unknown): { ref: DocxEditorRef; applied: string[][] } {
  const applied: string[][] = [];
  const ref = {
    createAIEditSnapshot: () => snapshot,
    getEditorRef: () => ({ getView: () => ({ state: { doc } }) }),
    getTrackedChanges: () => [{ id: 1 }],
    applyAIEditOperations: (options: { operations: { id: string }[] }) => {
      applied.push(options.operations.map((op) => op.id));
      return { applied: [{ id: "edit_docx", revisionIds: [1] }], skipped: [] };
    },
  } as unknown as DocxEditorRef;
  return { ref, applied };
}

function request(patch: Partial<DocxAgentEditRequest>): DocxAgentEditRequest {
  return {
    sessionId: "s",
    workspaceId: null,
    path: "/tmp/a.docx",
    replace: "X",
    ...patch,
  };
}

const anchorWith = (patch: Record<string, unknown>) => ({
  v: 1 as const,
  path: "",
  blockId: PARAGRAPH_ID,
  blockOrdinal: 1,
  startOffset: 2,
  endOffset: 5,
  selectedTextHash: "",
  blockTextHash: "",
  quote: "",
  contextBefore: "",
  contextAfter: "",
  table: null,
  docHash: "",
  editSeq: 0,
  ...patch,
});

describe("锚点的文本佐证（R1）", () => {
  it("两项佐证都缺、也没有 find：拒绝，一条 op 都不交给引擎", () => {
    const { doc, snapshot } = fixture();
    const { ref, applied } = fakeRef(doc, snapshot);
    const outcome = applyDocxEdit({ ref, author: "张三" }, request({ anchor: anchorWith({}) }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok === false ? outcome.reason : "", "stale");
    assert.match(outcome.ok === false ? outcome.error : "", /锚点缺文本佐证/);
    assert.deepEqual(applied, []);
  });

  it("只有 hash：通过（偏移处的文字哈希对得上才写）", () => {
    const { doc, snapshot } = fixture();
    const { ref, applied } = fakeRef(doc, snapshot);
    const quote = BLOCK_TEXT.slice(2, 5);
    const outcome = applyDocxEdit({ ref, author: "张三" }, request({ anchor: anchorWith({ selectedTextHash: hashFolioAIBlockText(quote) }) }));
    assert.equal(outcome.ok, true);
    assert.equal(applied.length, 1);
  });

  it("只有 quote：通过（偏移处的文字必须逐字等于引文）", () => {
    const { doc, snapshot } = fixture();
    const { ref, applied } = fakeRef(doc, snapshot);
    const outcome = applyDocxEdit({ ref, author: "张三" }, request({ anchor: anchorWith({ quote: BLOCK_TEXT.slice(2, 5) }) }));
    assert.equal(outcome.ok, true);
    assert.equal(applied.length, 1);
  });

  it("只有 quote 但偏移指到别处：按引文在该块内重新定位（reanchored），不写错位置", () => {
    const { doc, snapshot } = fixture();
    const { ref } = fakeRef(doc, snapshot);
    const outcome = applyDocxEdit(
      { ref, author: "张三" },
      request({ anchor: anchorWith({ startOffset: 0, endOffset: 2, quote: "流域出了" }) }),
    );
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok === true ? outcome.groups[0]?.reanchored : false, true);
    assert.equal(outcome.ok === true ? outcome.groups[0]?.before : "", "流域出了");
  });

  it("两项都缺但给了 find：find 就是佐证，按它定位", () => {
    const { doc, snapshot } = fixture();
    const { ref, applied } = fakeRef(doc, snapshot);
    const outcome = applyDocxEdit({ ref, author: "张三" }, request({ anchor: anchorWith({}), find: "流域出了" }));
    assert.equal(outcome.ok, true);
    assert.equal(applied.length, 1);
    assert.equal(outcome.ok === true ? outcome.groups[0]?.before : "", "流域出了");
  });

  it("只有 blockId（没有任何文字佐证）：拒绝", () => {
    const { doc, snapshot } = fixture();
    const { ref, applied } = fakeRef(doc, snapshot);
    const outcome = applyDocxEdit({ ref, author: "张三" }, request({ blockId: PARAGRAPH_ID }));
    assert.equal(outcome.ok, false);
    assert.deepEqual(applied, []);
  });
});
