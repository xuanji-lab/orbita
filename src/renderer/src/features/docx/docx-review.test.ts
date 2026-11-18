/**
 * 审阅条的分组：这是我们自己的约定，不是引擎的。
 *
 * 三条要钉住的：
 *   1. 一次 op 的 `revisionIds` 永远整组出现（只接受一半会残留半条修订——实测）；
 *   2. 已被单独接受 / 拒绝的 id 从组里消失，组空了就整行消失（不留一行点不动的按钮）；
 *   3. 不是我们写的修订按「同段 + 同作者 + 同时刻」折叠，一条删除 + 一条插入 = 一行「改成」。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FolioReviewChange } from "@stll/folio-core/ai-edits";
import type { DocxEditGroup } from "@shared/docx";
import { buildReviewRows, describeRow, rowNeedsContext, type DocxChangeRow } from "./docx-review.ts";
import { resolveRevisionGroup } from "./docx-apply.ts";
import type { DocxEditorRef } from "@stll/folio-react";

const change = (id: number, type: FolioReviewChange["type"], author: string, text: string, date = "2026-10-27T10:00:00Z"): FolioReviewChange => ({
  id,
  type,
  author,
  date,
  text,
  blockId: "B1",
});

const group = (id: string, revisionIds: number[], before: string, after: string): DocxEditGroup => ({
  id,
  blockId: "B1",
  revisionIds,
  before,
  after,
  reanchored: false,
});

describe("buildReviewRows", () => {
  it("我们写的一组：一行，两个 id 一起，带 before → after，标成 agent 写入", () => {
    const changes = [change(7, "deletion", "张三", "旧话"), change(8, "insertion", "张三", "新话")];
    const rows = buildReviewRows([group("edit_docx", [7, 8], "旧话", "新话")], changes);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0]?.revisionIds, [7, 8]);
    assert.equal(rows[0]?.ours, true);
    assert.equal(rows[0]?.kind, "replace");
    assert.equal(rows[0]?.before, "旧话");
    assert.equal(rows[0]?.after, "新话");
  });

  it("组里只剩一半（有一条被单独裁决过）：只留还在的那些 id，仍然是我们那一行", () => {
    const changes = [change(8, "insertion", "张三", "新话")];
    const rows = buildReviewRows([group("edit_docx", [7, 8], "旧话", "新话")], changes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.ours, true);
    assert.deepEqual(rows[0]?.revisionIds, [8]);
    // 组全没了（两条都被处理掉）就没有这一行
    assert.equal(buildReviewRows([group("edit_docx", [7, 8], "旧话", "新话")], []).length, 0);
  });

  it("别人的一次替换（del 紧跟 ins）折成一行；不同作者 / 不同时刻不折", () => {
    const rows = buildReviewRows(
      [],
      [
        change(1, "deletion", "导师", "甲乙"),
        change(2, "insertion", "导师", "丙丁"),
        change(3, "deletion", "导师", "戊", "2026-10-27T11:00:00Z"),
      ],
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]?.revisionIds, [1, 2]);
    assert.equal(rows[0]?.kind, "replace");
    assert.equal(rows[0]?.author, "导师");
    assert.deepEqual(rows[1]?.revisionIds, [3]);
    assert.equal(rows[1]?.kind, "delete");
  });

  it("格式 / 行格增删这类修订各自一行，不当成替换对", () => {
    const rows = buildReviewRows([], [change(5, "formatting", "导师", ""), change(6, "rowInserted", "导师", "一行")]);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.kind, "other");
    assert.equal(rows[1]?.kind, "other");
  });

  it("两条删除 + 一条插入不成替换对（宁可多一行，不猜）", () => {
    const rows = buildReviewRows([], [change(1, "deletion", "A", "x"), change(2, "deletion", "A", "y"), change(3, "insertion", "A", "z")]);
    assert.equal(rows.length, 3);
  });

  it("describeRow：改成 / 插入 / 删除三种说法，长文本截断", () => {
    const [replace] = buildReviewRows([], [change(1, "deletion", "A", "旧的那句话"), change(2, "insertion", "A", "新的那句话")]);
    assert.equal(describeRow(replace as NonNullable<typeof replace>), "旧的那句话 → 新的那句话");
    assert.match(
      describeRow({ ...(replace as NonNullable<typeof replace>), kind: "insert", before: "", after: "这是新加的整句话" }),
      /^\+ 这是新加的整句话$/,
    );
    assert.match(
      describeRow({ ...(replace as NonNullable<typeof replace>), kind: "delete", before: "这是要删的整句话", after: "" }),
      /^- 这是要删的整句话$/,
    );
    const long = "字".repeat(80);
    assert.equal(Array.from(describeRow({ ...(replace as NonNullable<typeof replace>), kind: "insert", before: "", after: long })).length, 2 + 40 + 1);
  });
});

describe("describeRow —— 文字太短时补上下文（验收 O3）", () => {
  const row = (before: string, after: string, blockId: string | null = "B1"): DocxChangeRow => ({
    key: "k",
    revisionIds: [1, 2],
    author: "张三",
    blockId,
    before,
    after,
    kind: "replace",
    date: null,
    ours: false,
    reanchored: false,
  });

  it("看得懂的改动不加料（段号不抢位置）", () => {
    assert.equal(describeRow(row("本章报告三组实验的结果", "本章汇报三组实验的结果"), 12), "本章报告三组实验的结果 → 本章汇报三组实验的结果");
  });

  it("只剩两个数字：前面补「第 N 段」并把字引起来", () => {
    assert.equal(describeRow(row("8", "5"), 12), "第 12 段 · 「8」→「5」");
  });

  it("连段号都不知道：明说改动范围未知，不只丢两个数字", () => {
    assert.equal(describeRow(row("8", "5"), 0), "「8」→「5」（改动范围未知）");
  });

  it("短插入 / 短删除同样补上下文", () => {
    assert.equal(describeRow({ ...row("", "3"), kind: "insert" }, 7), "第 7 段 · 新增「3」");
    assert.equal(describeRow({ ...row("9", ""), kind: "delete" }, 7), "第 7 段 · 删除「9」");
  });

  it("rowNeedsContext：合计 6 字以内算「看不出位置」", () => {
    assert.equal(rowNeedsContext(row("8", "5")), true);
    assert.equal(rowNeedsContext(row("abc", "ab")), true);
    assert.equal(rowNeedsContext(row("abc", "abcd")), false);
    assert.equal(rowNeedsContext(row("本章报告", "本章汇报")), false);
  });
});

describe("链式合并：同一处连续改两次（评审 P2）", () => {
  const op = (id: string, ids: number[], before: string, after: string, blockId = "B1"): DocxEditGroup => ({
    id,
    blockId,
    revisionIds: ids,
    before,
    after,
    reanchored: false,
  });

  /** 两对 del/ins，作者与时刻都相同（引擎写出来的形状） */
  const pairChanges = (): FolioReviewChange[] => [
    { id: 1, type: "deletion", author: "张三", date: "2026-11-17T10:00:00Z", text: "旧A", blockId: "B1" },
    { id: 2, type: "insertion", author: "张三", date: "2026-11-17T10:00:00Z", text: "新B", blockId: "B1" },
    { id: 3, type: "deletion", author: "张三", date: "2026-11-17T10:00:01Z", text: "新B", blockId: "B1" },
    { id: 4, type: "insertion", author: "张三", date: "2026-11-17T10:00:01Z", text: "新C", blockId: "B1" },
  ];

  it("A→B 与 B→C 合成一行 A→C，revisionIds 是并集", () => {
    const rows = buildReviewRows([op("op1", [1, 2], "旧A", "新B"), op("op2", [3, 4], "新B", "新C")], pairChanges());
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.before, "旧A");
    assert.equal(rows[0]?.after, "新C");
    assert.deepEqual(rows[0]?.revisionIds, [1, 2, 3, 4]);
    assert.equal(rows[0]?.kind, "replace");
  });

  it("合并后整组裁决：接受 / 拒绝都拿到全部 id（不会留半条）", () => {
    const rows = buildReviewRows([op("op1", [1, 2], "旧A", "新B"), op("op2", [3, 4], "新B", "新C")], pairChanges());
    const seen: number[][] = [];
    const ref = {
      acceptAIEditOperation: (ids: readonly number[]) => {
        seen.push([...ids]);
        return true;
      },
      rejectAIEditOperation: (ids: readonly number[]) => {
        seen.push([...ids]);
        return true;
      },
    } as unknown as DocxEditorRef;
    resolveRevisionGroup(ref, rows[0]!.revisionIds, "accept");
    resolveRevisionGroup(ref, rows[0]!.revisionIds, "reject");
    assert.deepEqual(seen, [
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
  });

  it("三段链 A→B→C→D 合成一行 A→D", () => {
    const changes: FolioReviewChange[] = [
      { id: 1, type: "deletion", author: "张三", date: null, text: "A", blockId: "B1" },
      { id: 2, type: "insertion", author: "张三", date: null, text: "B", blockId: "B1" },
      { id: 3, type: "deletion", author: "张三", date: null, text: "B", blockId: "B1" },
      { id: 4, type: "insertion", author: "张三", date: null, text: "C", blockId: "B1" },
      { id: 5, type: "deletion", author: "张三", date: null, text: "C", blockId: "B1" },
      { id: 6, type: "insertion", author: "张三", date: null, text: "D", blockId: "B1" },
    ];
    const rows = buildReviewRows(
      [op("op1", [1, 2], "A", "B"), op("op2", [3, 4], "B", "C"), op("op3", [5, 6], "C", "D")],
      changes,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.before, "A");
    assert.equal(rows[0]?.after, "D");
    assert.deepEqual(rows[0]?.revisionIds, [1, 2, 3, 4, 5, 6]);
  });

  it("不连续（旧文对不上）不合并", () => {
    const rows = buildReviewRows([op("op1", [1, 2], "旧A", "新B"), op("op2", [3, 4], "别处", "新C")], pairChanges());
    assert.equal(rows.length, 2);
  });

  it("跨段不合并", () => {
    const changes: FolioReviewChange[] = [
      { id: 1, type: "deletion", author: "张三", date: null, text: "旧A", blockId: "B1" },
      { id: 2, type: "insertion", author: "张三", date: null, text: "新B", blockId: "B1" },
      { id: 3, type: "deletion", author: "张三", date: null, text: "新B", blockId: "B2" },
      { id: 4, type: "insertion", author: "张三", date: null, text: "新C", blockId: "B2" },
    ];
    const rows = buildReviewRows([op("op1", [1, 2], "旧A", "新B", "B1"), op("op2", [3, 4], "新B", "新C", "B2")], changes);
    assert.equal(rows.length, 2);
  });

  it("中间夹了别的块的改动：链断开，不合", () => {
    const changes: FolioReviewChange[] = [
      { id: 1, type: "deletion", author: "张三", date: null, text: "旧A", blockId: "B1" },
      { id: 2, type: "insertion", author: "张三", date: null, text: "新B", blockId: "B1" },
      { id: 5, type: "deletion", author: "张三", date: null, text: "X", blockId: "B9" },
      { id: 6, type: "insertion", author: "张三", date: null, text: "Y", blockId: "B9" },
      { id: 3, type: "deletion", author: "张三", date: null, text: "新B", blockId: "B1" },
      { id: 4, type: "insertion", author: "张三", date: null, text: "新C", blockId: "B1" },
    ];
    const rows = buildReviewRows(
      [op("op1", [1, 2], "旧A", "新B"), op("op3", [5, 6], "X", "Y", "B9"), op("op2", [3, 4], "新B", "新C")],
      changes,
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => [row.before, row.after]),
      [
        ["旧A", "新B"],
        ["X", "Y"],
        ["新B", "新C"],
      ],
    );
  });

  it("只合并未裁决的链：前一组已被接受（id 不在文档里）→ 只剩后一条，不合并", () => {
    // 用户先改 A→B 并接受：1/2 已从文档里消失；之后才改 B→C
    const changes: FolioReviewChange[] = [
      { id: 3, type: "deletion", author: "张三", date: null, text: "新B", blockId: "B1" },
      { id: 4, type: "insertion", author: "张三", date: null, text: "新C", blockId: "B1" },
    ];
    const rows = buildReviewRows([op("op1", [1, 2], "旧A", "新B"), op("op2", [3, 4], "新B", "新C")], changes);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.before, "新B");
    assert.equal(rows[0]?.after, "新C");
    assert.deepEqual(rows[0]?.revisionIds, [3, 4]);
  });

  it("A→B→A（又改回去）不并成 A→A", () => {
    const changes: FolioReviewChange[] = [
      { id: 1, type: "deletion", author: "张三", date: null, text: "A", blockId: "B1" },
      { id: 2, type: "insertion", author: "张三", date: null, text: "B", blockId: "B1" },
      { id: 3, type: "deletion", author: "张三", date: null, text: "B", blockId: "B1" },
      { id: 4, type: "insertion", author: "张三", date: null, text: "A", blockId: "B1" },
    ];
    const rows = buildReviewRows([op("op1", [1, 2], "A", "B"), op("op2", [3, 4], "B", "A")], changes);
    assert.equal(rows.length, 2);
  });

  it("重开文档后的启发式行同样按链合并（A→B + B→C → A→C）", () => {
    const rows = buildReviewRows([], pairChanges());
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.before, "旧A");
    assert.equal(rows[0]?.after, "新C");
    assert.deepEqual(rows[0]?.revisionIds, [1, 2, 3, 4]);
  });
});
