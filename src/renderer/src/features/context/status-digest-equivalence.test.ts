/**
 * 状态卡摘要的等价测试（合成夹具）：fold（shared/status-digest.ts）与卡上旧派生
 * （statusOutputs / delegationSteps / planHistory / buildGoalLedger / childActivityOf）
 * 在同一份转录上逐项深等。真实会话的对账在 scripts/status-digest-audit.test.mjs
 * （真实数据里 update_plan / 看板 / 导出覆盖薄，这里的合成夹具专补它们）。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptRecord } from "@shared/session";
import {
  cloneStatusDigestState,
  digestChildActivity,
  digestOutputs,
  digestTerminals,
  foldStatusRecord,
  foldStatusRecords,
  type StatusDigestState,
} from "../../../../shared/status-digest.ts";
import { buildGoalLedger } from "../../../../shared/goal-ledger.ts";
import { statusOutputs, childActivityOf } from "./chat-status.ts";
import { planHistory, planTimeline } from "./plan-timeline.ts";
import { delegationSteps } from "./delegation-steps.ts";
import { ledgerEventsOf } from "./goal-ledger-records.ts";

let seq = 0;
const rid = () => `rec-${++seq}`;

const user = (text: string, at: number): TranscriptRecord =>
  ({ role: "user", id: rid(), timestamp: at, content: [{ type: "text", text }] }) as unknown as TranscriptRecord;
const assistant = (blocks: unknown[], at: number): TranscriptRecord =>
  ({ role: "assistant", id: rid(), timestamp: at, content: blocks, status: "complete" }) as unknown as TranscriptRecord;
const toolCall = (toolCallId: string, toolName: string, input: unknown): unknown => ({ type: "toolCall", toolCallId, toolName, input });
const tool = (toolCallId: string, toolName: string, status: string, at: number, extra: Record<string, unknown> = {}): TranscriptRecord =>
  ({ role: "tool", id: rid(), toolCallId, toolName, input: {}, content: [], timestamp: at, status, isError: status === "error", ...extra }) as unknown as TranscriptRecord;
const plan = (toolCallId: string, items: unknown[], at: number, extra: Record<string, unknown> = {}): TranscriptRecord =>
  tool(toolCallId, "update_plan", "complete", at, { input: { items }, ...extra });
const goal = (toolCallId: string, text: string, at: number, extra: Record<string, unknown> = {}): TranscriptRecord =>
  tool(toolCallId, "update_goal", "complete", at, { input: { goal: text }, ...extra });
const delegate = (toolCallId: string, childId: string, title: string, at: number, planStep?: string): TranscriptRecord =>
  tool(toolCallId, "delegate", "complete", at, {
    input: { title, ...(planStep === undefined ? {} : { planStep }) },
    details: { delegate: { childId } },
  });
const channelMark = (at: number): TranscriptRecord =>
  ({ role: "channel-mark", id: rid(), timestamp: at, peerId: "p", messageId: rid(), from: "child", kind: "report" }) as unknown as TranscriptRecord;
const fileTurn = (paths: string[], at: number, extra: Record<string, unknown> = {}): TranscriptRecord =>
  ({
    role: "file-turn",
    id: rid(),
    timestamp: at,
    changes: paths.map((path) => ({ path, before: { kind: "absent" }, after: { kind: "absent" }, added: 1, removed: 0 })),
    ...extra,
  }) as unknown as TranscriptRecord;

/** 逐项对照：fold 的各段派生 vs 旧批量派生 */
function assertEquivalent(records: readonly TranscriptRecord[], label: string): void {
  const folded = foldStatusRecords(records);
  assert.deepEqual(digestOutputs(folded), statusOutputs(records, null), `${label}：产物`);
  assert.deepEqual(digestChildActivity(folded), childActivityOf(records), `${label}：在跑什么`);
  assert.deepEqual(buildGoalLedger(ledgerEventsOf(folded.slim)), buildGoalLedger(ledgerEventsOf(records)), `${label}：目标账`);
  assert.deepEqual(planHistory(folded.slim), planHistory(records), `${label}：计划版本线`);
  const timeline = planTimeline(records);
  assert.deepEqual(
    [...delegationSteps(folded.slim, planTimeline(folded.slim)).entries()].sort(),
    [...delegationSteps(records, timeline).entries()].sort(),
    `${label}：子会话挂步`,
  );
  // 尾窗叠加：折前一半当摘要，尾巴再折，与全量折深等
  const cut = Math.floor(records.length / 2);
  const base = foldStatusRecords(records.slice(0, cut));
  const overlaid = cloneStatusDigestState(base);
  for (const record of records.slice(cut)) foldStatusRecord(overlaid, record);
  assert.deepEqual(overlaid, folded, `${label}：分段折 == 全量折`);
}

describe("状态卡摘要 · 等价（合成夹具）", () => {
  it("空转录", () => {
    assertEquivalent([], "空");
  });

  it("计划：定下 → 改说法 → 提步 → 打勾 → 等你 → 换新计划", () => {
    const records = [
      user("做个东西", 1),
      plan("p1", [
        { text: "调研", status: "done" },
        { text: "写实现", status: "in_progress" },
        { text: "补测试", status: "pending" },
      ], 2),
      assistant([toolCall("c1", "bash", { command: "ls" })], 3),
      tool("c1", "bash", "complete", 4),
      // 改说法 + 提步（补测试提到写实现前面）
      plan("p2", [
        { text: "调研", status: "done" },
        { text: "补测试", status: "in_progress" },
        { text: "写实现", status: "pending" },
      ], 5, { input: { items: [
        { text: "调研", status: "done" },
        { text: "补测试", status: "in_progress" },
        { text: "写实现", status: "pending" },
      ], why: "先补测试" } }),
      // 等你
      plan("p3", [
        { text: "调研", status: "done" },
        { text: "补测试", status: "waiting", waitingFor: "等你确认" },
        { text: "写实现", status: "pending" },
      ], 6, { details: { awaiting: true } }),
      // 换新计划（一步都对不上）
      plan("p4", [
        { text: "推翻重来", status: "in_progress" },
        { text: "写文档", status: "pending" },
      ], 7),
    ];
    assertEquivalent(records, "计划");
  });

  it("目标：定下 → 用户改 → agent 自己改", () => {
    const records = [
      user("帮我把性能搞好", 1),
      goal("g1", "把性能搞好", 2),
      user("不对，是先把卡顿修了", 3),
      goal("g2", "先修卡顿", 4, { input: { goal: "先修卡顿", why: "用户改口", by: "user" } }),
      goal("g3", "先修卡顿并回归", 5, { input: { goal: "先修卡顿并回归", why: "发现还有回归", by: "self" } }),
    ];
    assertEquivalent(records, "目标");
  });

  it("子会话挂步：显式 planStep / 计划里写 id / 标题推断 / 挂不上", () => {
    const childA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const childB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    const childC = "cccccccc-3333-4333-8333-cccccccccccc";
    const childD = "dddddddd-4444-4444-8444-dddddddddddd";
    const records = [
      user("并行做", 1),
      plan("p1", [
        { text: "调研", status: "done" },
        { text: "写实现", status: "in_progress" },
        { text: "补测试", status: "pending" },
      ], 2),
      // 显式 planStep
      delegate("d1", childA, "随便什么标题", 3, "写实现"),
      // 计划条目里写了 childB 的 id 前缀
      plan("p2", [
        { text: "调研", status: "done" },
        { text: "写实现", status: "in_progress" },
        { text: `补测试（子会话 ${childB.slice(0, 8)} 在做）`, status: "waiting", waitingFor: "等它" },
      ], 4),
      delegate("d2", childB, "另一个", 5),
      // 标题推断：派出时在做的步是「写实现」，标题像「补测试」
      delegate("d3", childC, "补测试的活", 6),
      // 挂不上：没有计划时没有候选
      user("插一句", 7),
      delegate("d4", childD, "孤儿", 8),
    ];
    assertEquivalent(records, "挂步");
    const folded = foldStatusRecords(records);
    const assign = delegationSteps(folded.slim, planTimeline(folded.slim));
    assert.equal(assign.get(childA), planTimeline(folded.slim)?.current.items[1]?.id);
  });

  it("产物：演示文稿 / 文档 / 导出 / 看板 / 点名网页 / 图片 / 音视频", () => {
    const records = [
      user("做一套东西", 1),
      assistant([toolCall("s1", "slides_create", { title: "汇报" })], 2),
      tool("s1", "slides_create", "complete", 3, { details: { card: { kind: "slides", path: "/w/汇报.slides.json", title: "汇报" } } }),
      assistant([toolCall("s2", "slides_write", { path: "/w/汇报.slides.json" })], 4),
      tool("s2", "slides_write", "complete", 5, { content: [{ type: "text", text: "the deck now has 4 slide(s)" }] }),
      assistant([toolCall("e1", "slides_export", { path: "/w/汇报.slides.json", format: "pdf" })], 6),
      tool("e1", "slides_export", "complete", 7, { details: { card: { kind: "export", path: "/w/汇报.pdf", title: "汇报", subtitle: "PDF · 4 页" } } }),
      assistant([toolCall("b1", "show_plugin_board", {})], 8),
      tool("b1", "show_plugin_board", "complete", 9, {
        details: { pluginBoard: { plugin: "p1", displayName: "P1", title: "看板", source: "installed", at: 9, cards: [] } },
      }),
      assistant([{ type: "text", text: "页面在 /w/page.html，图在 /w/chart.png，片子在 /w/demo.mp4" }], 10),
      fileTurn(["/w/page.html", "/w/chart.png"], 11, { mediaArtifacts: [{ path: "/w/demo.mp4", duration: 12 }] }),
    ];
    assertEquivalent(records, "产物");
    const kinds = digestOutputs(foldStatusRecords(records)).map((o) => o.kind);
    assert.ok(kinds.includes("slides") && kinds.includes("pdf") && kinds.includes("board") && kinds.includes("web") && kinds.includes("image") && kinds.includes("video"));
  });

  it("终端与在跑调用：terminal_execute 抽取 + running quirk", () => {
    const records = [
      user("起服务", 1),
      assistant([toolCall("t1", "terminal_execute", { command: "bun run dev" })], 2),
      tool("t1", "terminal_execute", "complete", 3, {
        input: { command: "bun run dev" },
        content: [{ type: "text", text: "opened visible terminal term-1 (zsh)" }],
      }),
      assistant([toolCall("t2", "terminal_read", { terminalId: "term-1" })], 4),
    ];
    assertEquivalent(records, "终端");
    const folded = foldStatusRecords(records);
    assert.deepEqual(digestTerminals(folded), [{ id: "term-1", command: "bun run dev", since: 3 }]);
    assert.deepEqual(digestChildActivity(folded), { toolName: "terminal_read", input: { terminalId: "term-1" }, since: 4 });
  });

  it("通道标记是「这一轮」的边界：交回后挂步收口", () => {
    const childA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    const records = [
      user("去查一下", 1),
      plan("p1", [{ text: "查证", status: "in_progress" }], 2),
      delegate("d1", childA, "查证", 3),
      channelMark(4),
      plan("p2", [{ text: "查证", status: "done" }], 5),
    ];
    assertEquivalent(records, "通道");
  });
});
