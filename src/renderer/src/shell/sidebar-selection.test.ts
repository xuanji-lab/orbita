import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SELECTION, nextSelection, rowClickKind, selectedInOrder } from "./sidebar-selection.ts";

const visible = ["a", "b", "c", "d", "e"];
const ids = (set: ReadonlySet<string>): string[] => [...set].sort();

describe("rowClickKind", () => {
  test("Shift 优先于 Cmd / Ctrl", () => {
    assert.equal(rowClickKind({ shiftKey: true, metaKey: true, ctrlKey: false }), "range");
    assert.equal(rowClickKind({ shiftKey: false, metaKey: true, ctrlKey: false }), "toggle");
    assert.equal(rowClickKind({ shiftKey: false, metaKey: false, ctrlKey: true }), "toggle");
    assert.equal(rowClickKind({ shiftKey: false, metaKey: false, ctrlKey: false }), "plain");
  });
});

describe("nextSelection", () => {
  test("普通点击：清空多选、打开、记 anchor", () => {
    const start = { ids: new Set(["a", "b"]), anchor: "a" };
    const { selection, open } = nextSelection(start, "plain", "c", visible, null);
    assert.equal(open, true);
    assert.equal(selection.ids.size, 0);
    assert.equal(selection.anchor, "c");
  });

  test("没有 anchor 时 Shift 以正打开的那条为起点，区间按可见顺序（向上也行）", () => {
    const { selection, open } = nextSelection(EMPTY_SELECTION, "range", "b", visible, "d");
    assert.equal(open, false);
    assert.deepEqual(ids(selection.ids), ["b", "c", "d"]);
    assert.equal(selection.anchor, "d");
  });

  test("Shift 再点一次只改终点：区间替换不累加", () => {
    const first = nextSelection({ ids: new Set(), anchor: "b" }, "range", "e", visible, null).selection;
    const second = nextSelection(first, "range", "c", visible, null).selection;
    assert.deepEqual(ids(second.ids), ["b", "c"]);
  });

  test("起点不可见（被折起）：退化为只选点的这条", () => {
    const { selection } = nextSelection({ ids: new Set(), anchor: "hidden" }, "range", "c", visible, null);
    assert.deepEqual(ids(selection.ids), ["c"]);
    assert.equal(selection.anchor, "c");
  });

  test("Cmd 第一次点把正打开的那条一起带上；再点同一条移出", () => {
    const first = nextSelection(EMPTY_SELECTION, "toggle", "c", visible, "a").selection;
    assert.deepEqual(ids(first.ids), ["a", "c"]);
    const second = nextSelection(first, "toggle", "a", visible, "a").selection;
    assert.deepEqual(ids(second.ids), ["c"]);
  });

  test("Cmd 点正打开的那条本身：只选它，不重复", () => {
    const { selection } = nextSelection(EMPTY_SELECTION, "toggle", "a", visible, "a");
    assert.deepEqual(ids(selection.ids), []);
  });
});

describe("selectedInOrder", () => {
  test("按可见顺序，丢掉已不可见的", () => {
    assert.deepEqual(selectedInOrder({ ids: new Set(["d", "gone", "a"]), anchor: null }, visible), ["a", "d"]);
  });
});
