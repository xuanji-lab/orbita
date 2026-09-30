import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { unifiedDiffEntries } from "./review-panel.ts";

describe("unifiedDiffEntries", () => {
  test("unified diff → DiffBody 条目：@@ 头不进正文、行号按新旧行、一删一增配对", () => {
    const diff = [
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old line",
      "+new line",
      " tail",
    ].join("\n");
    const entries = unifiedDiffEntries(diff);
    // 一删一增 → 词级配对一个 pair + 两条 ctx
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "pair" ? "pair" : entry.row.kind)),
      ["ctx", "pair", "ctx"],
    );
    const pair = entries[1];
    assert.equal(pair?.kind, "pair");
    if (pair?.kind === "pair") {
      assert.equal(pair.removed.lineNum, "2");
      assert.equal(pair.added.lineNum, "2");
      assert.equal(pair.removed.text, "old line");
      assert.equal(pair.added.text, "new line");
    }
    // 上下文行带新行号
    const first = entries[0];
    assert.equal(first?.kind === "row" ? first.row.lineNum : "", "1");
  });

  test("多删多增不成对：整块行各自渲染", () => {
    const diff = ["@@ -1,2 +1,3 @@", "-a", "-b", "+x", "+y", "+z"].join("\n");
    const entries = unifiedDiffEntries(diff);
    assert.deepEqual(
      entries.map((entry) => (entry.kind === "pair" ? "pair" : entry.row.kind)),
      ["del", "del", "add", "add", "add"],
    );
  });

  test("空 diff → 空数组", () => {
    assert.deepEqual(unifiedDiffEntries(""), []);
  });
});
