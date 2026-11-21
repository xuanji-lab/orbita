/**
 * 网格编辑状态机的账：选区 / 进入与取消编辑 / 提交（回车往下、Tab 往右）/ 同一格改两次
 * 只算一条 / 改回原值不算改动 / 清空 / 公式原文 / 逐条与全部撤回 / 保存门禁 / 显示叠加。
 *
 * 这些都是纯函数，不需要窗口（组件只负责把键盘与 IPC 接上来）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_GRID_EDIT,
  beginEdit,
  canSave,
  cancelEdit,
  cellDisplay,
  cellRawText,
  clearPending,
  commitEdit,
  isDirty,
  moveSelection,
  parseDraft,
  pendingAt,
  pendingEdits,
  removePending,
  selectCell,
  updateDraft,
  type GridEditState,
} from "./xlsx-edit-state.ts";

const BOUNDS = { rows: 5, cols: 4 };

/** 一个「在 (1,1) 进入编辑、草稿是 X」的状态 */
function editing(draft: string, state: GridEditState = EMPTY_GRID_EDIT): GridEditState {
  return updateDraft(beginEdit(state, 1, 1), draft);
}

describe("选区与编辑状态机", () => {
  test("选中一格；正在编辑时改选别的格 = 取消未提交的草稿", () => {
    const picked = selectCell(EMPTY_GRID_EDIT, 2, 3);
    assert.deepEqual(picked.active, { row: 2, col: 3 });
    const draft = editing("改了一半");
    const moved = selectCell(draft, 0, 0);
    assert.equal(moved.editing, null);
    assert.deepEqual(moved.active, { row: 0, col: 0 });
    assert.deepEqual(moved.pending, [], "没提交的草稿不该进清单");
  });

  test("双击进入编辑：草稿从这一格现在的原文开始（公式带 =）", () => {
    const state = beginEdit(EMPTY_GRID_EDIT, 1, 2);
    assert.deepEqual(state.editing, { row: 1, col: 2, draft: "" });
    assert.deepEqual(cellRawText(null, { text: "4", formula: "C2*2", numeric: true }), "=C2*2");
  });

  test("Esc 取消：草稿丢掉，选区留着，清单不变", () => {
    const state = editing("123");
    const cancelled = cancelEdit(state);
    assert.equal(cancelled.editing, null);
    assert.deepEqual(cancelled.active, { row: 1, col: 1 });
    assert.equal(isDirty(cancelled), false);
  });

  test("方向键在边界上夹住；没选过格子时从 A1 开始", () => {
    assert.deepEqual(moveSelection(EMPTY_GRID_EDIT, "down", BOUNDS).active, { row: 1, col: 0 });
    const corner = selectCell(EMPTY_GRID_EDIT, 4, 3);
    assert.deepEqual(moveSelection(corner, "down", BOUNDS).active, { row: 4, col: 3 });
    assert.deepEqual(moveSelection(corner, "right", BOUNDS).active, { row: 4, col: 3 });
    assert.deepEqual(moveSelection(corner, "up", BOUNDS).active, { row: 3, col: 3 });
    assert.deepEqual(moveSelection(corner, "left", BOUNDS).active, { row: 4, col: 2 });
  });
});

describe("提交一格", () => {
  test("回车提交并往下移；条目是 1-based，带 sheet 与旧值", () => {
    const state = editing("42");
    const next = commitEdit(state, { sheet: "Data", next: "down", bounds: BOUNDS, original: null });
    assert.equal(next.editing, null);
    assert.deepEqual(next.active, { row: 2, col: 1 });
    assert.equal(next.pending.length, 1);
    const item = next.pending[0];
    assert.ok(item !== undefined);
    assert.deepEqual(item.edit, { sheet: "Data", row: 2, col: 2, value: 42, before: null });
    assert.deepEqual(pendingEdits(next), [item.edit]);
    assert.equal(item.formula, false);
  });

  test("Tab 提交并往右移，到最后一列就停在原地", () => {
    const next = commitEdit(updateDraft(beginEdit(EMPTY_GRID_EDIT, 0, 3), "x"), {
      sheet: "S",
      next: "right",
      bounds: BOUNDS,
      original: null,
    });
    assert.deepEqual(next.active, { row: 0, col: 3 });
    assert.equal(next.pending.length, 1);
  });

  test("同一格改两次：清单里只有一条（位置不变），值是后一次的", () => {
    const first = commitEdit(editing("1"), { sheet: "S", next: "none", bounds: BOUNDS, original: null });
    const again = commitEdit(updateDraft(beginEdit(first, 1, 1), "2"), {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: null,
    });
    assert.equal(again.pending.length, 1);
    assert.equal(again.pending[0]?.edit.value, 2);
  });

  test("改回原值不算改动（原来没有公式时）", () => {
    const state = updateDraft(beginEdit(EMPTY_GRID_EDIT, 0, 0), "apple");
    const next = commitEdit(state, {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: { text: "apple" },
    });
    assert.deepEqual(next.pending, []);
  });

  test("原来是公式格：再敲同样的数字也算改动（公式被换成值）", () => {
    const state = updateDraft(beginEdit(EMPTY_GRID_EDIT, 0, 1), "4");
    const next = commitEdit(state, {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: { text: "4", formula: "A1*2", numeric: true },
    });
    assert.equal(next.pending.length, 1);
    assert.equal(next.pending[0]?.edit.value, 4);
  });

  test("空格子提交空草稿：不算改动", () => {
    const next = commitEdit(beginEdit(EMPTY_GRID_EDIT, 0, 0), {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: null,
    });
    assert.deepEqual(next.pending, []);
  });

  test("清空一格：value 是 null，清单里的「新」是空串", () => {
    const state = updateDraft(beginEdit(EMPTY_GRID_EDIT, 2, 2), "");
    const next = commitEdit(state, {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: { text: "旧值" },
    });
    const item = next.pending[0];
    assert.ok(item !== undefined);
    assert.equal(item.edit.value, null);
    assert.equal(item.after, "");
    assert.equal(item.before, "旧值");
  });

  test("公式：带 = 的草稿写成 formula，清单里显示公式原文", () => {
    const state = updateDraft(beginEdit(EMPTY_GRID_EDIT, 4, 0), "=SUM(A1:A4)");
    const next = commitEdit(state, { sheet: "S", next: "none", bounds: BOUNDS, original: null });
    const item = next.pending[0];
    assert.ok(item !== undefined);
    assert.equal(item.edit.formula, "SUM(A1:A4)");
    assert.equal(item.edit.value, undefined);
    assert.equal(item.after, "=SUM(A1:A4)");
    assert.equal(item.formula, true);
  });

  test("不在编辑状态提交：原样返回（keydown 的兜底）", () => {
    const state = selectCell(EMPTY_GRID_EDIT, 0, 0);
    assert.equal(commitEdit(state, { sheet: "S", next: "down", bounds: BOUNDS, original: null }), state);
  });
});

describe("草稿怎么变成要写的值", () => {
  test("数字按数字、前导零按文本、空 = 清空", () => {
    assert.deepEqual(parseDraft("42"), { value: 42 });
    assert.deepEqual(parseDraft("-1.5"), { value: -1.5 });
    assert.deepEqual(parseDraft("0.5"), { value: 0.5 });
    assert.deepEqual(parseDraft("007"), { value: "007" });
    assert.deepEqual(parseDraft("1e5"), { value: "1e5" });
    assert.deepEqual(parseDraft(""), { value: null });
    assert.deepEqual(parseDraft("="), { value: null });
    assert.deepEqual(parseDraft("=A1+B1"), { formula: "A1+B1" });
    assert.deepEqual(parseDraft(" 中文 "), { value: " 中文 " });
  });
});

describe("撤回", () => {
  const twoEdits = (): GridEditState => {
    const first = commitEdit(editing("1"), { sheet: "S", next: "none", bounds: BOUNDS, original: null });
    return commitEdit(updateDraft(beginEdit(first, 3, 1), "2"), {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: null,
    });
  };

  test("逐条撤回只去掉那一条", () => {
    const state = twoEdits();
    assert.equal(state.pending.length, 2);
    const one = removePending(state, 1, 1);
    assert.equal(one.pending.length, 1);
    assert.equal(one.pending[0]?.row, 3);
    assert.equal(pendingAt(one, 1, 1), null);
  });

  test("全部撤回：dirty 归零", () => {
    const cleared = clearPending(twoEdits());
    assert.equal(isDirty(cleared), false);
    assert.deepEqual(pendingEdits(cleared), []);
  });

  test("撤不到就原样返回（同一份状态，免得白重渲染）", () => {
    const state = twoEdits();
    assert.equal(removePending(state, 9, 9), state);
    assert.equal(clearPending(EMPTY_GRID_EDIT), EMPTY_GRID_EDIT);
  });
});

describe("保存门禁", () => {
  test("没有改动 / 正在保存 → 不能点", () => {
    assert.equal(canSave(EMPTY_GRID_EDIT, false), false);
    const dirty = commitEdit(editing("1"), { sheet: "S", next: "none", bounds: BOUNDS, original: null });
    assert.equal(canSave(dirty, false), true);
    assert.equal(canSave(dirty, true), false);
  });
});

describe("显示叠加", () => {
  test("有公式没缓存值：显示公式原文并标 uncached；公式有缓存值就显示值", () => {
    assert.deepEqual(cellDisplay(null, { text: "", formula: "SUM(A1:A2)" }), {
      text: "=SUM(A1:A2)",
      uncached: true,
      edited: false,
      numeric: false,
    });
    assert.deepEqual(cellDisplay(null, { text: "4", formula: "A1*2", numeric: true }), {
      text: "4",
      uncached: false,
      edited: false,
      numeric: true,
    });
    assert.deepEqual(cellDisplay(null, null), { text: "", uncached: false, edited: false, numeric: false });
  });

  test("未保存的改动盖住原来的值，并带 edited 标记", () => {
    const state = commitEdit(editing("42"), { sheet: "S", next: "none", bounds: BOUNDS, original: { text: "4" } });
    const display = cellDisplay(pendingAt(state, 1, 1), { text: "4", numeric: true });
    assert.equal(display.text, "42");
    assert.equal(display.edited, true);
    assert.equal(display.numeric, true);
  });

  test("未保存的公式：显示公式原文 + 未计算标记", () => {
    const state = commitEdit(updateDraft(beginEdit(EMPTY_GRID_EDIT, 0, 0), "=A2*2"), {
      sheet: "S",
      next: "none",
      bounds: BOUNDS,
      original: null,
    });
    const display = cellDisplay(pendingAt(state, 0, 0), null);
    assert.deepEqual({ text: display.text, uncached: display.uncached, edited: display.edited }, {
      text: "=A2*2",
      uncached: true,
      edited: true,
    });
  });
});
