import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";
import { describe, it } from "node:test";
import type { ChannelMessage } from "@shared/channel";
import {
  childActivityOf,
  elapsedText,
  groupPanelRows,
  nextTickIn,
  panelGroupOf,
  panelRowState,
  panelSecondLine,
  STUCK_MS,
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

// ───────────── 列表层重做（2026-11-22）─────────────

const msg = (kind: ChannelMessage["kind"], text: string, createdAt = 1): ChannelMessage => ({
  id: `${kind}-${createdAt}`,
  from: kind === "task" || kind === "reply" || kind === "stop" ? "parent" : "child",
  author: kind === "stop" ? "user" : "model",
  kind,
  text,
  delivery: "steer",
  createdAt,
});
const callLine = (toolName: string, input: unknown): string =>
  `${toolName} · ${String((input as { command?: string } | null)?.command ?? "")}`;

describe("childActivityOf（转录尾巴 → 正在跑的调用）", () => {
  it("最后一条工具记录还在 running：取它与它的开始时刻", () => {
    const activity = childActivityOf([
      { role: "assistant", timestamp: 10, content: [{ type: "toolCall", toolCallId: "a", toolName: "bash", input: { command: "bun run test" } }] },
      { role: "tool", status: "running", toolCallId: "a", toolName: "bash", input: { command: "bun run test" }, timestamp: 12 },
    ]);
    deepStrictEqual(activity, { toolName: "bash", input: { command: "bun run test" }, since: 12 });
  });
  it("发出了调用、结果还没落盘：取 assistant 那条的时刻", () => {
    const activity = childActivityOf([
      { role: "assistant", timestamp: 20, content: [{ type: "toolCall", toolCallId: "b", toolName: "read", input: { path: "a.ts" } }] },
    ]);
    strictEqual(activity?.since, 20);
  });
  it("调用都有结果、或最后是用户消息：不在跑工具", () => {
    strictEqual(
      childActivityOf([
        { role: "assistant", timestamp: 1, content: [{ type: "toolCall", toolCallId: "c", toolName: "bash", input: {} }] },
        { role: "tool", status: "complete", toolCallId: "c", toolName: "bash", input: {}, timestamp: 2 },
        { role: "assistant", timestamp: 3, content: [{ type: "text" }] },
      ]),
      null,
    );
    strictEqual(childActivityOf([{ role: "user", timestamp: 1 }]), null);
  });
});

describe("panelRowState（卡住判定、转录尾巴补「在跑」）", () => {
  const activity = (since: number) => ({ toolName: "bash", input: {}, since });
  it("引擎没在跑，但通道开着、尾巴有在跑的调用：running", () => {
    strictEqual(
      panelRowState({ channelStatus: "running", needsApproval: false, enginePhaseRunning: false, activity: activity(0), now: 1000 }),
      "running",
    );
  });
  it("同一个调用超过十分钟：stuck；正好十分钟还不算", () => {
    const base = { channelStatus: "running" as const, needsApproval: false, enginePhaseRunning: true };
    strictEqual(panelRowState({ ...base, activity: activity(0), now: STUCK_MS + 1 }), "stuck");
    strictEqual(panelRowState({ ...base, activity: activity(0), now: STUCK_MS }), "running");
  });
  it("通道已关（done / stopped）时尾巴里残留的 running 记录不算在跑", () => {
    strictEqual(
      panelRowState({ channelStatus: "done", needsApproval: false, enginePhaseRunning: false, activity: activity(0), now: 1 }),
      "done",
    );
    strictEqual(
      panelRowState({ channelStatus: "stopped", needsApproval: false, enginePhaseRunning: false, activity: activity(0), now: STUCK_MS * 2 }),
      "stopped",
    );
  });
  it("没有在跑的调用、引擎也闲着：idle（不是 running）", () => {
    strictEqual(
      panelRowState({ channelStatus: "running", needsApproval: false, enginePhaseRunning: false, activity: null, now: 1 }),
      "idle",
    );
  });
});

describe("groupPanelRows（要你看 → 在跑 → 已交回 → 已停止）", () => {
  it("组序固定、空组不出现；失败与在问你同组，问你的在前", () => {
    const rows = [
      { id: "d", state: "done" as const, lastAt: 5, since: null },
      { id: "f", state: "failed" as const, lastAt: 9, since: null },
      { id: "w", state: "waiting" as const, lastAt: 1, since: null },
      { id: "s", state: "stopped" as const, lastAt: 3, since: null },
    ];
    deepStrictEqual(
      groupPanelRows(rows).map((group) => [group.group, group.rows.map((row) => row.id)]),
      [
        ["attention", ["w", "f"]],
        ["handed", ["d"]],
        ["stopped", ["s"]],
      ],
    );
  });
  it("在跑组：卡住的在前，其余跑得久的在前", () => {
    const rows = [
      { id: "new", state: "running" as const, lastAt: 0, since: 300 },
      { id: "old", state: "running" as const, lastAt: 0, since: 100 },
      { id: "stuck", state: "stuck" as const, lastAt: 0, since: 200 },
    ];
    deepStrictEqual(groupPanelRows(rows)[0]?.rows.map((row) => row.id), ["stuck", "old", "new"]);
  });
  it("已交回组新的在前；idle 与用户停的同在「已停止」组", () => {
    strictEqual(panelGroupOf("idle"), "stopped");
    strictEqual(panelGroupOf("approval"), "attention");
    const rows = [
      { id: "a", state: "done" as const, lastAt: 1, since: null },
      { id: "b", state: "done" as const, lastAt: 2, since: null },
    ];
    deepStrictEqual(groupPanelRows(rows)[0]?.rows.map((row) => row.id), ["b", "a"]);
  });
});

describe("panelSecondLine（各状态第二行说什么）", () => {
  const base = { activity: null, planStep: null, messages: undefined, approval: null };
  it("在跑：正在执行的调用 + 走表起点，等宽", () => {
    const line = panelSecondLine(
      { ...base, state: "running", activity: { toolName: "bash", input: { command: "bun run test" }, since: 42 } },
      callLine,
      zh,
    );
    deepStrictEqual(line, { text: "bash · bun run test", lead: null, since: 42, mono: true, tone: "default" });
  });
  it("卡住：句首「卡住了」，黄色", () => {
    const line = panelSecondLine(
      { ...base, state: "stuck", activity: { toolName: "bash", input: { command: "bun run dist:win" }, since: 0 } },
      callLine,
      zh,
    );
    strictEqual(line.lead, "卡住了");
    strictEqual(line.tone, "warning");
  });
  it("在跑但没在跑工具：计划在做的步优先，没有就「在想」", () => {
    strictEqual(panelSecondLine({ ...base, state: "running", planStep: "对照截图逐张核" }, callLine, zh).text, "对照截图逐张核");
    strictEqual(panelSecondLine({ ...base, state: "running" }, callLine, zh).text, "在想");
  });
  it("在问你 / 失败 / 已交回：通道里那条的第一行（不是「完成」两个字）", () => {
    const messages = [msg("task", "任务"), msg("question", "要不要带右栏？\n细节", 2)];
    strictEqual(panelSecondLine({ ...base, state: "waiting", messages }, callLine, zh).text, "要不要带右栏？");
    const failed = [msg("task", "任务"), msg("failed", "\n分支被删了\n第二行", 2)];
    deepStrictEqual(
      panelSecondLine({ ...base, state: "failed", messages: failed }, callLine, zh),
      { text: "分支被删了", lead: null, since: null, mono: false, tone: "danger" },
    );
    const done = [msg("task", "任务"), msg("done", "三张截图都一致\n\n- 详情", 2)];
    strictEqual(panelSecondLine({ ...base, state: "done", messages: done }, callLine, zh).text, "三张截图都一致");
  });
  it("通道正文拉不到：退到状态词，不写「读取失败」", () => {
    strictEqual(panelSecondLine({ ...base, state: "done" }, callLine, zh).text, zh.subSessions.rowStatus.done);
  });
  it("用户终止的：「你停止了它」，不再是「还没说话」", () => {
    const stopped = [msg("task", "任务"), msg("stop", "", 2)];
    strictEqual(panelSecondLine({ ...base, state: "stopped", messages: stopped }, callLine, zh).text, "你停止了它");
    strictEqual(panelSecondLine({ ...base, state: "stopped" }, callLine, en).text, "You stopped it");
  });
  it("待批：要批的那次调用", () => {
    strictEqual(
      panelSecondLine({ ...base, state: "approval", approval: { toolName: "bash", input: { command: "rm -rf out" } } }, callLine, zh).text,
      "等你批准 · bash · rm -rf out",
    );
  });
});

describe("走表与时长", () => {
  it("没有在跑项不走表；不到一分钟每秒跳；都过一分钟对齐到最早的下一分钟", () => {
    strictEqual(nextTickIn([], 0), null);
    strictEqual(nextTickIn([0], 12_300), 700);
    strictEqual(nextTickIn([0, 30_000], 130_000), 20_000);
  });
  it("时长：秒 / 分钟 / 小时 + 分", () => {
    strictEqual(elapsedText(45_000, zh), "45 秒");
    strictEqual(elapsedText(192_000, zh), "3 分钟");
    strictEqual(elapsedText(3_900_000, zh), "1 小时 5 分");
  });
});
