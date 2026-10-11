import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isFileTurnRecord } from "./revert.ts";

const baseChange = {
  path: "/w/a.ts",
  before: { kind: "absent" },
  after: { kind: "text", blob: "b1.txt" },
  added: 3,
  removed: 1,
};

/** 一条最小合法的轮尾账（changes 一项）。 */
const baseRecord = {
  role: "file-turn",
  id: "t1",
  timestamp: 1,
  changes: [baseChange],
};

describe("isFileTurnRecord —— webArtifacts 加法字段", () => {
  it("旧记录没有字段照常收下", () => {
    strictEqual(isFileTurnRecord(baseRecord), true);
  });

  it("带合法 webArtifacts（含空数组）收下", () => {
    strictEqual(
      isFileTurnRecord({ ...baseRecord, webArtifacts: ["/w/out/report.html"] }),
      true,
    );
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifacts: [] }), true);
  });

  it("字段在场但不是字符串数组 → 整条拒掉", () => {
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifacts: "/w/a.html" }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifacts: ["/w/a.html", 2] }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifacts: [""] }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifacts: null }), false);
  });

  it("其余字段的既有校验不因新字段放松：坏 changes 仍拒", () => {
    deepStrictEqual(
      isFileTurnRecord({ ...baseRecord, changes: [{ ...baseChange, path: "" }] }),
      false,
    );
  });
});
