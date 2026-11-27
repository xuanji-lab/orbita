import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { archivedEntryLit, toggleArchivedEntry } from "./rail-subview.ts";

describe("archivedEntryLit", () => {
  it("已归档正占着侧栏时点亮", () => {
    strictEqual(archivedEntryLit({ overlay: null, showArchived: true }), true);
  });

  it("设置盖着时不亮——开关在底下，但用户看不见它", () => {
    strictEqual(archivedEntryLit({ overlay: "settings", showArchived: true }), false);
  });

  it("主列表上不亮", () => {
    strictEqual(archivedEntryLit({ overlay: null, showArchived: false }), false);
  });
});

describe("toggleArchivedEntry", () => {
  it("主列表上点开：打开已归档", () => {
    deepStrictEqual(toggleArchivedEntry({ overlay: null, showArchived: false }), { overlay: null, showArchived: true });
  });

  it("亮着再点一次：收起回主列表", () => {
    deepStrictEqual(toggleArchivedEntry({ overlay: null, showArchived: true }), { overlay: null, showArchived: false });
  });

  it("设置页里点没开过的已归档：退出设置并打开（修复点——以前只在底下翻转，界面不动）", () => {
    deepStrictEqual(toggleArchivedEntry({ overlay: "settings", showArchived: false }), { overlay: null, showArchived: true });
  });

  it("设置页里点底下开着的已归档：回到它，而不是把它悄悄翻关", () => {
    deepStrictEqual(toggleArchivedEntry({ overlay: "settings", showArchived: true }), { overlay: null, showArchived: true });
  });
});
