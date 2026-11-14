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
import { buildReviewRows, describeRow } from "./docx-review.ts";

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
    const [replace] = buildReviewRows([], [change(1, "deletion", "A", "旧"), change(2, "insertion", "A", "新")]);
    assert.equal(describeRow(replace as NonNullable<typeof replace>), "旧 → 新");
    assert.match(describeRow({ ...(replace as NonNullable<typeof replace>), kind: "insert", before: "", after: "新译文" }), /^\+ 新译文$/);
    assert.match(describeRow({ ...(replace as NonNullable<typeof replace>), kind: "delete", before: "旧译文", after: "" }), /^- 旧译文$/);
    const long = "字".repeat(80);
    assert.equal(Array.from(describeRow({ ...(replace as NonNullable<typeof replace>), kind: "insert", before: "", after: long })).length, 2 + 40 + 1);
  });
});
