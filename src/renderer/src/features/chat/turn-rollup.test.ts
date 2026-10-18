/**
 * 大折叠（groupTurns / turnStats）的测试：分组时机、正文与界碑留在外面、
 * 轮耗时跨度、统计聚合（含现场计时求和的冻结语义）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  failedFoldKey,
  flattenRenderUnits,
  groupToolUnits,
  groupTurns,
  indexToolResults,
  rollupLead,
  thinkingDurationText,
  turnStats,
  type TurnGroupUnit,
  type TurnViewEntry,
} from "./tool-results.ts";
import { en } from "../../messages-en.ts";

function userItem(id: string, timestamp: number): TranscriptItem {
  return { id, role: "user", content: [{ type: "text", text: "hi" }], timestamp } as TranscriptItem;
}

function assistantItem(id: string, timestamp: number, blocks: unknown[]): TranscriptItem {
  return { id, role: "assistant", content: blocks, timestamp } as TranscriptItem;
}

function toolItem(
  overrides: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">,
): TranscriptItem {
  return {
    id: `item-${overrides.toolCallId}`,
    role: "tool",
    toolName: "read",
    input: {},
    content: [],
    timestamp: 0,
    status: "complete",
    isError: false,
    ...overrides,
  } as TranscriptItem;
}

const compacted = {
  role: "compacted",
  id: "c1",
  summary: "摘要",
  tokensBefore: 1000,
  timestamp: 5,
} as const;

function turnView(records: readonly TranscriptItem[], turnActive: boolean): TurnViewEntry[] {
  return groupTurns(groupToolUnits(flattenRenderUnits(records)), turnActive, indexToolResults(records));
}

function foldUnits(view: readonly TurnViewEntry[]): TurnGroupUnit[] {
  return view.filter((entry): entry is TurnGroupUnit => entry.kind === "turnGroup");
}

describe("groupTurns", () => {
  test("落定轮：思考与工具收进一条，位置在第一个成员处，正文留在外面原位", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "先看看" },
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2500 }),
      assistantItem("a2", 9000, [{ type: "text", text: "看完了" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "text"],
    );
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    // 成员是且只是思考与工具调用，原时间序
    assert.deepEqual(
      fold.members.map((member) => member.kind),
      ["thinking", "toolCall"],
    );
    // key 挂在首成员上（跨渲染稳定）；段耗时 = 成员 timestamp 极差（工具以结果终态为右端）
    assert.equal(fold.key, "turn:a1:0");
    assert.equal(fold.durationMs, 500);
    // 轮头时间 = 段内最早的 assistant 记录 timestamp（这轮开始流式回复的时刻）
    assert.equal(fold.startedAt, 2000);
  });

  test("活跃轮原样铺开，已落定的前段照收——折叠只发生在落定的轮次上", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "第一轮" }]),
      userItem("u2", 3000),
      assistantItem("a2", 4000, [{ type: "thinking", thinking: "第二轮还在跑" }]),
    ];
    assert.deepEqual(
      turnView(records, true).map((entry) => entry.kind),
      ["user", "turnGroup", "user", "thinking"],
    );
    assert.deepEqual(
      turnView(records, false).map((entry) => entry.kind),
      ["user", "turnGroup", "user", "turnGroup"],
    );
  });

  test("纯正文段没有可收的成员——原样放行，不包折叠壳", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "直接回答" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "text"],
    );
  });

  test("轮内穿插的正文留在外面：折叠在原地替换成员，不重排正文", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "先说明思路" }]),
      assistantItem("a2", 3000, [{ type: "toolCall", toolCallId: "r1", toolName: "read", input: {} }]),
      toolItem({ toolCallId: "r1", timestamp: 3500 }),
      assistantItem("a3", 4000, [{ type: "text", text: "最终结论" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "text", "turnGroup", "text"],
    );
    // 前导正文不在 members 里，但轮头时间仍取到它（首条 assistant 的开始时刻）
    assert.equal(foldUnits(view)[0]?.startedAt, 2000);
  });

  test("界碑与用户气泡是轮边界，永远在外面；界碑劈开前后的轮", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "被压缩前" }]),
      compacted as unknown as TranscriptItem,
      userItem("u2", 3000),
      assistantItem("a2", 4000, [{ type: "thinking", thinking: "被压缩后" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "compacted", "user", "turnGroup"],
    );
  });

  test("通道标记是轮边界（子会话 2026-09-23 不变量修正），同 user/界碑：开新段、不进折叠", () => {
    const mark = {
      role: "channel-mark",
      id: "k1",
      peerId: "child-1",
      messageId: "m1",
      from: "child",
      kind: "question",
      timestamp: 2500,
    } as const;
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "标记前" }]),
      mark as unknown as TranscriptItem,
      assistantItem("a2", 3000, [{ type: "thinking", thinking: "标记后" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "channelMark", "turnGroup"],
    );
  });

  test("折叠位置跟着第一个成员走：正文①在折叠之前，正文②在折叠之后", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "正文①" }]),
      assistantItem("a2", 3000, [{ type: "thinking", thinking: "想想" }]),
      assistantItem("a3", 4000, [{ type: "text", text: "正文②（最终）" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => (entry.kind === "turnGroup" ? "turnGroup" : entry.kind)),
      ["user", "text", "turnGroup", "text"],
    );
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    assert.deepEqual(fold.members.map((member) => member.kind), ["thinking"]);
  });

  test("正文切段：成员之间的穿插正文留在原位，前后各成一个折叠（正文永不折叠，2026-10-18 裁决）", () => {
    // 取代 BUG-6 的「穿插正文收进折叠」：正文一个都不折叠——text 是分组边界，
    // 遇正文先收口、正文原样放行，正文之后的成员开新的一段折叠。
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "text", text: "开场白" }]),
      assistantItem("a2", 3000, [{ type: "toolCall", toolCallId: "r1", toolName: "read", input: {} }]),
      toolItem({ toolCallId: "r1", timestamp: 3500 }),
      assistantItem("a3", 4000, [{ type: "text", text: "中间陈述" }]),
      assistantItem("a4", 5000, [{ type: "toolCall", toolCallId: "r2", toolName: "bash", input: {} }]),
      toolItem({ toolCallId: "r2", timestamp: 5500 }),
      assistantItem("a5", 6000, [{ type: "text", text: "结尾回复" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "text", "turnGroup", "text", "turnGroup", "text"],
    );
    const [first, second] = foldUnits(view);
    assert.ok(first !== undefined && second !== undefined);
    // 每段折叠的成员是且只是工具调用——members 类型层已不含 text
    assert.deepEqual(first.members.map((member) => member.kind), ["toolCall"]);
    assert.deepEqual(second.members.map((member) => member.kind), ["toolCall"]);
    // 轮头时间只挂第一个折叠块（含前导正文的首条 assistant 时刻）；后续块不带
    assert.equal(first.startedAt, 2000);
    assert.equal(second.startedAt, null);
    // 各自的段耗时：工具以结果终态为右端
    assert.equal(first.durationMs, 500);
    assert.equal(second.durationMs, 500);
    // 统计按段各自聚合：每段只数自己的工具
    const results = indexToolResults(records);
    assert.equal(turnStats(first, results).calls, 1);
    assert.equal(turnStats(second, results).calls, 1);
  });

  test("「思考 → 开场白 → 工具 → 正文」：开场白把首条思考单独切成一段——单时间戳段时长为 null（诚实未知，不显示「Worked 0.0s」），后续段口径不变", () => {
    // 2026-10-18 真机验收反馈：这一段只有一条记录、一个时间戳，极差为 0，
    // 折叠行曾显示「用时 0.0 秒」——模型实际想了几秒，这个数是编造。
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "先想想" },
        { type: "text", text: "开场白" },
      ]),
      assistantItem("a2", 3000, [{ type: "toolCall", toolCallId: "r1", toolName: "read", input: {} }]),
      toolItem({ toolCallId: "r1", timestamp: 3500 }),
      assistantItem("a3", 4000, [{ type: "text", text: "结论" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "text", "turnGroup", "text"],
    );
    const [first, second] = foldUnits(view);
    assert.ok(first !== undefined && second !== undefined);
    // 第一段：只有一个思考块、一个记录级时间戳，跨度量不到 → null；轮头时间照挂首块
    assert.deepEqual(first.members.map((member) => member.kind), ["thinking"]);
    assert.equal(first.durationMs, null);
    assert.equal(first.startedAt, 2000);
    // 第二段：调用帧 + 结果终态两个时刻，口径不变（仍以结果终态为右端）
    assert.equal(second.durationMs, 500);
    assert.equal(second.startedAt, null);
    // turnStats 原样透传 null——渲染层据此不显示 Worked 段，只留「thought 1」
    assert.equal(turnStats(first, indexToolResults(records)).durationMs, null);
  });

  test("只有一条记录的段：思考独占一条记录时 durationMs 为 null，不编造 0.0s", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "想想" }]),
      assistantItem("a2", 3000, [{ type: "text", text: "正文" }]),
    ];
    const fold = foldUnits(turnView(records, false))[0];
    assert.ok(fold !== undefined);
    assert.equal(fold.durationMs, null);
  });

  test("即时工具段（极差不足显示精度 50ms）：durationMs 为 null——「0.0 秒」没有信息量", () => {
    // write/edit 这类几毫秒落定的工具，极差为正但不足 0.1 秒刻度；同记录
    // 「思考+工具」段同理（显示的只是工具尾巴，思考时间不在极差里）
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: {} }]),
      toolItem({ toolCallId: "w1", toolName: "write", timestamp: 2030 }),
      assistantItem("a2", 3000, [{ type: "text", text: "写好了" }]),
    ];
    const fold = foldUnits(turnView(records, false))[0];
    assert.ok(fold !== undefined);
    assert.equal(fold.durationMs, null);
  });

  test("多条记录的段时长口径不变：两个思考来自不同记录，极差为正照显", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "第一段" }]),
      assistantItem("a2", 3500, [{ type: "thinking", thinking: "第二段" }]),
    ];
    const fold = foldUnits(turnView(records, false))[0];
    assert.ok(fold !== undefined);
    assert.equal(fold.durationMs, 1500);
  });

  test("空白 text 块不当边界：不断开折叠、也不落视图", () => {
    // 流式常产生空 text delta 落块；拿它断开折叠会凭空多出一条统计行
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "toolCall", toolCallId: "r1", toolName: "read", input: {} }]),
      toolItem({ toolCallId: "r1", timestamp: 2500 }),
      assistantItem("a2", 3000, [{ type: "text", text: "   " }]),
      assistantItem("a3", 4000, [{ type: "thinking", thinking: "再想想" }]),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup"],
    );
    assert.deepEqual(
      foldUnits(view)[0]?.members.map((member) => member.kind),
      ["toolCall", "thinking"],
    );
  });

  test("key 稳定：同一段重复分组 key 不变——展开状态靠它保住", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "想想" }]),
    ];
    const first = foldUnits(turnView(records, false))[0];
    const second = foldUnits(turnView(records, false))[0];
    assert.ok(first !== undefined && second !== undefined);
    assert.equal(first.key, second.key);
  });

  test("通道工具（delegate）不算轮成员：一轮里 thinking + read + delegate 落定后，delegate 在折叠外、read 在折叠内（子会话 PR4b 显示缺陷修正）", () => {    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "先看看" },
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2500 }),
      assistantItem("a2", 3000, [
        { type: "toolCall", toolCallId: "d1", toolName: "delegate", input: { task: "审一下" } },
      ]),
      toolItem({ toolCallId: "d1", toolName: "delegate", timestamp: 3500 }),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "toolCall"],
    );
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    // delegate 不在成员里——只有思考与 read 被收进折叠
    assert.deepEqual(
      fold.members.map((member) => member.kind),
      ["thinking", "toolCall"],
    );
    // 折叠外那个 toolCall 就是 delegate 本身，位置不变（紧跟在折叠后面）
    const trailing = view[2];
    assert.ok(trailing !== undefined && trailing.kind === "toolCall");
    assert.equal(trailing.kind === "toolCall" ? trailing.toolName : "", "delegate");
  });

  test("show_image 夹在轮中间（图后还有思考+工具）也挂轮尾：单一折叠 + 画廊贴正文前，不产生两折叠夹画廊（2026-09-27 裁决 Y′）", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "先找图" },
        { type: "toolCall", toolCallId: "p1", toolName: "read_pdf", input: { path: "x.pdf" } },
      ]),
      toolItem({ toolCallId: "p1", toolName: "read_pdf", timestamp: 2500 }),
      assistantItem("a2", 3000, [{ type: "toolCall", toolCallId: "s1", toolName: "show_image", input: { paths: ["a.png"] } }]),
      toolItem({ toolCallId: "s1", toolName: "show_image", timestamp: 3500 }),
      assistantItem("a3", 4000, [
        { type: "thinking", thinking: "再看一眼" },
        { type: "toolCall", toolCallId: "r2", toolName: "read", input: { path: "b.ts" } },
      ]),
      toolItem({ toolCallId: "r2", timestamp: 4500 }),
      assistantItem("a4", 9000, [{ type: "text", text: "结论在此" }]),
    ];
    const view = turnView(records, false);
    // 单一折叠收进全部思考与工具（含 show 前后的），画廊钉在折叠后、正文前
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "toolCall", "text"],
    );
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    // show_image 不进 members——画廊行在折叠外
    assert.ok(fold.members.every((member) => !(member.kind === "toolCall" && member.toolName === "show_image")));
    const gallery = view[2];
    assert.ok(gallery !== undefined && gallery.kind === "toolCall");
    assert.equal(gallery.kind === "toolCall" ? gallery.toolName : "", "show_image");
  });

  test("通道工具夹在两次真实工具调用中间时同样被抠出来，前后各自成一个折叠，位置不变", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: {} },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2500 }),
      assistantItem("a2", 3000, [
        { type: "toolCall", toolCallId: "s1", toolName: "reply_subsession", input: {} },
      ]),
      toolItem({ toolCallId: "s1", toolName: "reply_subsession", timestamp: 3500 }),
      assistantItem("a3", 4000, [
        { type: "toolCall", toolCallId: "e1", toolName: "edit", input: {} },
      ]),
      toolItem({ toolCallId: "e1", toolName: "edit", timestamp: 4500 }),
    ];
    const view = turnView(records, false);
    assert.deepEqual(
      view.map((entry) => entry.kind),
      ["user", "turnGroup", "toolCall", "turnGroup"],
    );
    const folds = foldUnits(view);
    assert.equal(folds.length, 2);
    assert.deepEqual(folds[0]?.members.map((m) => m.kind), ["toolCall"]);
    assert.deepEqual(folds[1]?.members.map((m) => m.kind), ["toolCall"]);
    const middle = view[2];
    assert.ok(middle !== undefined && middle.kind === "toolCall");
    assert.equal(middle.kind === "toolCall" ? middle.toolName : "", "reply_subsession");
  });
});

describe("turnStats", () => {
  test("工具计数跨组与单行聚合；失败与进行中分档；byTool 保持首次出现序", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: {} },
        { type: "toolCall", toolCallId: "r2", toolName: "read", input: {} },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2100 }),
      toolItem({ toolCallId: "r2", timestamp: 2200 }),
      assistantItem("a2", 3000, [
        { type: "thinking", thinking: "再跑个命令" },
        { type: "toolCall", toolCallId: "b1", toolName: "bash", input: {} },
        { type: "toolCall", toolCallId: "b2", toolName: "bash", input: {} },
      ]),
      toolItem({ toolCallId: "b1", toolName: "bash", status: "error", isError: true, timestamp: 3100 }),
      toolItem({ toolCallId: "b2", toolName: "bash", status: "running", isError: false, timestamp: 3200 }),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    const stats = turnStats(fold, indexToolResults(records), 5000);
    assert.equal(stats.calls, 4);
    assert.equal(stats.thinkingCount, 1);
    // 失败数按工具跟各自的类别走：read 全成、bash 一败一跑；进行中不算失败
    assert.deepEqual(stats.byTool, [
      { toolName: "read", count: 2, failed: 0 },
      { toolName: "bash", count: 2, failed: 1 },
    ]);
    // 段耗时 = 成员 timestamp 极差（不含 user，工具以结果终态为右端）
    assert.equal(stats.durationMs, 3200 - 2000);
  });

  test("通道工具（report_to_parent）不进折叠统计——calls/byTool 里没有它（子会话 PR4b）", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: {} },
        { type: "toolCall", toolCallId: "p1", toolName: "report_to_parent", input: {} },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2100 }),
      toolItem({ toolCallId: "p1", toolName: "report_to_parent", timestamp: 2200 }),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    const stats = turnStats(fold, indexToolResults(records), 5000);
    assert.equal(stats.calls, 1);
    assert.deepEqual(stats.byTool, [{ toolName: "read", count: 1, failed: 0 }]);
  });

  test("思考总时长 = 现场计时求和（冻结副作用），次数单独数块", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "thinking", thinking: "第一段" },
        { type: "thinking", thinking: "第二段" },
      ]),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    // 真实交接序列：第一块流式起表，第二块接管时第一块冻结（交接渲染），
    // 第二块起表——落定后 turnStats 把还没冻的第二块冻在 now
    thinkingDurationText("a1:0", true, en, 1000);
    thinkingDurationText("a1:0", false, en, 2000);
    thinkingDurationText("a1:1", true, en, 2000);
    const stats = turnStats(fold, indexToolResults([]), 5000);
    assert.equal(stats.thinkingMs, 4000);
    assert.equal(stats.thinkingCount, 2);
    // 冻结之后成员行展开也能读到同一份落定时长
    assert.equal(thinkingDurationText("a1:1", false, en, 9999), "3s");
  });

  test("任一思考块没见过现场（旧会话）→ 整个 thinkingMs 为 null，不显示部分和", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [{ type: "thinking", thinking: "见过" }]),
      assistantItem("a2", 3000, [{ type: "thinking", thinking: "没见过" }]),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    thinkingDurationText("a1:0", true, en, 1500);
    const stats = turnStats(fold, indexToolResults([]), 5000);
    assert.equal(stats.thinkingMs, null);
    assert.equal(stats.thinkingCount, 2);
  });

  test("没有思考的轮 thinkingMs 为 0（不是 null）、次数为 0——头部不显示思考段", () => {
    const records = [
      userItem("u1", 1000),
      assistantItem("a1", 2000, [
        { type: "toolCall", toolCallId: "r1", toolName: "read", input: {} },
      ]),
      toolItem({ toolCallId: "r1", timestamp: 2100 }),
    ];
    const view = turnView(records, false);
    const fold = foldUnits(view)[0];
    assert.ok(fold !== undefined);
    const stats = turnStats(fold, indexToolResults(records));
    assert.equal(stats.thinkingMs, 0);
    assert.equal(stats.thinkingCount, 0);
  });
});

describe("failedFoldKey —— 回合级失败的图标只在失败轮里找折叠", () => {
  const settledTurn: TranscriptItem[] = [
    userItem("u1", 0),
    assistantItem("a1", 1, [
      { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } },
    ]),
    toolItem({ toolCallId: "r1", timestamp: 2 }),
    assistantItem("a2", 3, [{ type: "text", text: "读完了。" }]),
  ];

  test("失败轮有折叠（工具跑了才断）：拿那一轮的折叠 key", () => {
    const records = [
      ...settledTurn,
      userItem("u2", 10),
      assistantItem("a3", 11, [
        { type: "toolCall", toolCallId: "r2", toolName: "read", input: { path: "b.ts" } },
      ]),
      toolItem({ toolCallId: "r2", timestamp: 12 }),
    ];
    const view = turnView(records, false);
    const folds = foldUnits(view);
    assert.equal(folds.length, 2);
    assert.equal(failedFoldKey(view), folds[1]?.key);
  });

  test("失败轮没折叠（模型开口前就断）：null，不拿上一轮的", () => {
    const view = turnView([...settledTurn, userItem("u2", 10)], false);
    assert.equal(foldUnits(view).length, 1);
    assert.equal(failedFoldKey(view), null);
  });

  test("界碑也是轮边界：界碑后没折叠就 null", () => {
    const view = groupTurns(
      groupToolUnits(flattenRenderUnits([...settledTurn, compacted as never])),
      false,
    );
    assert.equal(failedFoldKey(view), null);
  });

  test("通道标记同样是轮边界（子会话 2026-09-23 不变量修正）：标记后没折叠就 null", () => {
    const mark = {
      role: "channel-mark",
      id: "k1",
      peerId: "child-1",
      messageId: "m1",
      from: "child",
      kind: "question",
      timestamp: 20,
    } as const;
    const view = groupTurns(groupToolUnits(flattenRenderUnits([...settledTurn, mark as never])), false);
    assert.equal(failedFoldKey(view), null);
  });

  test("空视图 null", () => {
    assert.equal(failedFoldKey([]), null);
  });
});

describe("rollupLead —— 折叠行的加粗开头由哪一段担任", () => {
  test("量得到时长：开头是「用时」", () => {
    assert.equal(rollupLead({ durationMs: 7100, thinkingCount: 1, calls: 1 }), "duration");
  });
  test("量不到时长、有思考：思考数顶上（「thought 1」那种单独思考段）", () => {
    assert.equal(rollupLead({ durationMs: null, thinkingCount: 1, calls: 0 }), "thinking");
    assert.equal(rollupLead({ durationMs: null, thinkingCount: 2, calls: 3 }), "thinking");
  });
  test("量不到时长、只有工具：工具数顶上（「tools 1 · bash 1」那种即时工具段）", () => {
    assert.equal(rollupLead({ durationMs: null, thinkingCount: 0, calls: 1 }), "tools");
  });
  test("什么统计都没有：没有开头", () => {
    assert.equal(rollupLead({ durationMs: null, thinkingCount: 0, calls: 0 }), null);
  });
});
