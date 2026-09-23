import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { sortSubSessionRows, subSessionRowStatus, type SubSessionRowStatus } from "./sub-sessions-rows.ts";

describe("subSessionRowStatus", () => {
  it("channelStatus waiting：不管 running/needsApproval 是什么都判 waiting", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "waiting", needsApproval: true, running: true }),
      "waiting",
    );
  });

  it("有未答审批、非 waiting：判 approval，即便同时在跑", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "running", needsApproval: true, running: true }),
      "approval",
    );
  });

  it("在跑、无审批、非 waiting：判 running", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "running", needsApproval: false, running: true }),
      "running",
    );
  });

  it("通道 done、不在跑、无审批：判 done", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "done", needsApproval: false, running: false }),
      "done",
    );
  });

  it("通道 failed、不在跑、无审批：判 failed", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "failed", needsApproval: false, running: false }),
      "failed",
    );
  });

  it("通道 running（只有 task）、不在跑、无审批：判 idle", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "running", needsApproval: false, running: false }),
      "idle",
    );
  });

  it("channelStatus 缺席（还没有通道摘要）：按 running/needsApproval 走，否则 idle", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: undefined, needsApproval: false, running: false }),
      "idle",
    );
  });
});

describe("sortSubSessionRows", () => {
  const row = (id: string, status: SubSessionRowStatus): { id: string; status: SubSessionRowStatus } => ({
    id,
    status,
  });

  it("waiting 最前，其次 approval，其次 running，其余按原序（派出顺序）", () => {
    const rows = [
      row("idle-1", "idle"),
      row("running-1", "running"),
      row("waiting-1", "waiting"),
      row("done-1", "done"),
      row("approval-1", "approval"),
      row("running-2", "running"),
    ];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["waiting-1", "approval-1", "running-1", "running-2", "idle-1", "done-1"],
    );
  });

  it("done/failed/idle 同一档，稳定排序保留原始（派出）顺序", () => {
    const rows = [row("failed-1", "failed"), row("idle-1", "idle"), row("done-1", "done")];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["failed-1", "idle-1", "done-1"],
    );
  });

  it("不改变入参数组（返回新数组）", () => {
    const rows = [row("a", "done"), row("b", "waiting")];
    const sorted = sortSubSessionRows(rows);
    strictEqual(sorted === rows, false);
    strictEqual(rows[0]?.id, "a");
  });
});
