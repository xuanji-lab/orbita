import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  sortSubSessionRows,
  subSessionRowStatus,
  subSessionStatusOf,
  type SubSessionEngineSlots,
  type SubSessionRowStatus,
} from "./sub-sessions-rows.ts";

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

  it("stopped 压过 needsApproval / running——用户终止了就别再拿待批 / 在跑引导用户", () => {
    strictEqual(
      subSessionRowStatus({ channelStatus: "stopped", needsApproval: true, running: true }),
      "stopped",
    );
    strictEqual(
      subSessionRowStatus({ channelStatus: "stopped", needsApproval: false, running: false }),
      "stopped",
    );
  });
});

describe("subSessionStatusOf", () => {
  /** 假引擎：running 里的会话在跑，approving 里的有待答审批（两者可同时） */
  const engine = (running: readonly string[], approving: readonly string[]): SubSessionEngineSlots => ({
    states: new Map(approving.map((id) => [id, { approvals: [{}] }])),
    phaseOf: (id: string) => (running.includes(id) ? "turn" : "idle"),
  });

  it("子在跑：通道只有 task（channelStatus running）也判 running", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine(["c1"], [])), "running");
  });

  it("子不在跑、通道也没报终态：判 idle——通道开着不等于在跑（2026-10 bug 回归）", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine([], [])), "idle");
  });

  it("审批槽优先于 phase：在跑但有待答审批判 approval", () => {
    strictEqual(subSessionStatusOf("c1", "running", engine(["c1"], ["c1"])), "approval");
  });

  it("waiting 压过审批与 phase", () => {
    strictEqual(subSessionStatusOf("c1", "waiting", engine(["c1"], ["c1"])), "waiting");
  });

  it("没有摘要（还没拉到）也按槽走，不因缺席先验成 idle", () => {
    strictEqual(subSessionStatusOf("c1", undefined, engine(["c1"], [])), "running");
  });
});

describe("sortSubSessionRows", () => {
  const row = (id: string, status: SubSessionRowStatus): { id: string; status: SubSessionRowStatus } => ({
    id,
    status,
  });

  it("waiting 最前，其次 approval，其次 running，其余（含 stopped）按原序（派出顺序）", () => {
    const rows = [
      row("idle-1", "idle"),
      row("running-1", "running"),
      row("waiting-1", "waiting"),
      row("done-1", "done"),
      row("stopped-1", "stopped"),
      row("approval-1", "approval"),
      row("running-2", "running"),
    ];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["waiting-1", "approval-1", "running-1", "running-2", "idle-1", "done-1", "stopped-1"],
    );
  });

  it("done/failed/stopped/idle 同一档，稳定排序保留原始（派出）顺序", () => {
    const rows = [row("failed-1", "failed"), row("stopped-1", "stopped"), row("idle-1", "idle"), row("done-1", "done")];
    deepStrictEqual(
      sortSubSessionRows(rows).map((r) => r.id),
      ["failed-1", "stopped-1", "idle-1", "done-1"],
    );
  });

  it("不改变入参数组（返回新数组）", () => {
    const rows = [row("a", "done"), row("b", "waiting")];
    const sorted = sortSubSessionRows(rows);
    strictEqual(sorted === rows, false);
    strictEqual(rows[0]?.id, "a");
  });
});
