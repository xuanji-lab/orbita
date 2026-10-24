import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isFileTurnRecord, isUndoRecord } from "./revert.ts";

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

describe("isFileTurnRecord —— webArtifactsBatch 加法字段", () => {
  it("旧记录没有字段照常收下", () => {
    strictEqual(isFileTurnRecord(baseRecord), true);
  });

  it("带合法计数（≥ 1 的整数）收下", () => {
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: 12 }), true);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: 1 }), true);
  });

  it("字段在场但不是 ≥ 1 的整数 → 整条拒掉", () => {
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: 0 }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: 1.5 }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: -3 }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: "12" }), false);
    strictEqual(isFileTurnRecord({ ...baseRecord, webArtifactsBatch: null }), false);
  });
});

describe("isUndoRecord —— reason 加法字段", () => {
  const undo = {
    role: "undo",
    id: "u1",
    turnId: "t1",
    restored: [{ path: "/w/a.ts", outcome: "restored" }],
    timestamp: 1,
  };

  it("旧记录没有 reason 照常收下（撤销成功不需要理由）", () => {
    strictEqual(isUndoRecord(undo), true);
  });

  it("skipped 带原因收下；在场但为空串 / 不是字符串 → 整条拒掉", () => {
    strictEqual(
      isUndoRecord({ ...undo, restored: [{ path: "/w/a.ts", outcome: "skipped", reason: "文件被占用或没有写权限（EBUSY）" }] }),
      true,
    );
    strictEqual(isUndoRecord({ ...undo, restored: [{ path: "/w/a.ts", outcome: "skipped", reason: "" }] }), false);
    strictEqual(isUndoRecord({ ...undo, restored: [{ path: "/w/a.ts", outcome: "skipped", reason: 3 }] }), false);
  });
});
