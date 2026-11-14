/**
 * 「一轮一行」过程显示：分组（groupTurnsByTurn）+ 章节 / 计数 / 现场快照的推导。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  bashLiveFacts,
  bashResultFacts,
  bashResultOf,
  detachedBashNotice,
  flattenRenderUnits,
  groupToolUnits,
  groupTurns,
  groupTurnsByTurn,
  indexToolResults,
  turnStats,
  type TurnGroupUnit,
  type TurnProcessUnit,
  type TurnViewEntry,
} from "./tool-results.ts";
import { firstLine, processChapters, processCounts, processLive, processOutcome } from "./turn-process.ts";
import { zh } from "../../messages-zh.ts";

const user = (id: string, timestamp: number): TranscriptItem =>
  ({ id, role: "user", content: [{ type: "text", text: "hi" }], timestamp }) as TranscriptItem;
const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
  ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
  ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
const call = (id: string, toolName = "read", input: unknown = { path: `${id}.ts` }) => ({ type: "toolCall", toolCallId: id, toolName, input });

function view(records: readonly TranscriptItem[], active: boolean): TurnViewEntry[] {
  return groupTurnsByTurn(groupToolUnits(flattenRenderUnits(records)), active, indexToolResults(records));
}
const procOf = (v: readonly TurnViewEntry[]) => v.filter((e): e is TurnProcessUnit => e.kind === "turnProcess");

// 一轮：旁白 → 读 → 旁白 → bash（失败）→ 写 → 结尾回答
const turn = [
  user("u1", 1000),
  assistant("a1", 2000, [{ type: "text", text: "我先读一下代码。" }, call("r1")]),
  tool({ toolCallId: "r1", timestamp: 2600 }),
  assistant("a2", 3000, [{ type: "thinking", thinking: "看测试\n再跑" }, { type: "text", text: "接下来跑一遍检查。" }, call("b1", "bash", { command: "ls x" })]),
  tool({ toolCallId: "b1", toolName: "bash", timestamp: 3400, status: "error" }),
  assistant("a3", 4000, [call("w1", "write", { path: "notes/a.md" })]),
  tool({ toolCallId: "w1", toolName: "write", timestamp: 4100 }),
  assistant("a4", 5000, [{ type: "text", text: "查完了。" }]),
];

describe("groupTurnsByTurn", () => {
  test("落定轮：旁白收进块当章节，一轮一个块，结尾回答留在外面", () => {
    const v = view(turn, false);
    assert.deepEqual(v.map((e) => e.kind), ["user", "text", "turnProcess", "text"]);
    const [proc] = procOf(v);
    assert.ok(proc !== undefined);
    assert.equal(proc.live, false);
    // 第一个工具之前的旁白在块外（它在第一个过程成员之前）；第二句旁白在块里
    assert.deepEqual(proc.steps.map((s) => s.kind), ["toolCall", "thinking", "text", "toolCall", "toolCall"]);
    assert.equal(proc.durationMs, 4100 - 2000);
  });

  test("活跃轮：块是 live；块后已有正文在流 = answering", () => {
    const live = turn.slice(0, 5);
    const [proc] = procOf(view(live, true));
    assert.equal(proc?.live, true);
    assert.equal(proc?.answering, false);
    const [answering] = procOf(view(turn, true));
    assert.equal(answering?.answering, true);
  });

  test("还没调工具的活跃轮没有块（只有正文在流）", () => {
    const v = view([user("u1", 1), assistant("a1", 2, [{ type: "text", text: "好的" }])], true);
    assert.deepEqual(v.map((e) => e.kind), ["user", "text"]);
  });

  test("key 从活跃到落定不变（展开状态保得住）", () => {
    assert.equal(procOf(view(turn, true))[0]?.key, procOf(view(turn, false))[0]?.key);
  });
});

describe("章节与计数", () => {
  const results = indexToolResults(turn);
  const proc = procOf(view(turn, false))[0];
  assert.ok(proc !== undefined);

  test("按说的话切章；没有旁白的开头一章按工具归类（标题 null）", () => {
    const chapters = processChapters(proc.steps);
    assert.deepEqual(
      chapters.map((c) => [c.source, c.title, c.calls.map((x) => x.toolCallId)]),
      [
        ["tools", null, ["r1"]],
        ["say", "接下来跑一遍检查。", ["b1", "w1"]],
      ],
    );
  });

  test("没有旁白时，章标题取第一段思考的第一行", () => {
    const steps = procOf(view([user("u", 1), assistant("a", 2, [{ type: "thinking", thinking: "\n## 先看结构\n细节" }, call("r")]), tool({ toolCallId: "r", timestamp: 3 }), assistant("z", 4, [{ type: "text", text: "好" }])], false))[0]?.steps ?? [];
    assert.deepEqual(processChapters(steps).map((c) => [c.source, c.title]), [["think", "先看结构"]]);
  });

  test("计数：步数、按工具、失败、写过的文件（失败的写不算）", () => {
    const counts = processCounts(proc.steps, results);
    assert.equal(counts.steps, 3);
    assert.equal(counts.failed, 1);
    assert.deepEqual(counts.files, ["notes/a.md"]);
    // 这里写的是 notes/a.md：落在文档文件上的 write 单算「doc_write」（统计行写「写文档」），其余照旧
    assert.deepEqual(counts.byTool.map((b) => b.key).sort(), ["bash", "doc_write", "read"]);
  });

  test("写计划不算一步", () => {
    const records = [user("u", 1), assistant("a", 2, [call("p", "update_plan", { items: [] }), call("r")]), tool({ toolCallId: "p", toolName: "update_plan", timestamp: 3 }), tool({ toolCallId: "r", timestamp: 3 }), assistant("z", 4, [{ type: "text", text: "好" }])];
    const steps = procOf(view(records, false))[0]?.steps ?? [];
    const counts = processCounts(steps, indexToolResults(records));
    assert.equal(counts.steps, 1);
    assert.deepEqual(counts.byTool.map((b) => b.key), ["read"]);
  });

  test("firstLine 剥 markdown 前缀", () => {
    assert.equal(firstLine("\n- 一条"), "一条");
    assert.equal(firstLine("   "), null);
  });
});

describe("processLive", () => {
  test("有工具没结果 = 在跑这一步；最近完成的几步按旧到新", () => {
    const records = [...turn.slice(0, 5), assistant("a3", 4000, [call("w1", "write", { path: "n.md" })])];
    const proc = procOf(view(records, true))[0];
    assert.ok(proc !== undefined);
    const live = processLive(proc, indexToolResults(records), () => 3900);
    assert.equal(live.now.kind, "tool");
    assert.deepEqual(live.trail.map((x) => [x.call.toolCallId, x.failed]), [["r1", false], ["b1", true]]);
    assert.deepEqual(live.chapter, { title: "接下来跑一遍检查。", source: "say" });
  });

  test("没有工具在跑 = 在想，从最后一个事件起算", () => {
    const records = turn.slice(0, 7);
    const proc = procOf(view(records, true))[0];
    assert.ok(proc !== undefined);
    const live = processLive(proc, indexToolResults(records), () => null);
    assert.deepEqual(live.now, { kind: "think", since: 4100, preview: null });
  });
});

describe("processOutcome —— 落定那一行开头说什么（不写「0 步」）", () => {
  test("纯思考的一轮（想了就答）：说想了想，不是 0 步", () => {
    const records = [user("u", 1), assistant("a", 2, [{ type: "thinking", thinking: "想一想" }, { type: "text", text: "答" }])];
    const proc = procOf(view(records, false))[0];
    assert.ok(proc !== undefined, "纯思考的轮也有一块过程（思考是过程的一步）——否则这条考题测不到");
    const counts = processCounts(proc.steps, indexToolResults(records));
    assert.equal(counts.steps, 0);
    assert.deepEqual(processOutcome(counts, proc.steps), { kind: "thought" });
  });

  test("只写了计划的一轮：说更新了计划", () => {
    const records = [user("u", 1), assistant("a", 2, [call("p", "update_plan", { items: [] })]), tool({ toolCallId: "p", toolName: "update_plan", timestamp: 3 }), assistant("z", 4, [{ type: "text", text: "好" }])];
    const proc = procOf(view(records, false))[0];
    assert.ok(proc !== undefined);
    assert.deepEqual(processOutcome(processCounts(proc.steps, indexToolResults(records)), proc.steps), { kind: "plan" });
  });

  test("跑过工具：步数与写过的文件照旧", () => {
    const results = indexToolResults(turn);
    const proc = procOf(view(turn, false))[0];
    assert.ok(proc !== undefined);
    assert.deepEqual(processOutcome(processCounts(proc.steps, results), proc.steps), { kind: "work", steps: 3, files: 1 });
  });
});

describe("后台命令行（交还出去的 bash 会话）不随回合结束消失", () => {
  // 签到点交还后的工具结果：文本尾部带这一行，会话说它还在后台跑
  const DETACH_NOTICE = "[orbita] kind=detached session=b1 elapsed=300s lifetime=1800s | 已交还控制权。";
  const COMMAND = "sleep 900 && echo done";
  const detachedCall = call("b1", "bash", { command: COMMAND });
  // 落定那一轮写回的终态记录：同一个 toolCallId，details 带会话账（runtime.ts 的 bashResultProgress）
  const terminal = tool({
    id: "tb1",
    toolCallId: "b1",
    toolName: "bash",
    input: { command: COMMAND },
    timestamp: 1_200_000,
    content: [{ type: "text", text: "done\n\n[orbita] b1 · 退出 0" }],
    details: {
      orbitaBash: { sessionId: "b1", status: "finished", exitCode: 0, elapsedSeconds: 900, command: COMMAND },
    },
  });
  // 一轮：思考 → 对着干了 5 分钟的长命令 → （交还）→ 模型说「它在后台跑」收尾
  const turnWith = (records: readonly TranscriptItem[]) => [
    user("u1", 1000),
    assistant("a1", 2000, [{ type: "thinking", thinking: "跑一条长命令" }, detachedCall]),
    tool({ id: "tb1", toolCallId: "b1", toolName: "bash", input: { command: COMMAND }, timestamp: 302_000, content: [{ type: "text", text: DETACH_NOTICE }] }),
    ...records,
    assistant("a2", 1_201_000, [{ type: "text", text: "已经在后台跑起来了进程 b1。" }]),
  ];

  test("回合落定后行提到折叠外：章节里没有它，块头仍数得上这一步", () => {
    const records = turnWith([]);
    const results = indexToolResults(records);
    const [proc] = procOf(view(records, false));
    assert.ok(proc !== undefined);
    // 折叠体（展开后的章节）里没有它——但它就在折叠外面，永远渲染
    assert.deepEqual(proc.steps.flatMap((step) => (step.kind === "toolCall" ? [step.toolCallId] : [])), []);
    assert.deepEqual(proc.hoisted.map((c) => c.toolCallId), ["b1"]);
    // 统计不丢：块头仍写「1 步 · bash 1」（调用方把 hoisted 接回计数）
    assert.equal(processCounts([...proc.steps, ...proc.hoisted], results).steps, 1);
  });

  test("跑着的事实槽 = 本地秒针 + 上限；还没落定 → 出停止钮", () => {
    const results = indexToolResults(turnWith([]));
    const result = results.get("b1");
    const notice = detachedBashNotice(result);
    assert.ok(notice !== null);
    // ToolLine 的 bashRunning = 认出交还 && 还没有会话终态 → 行尾是停止钮
    assert.equal(bashResultOf(result), null);
    // 秒针本地外推：交还时 300s，交还之后自己又跳了 454s
    assert.equal(bashLiveFacts(notice, notice.elapsedSeconds + 454, zh).text, "b1 · 已 12:34 · 上限 30:00");
    assert.equal(bashLiveFacts(notice, 300, zh).tone, "live");
  });

  test("落定后同一行仍在折叠外，事实翻成结果词（停止钮的条件消失）", () => {
    const records = turnWith([terminal]);
    const results = indexToolResults(records);
    const [proc] = procOf(view(records, false));
    assert.ok(proc !== undefined);
    assert.deepEqual(proc.hoisted.map((c) => c.toolCallId), ["b1"]);
    const meta = bashResultOf(results.get("b1"));
    assert.ok(meta !== null);
    assert.equal(bashResultFacts(meta, zh).text, "b1 · 退出 0 · 共 15:00");
  });

  test("逐步铺开（大折叠）同理：成员里摘掉，行挂在折叠行下面、统计照旧", () => {
    const records = turnWith([]);
    const results = indexToolResults(records);
    const v = groupTurns(groupToolUnits(flattenRenderUnits(records)), false, results);
    const group = v.find((entry): entry is TurnGroupUnit => entry.kind === "turnGroup");
    assert.ok(group !== undefined);
    assert.deepEqual(group.members.flatMap((m) => (m.kind === "toolCall" ? [m.toolCallId] : [])), []);
    assert.deepEqual(group.hoisted.map((c) => c.toolCallId), ["b1"]);
    const stats = turnStats({ ...group, members: [...group.members, ...group.hoisted] }, results);
    assert.equal(stats.calls, 1);
    assert.deepEqual(stats.byTool.map((t) => [t.toolName, t.count]), [["bash", 1]]);
  });

  test("没交还过的短命令照旧进折叠（折叠语义不变）", () => {
    const records = [user("u", 1), assistant("a", 2, [call("b", "bash", { command: "ls" })]), tool({ toolCallId: "b", toolName: "bash", timestamp: 3 })];
    const [proc] = procOf(view(records, false));
    assert.ok(proc !== undefined);
    assert.deepEqual(proc.steps.flatMap((step) => (step.kind === "toolCall" ? [step.toolCallId] : [])), ["b"]);
    assert.deepEqual(proc.hoisted, []);
  });

  test("相邻两条 bash 里只有一条交还：组里摘出来单独成行，另一条留在折叠里", () => {
    const records = [
      user("u", 1),
      assistant("a", 2, [call("b1", "bash", { command: "sleep 900" }), call("b2", "bash", { command: "ls" })]),
      tool({ toolCallId: "b1", toolName: "bash", timestamp: 302_000, content: [{ type: "text", text: DETACH_NOTICE }] }),
      tool({ toolCallId: "b2", toolName: "bash", timestamp: 3_000 }),
      assistant("z", 400_000, [{ type: "text", text: "都在跑了。" }]),
    ];
    const [proc] = procOf(view(records, false));
    assert.ok(proc !== undefined);
    assert.deepEqual(proc.hoisted.map((c) => c.toolCallId), ["b1"]);
    // 剩下那条退回单行调用（一组一个还套着组壳是多余的）
    assert.deepEqual(proc.steps.map((step) => (step.kind === "toolCall" ? step.toolCallId : step.kind)), ["b2"]);
  });
});

describe("钉住的看板 / 画廊不随轮尾文件卡换位（2026-11-06：看板回复完变灰 not found）", () => {
  // 插件跑完写了数据文件：轮结束后才补进一张「N 个文件已更改」卡。补卡前后看板的位置必须不变——
  // 换位 = React 搬动它的 DOM 节点 = iframe 重新加载，而看板卡地址是一次性的，重载拿到 404
  const board = [
    user("u1", 1000),
    assistant("a1", 2000, [{ type: "text", text: "我先读技能。" }, call("r1")]),
    tool({ toolCallId: "r1", timestamp: 2100 }),
    assistant("a2", 3000, [call("b1", "bash", { command: "python run.py" })]),
    tool({ toolCallId: "b1", toolName: "bash", timestamp: 3100 }),
    assistant("a3", 4000, [call("sb", "show_plugin_board", { plugin: "lit" })]),
    tool({ toolCallId: "sb", toolName: "show_plugin_board", timestamp: 4100 }),
    assistant("a4", 5000, [{ type: "text", text: "看板在上面。" }]),
  ];
  const fileTurn = { role: "file-turn", id: "ft1", timestamp: 5500, changes: [] } as unknown as TranscriptItem;
  for (const [name, group] of [["一轮一行", groupTurnsByTurn], ["逐步铺开", groupTurns]] as const) {
    test(`${name}：有文件卡时看板仍在结尾回复之前，文件卡殿后`, () => {
      const keys = (records: readonly TranscriptItem[]) =>
        group(groupToolUnits(flattenRenderUnits(records)), false, indexToolResults(records)).map((e) => e.key);
      const before = keys(board);
      const after = keys([...board, fileTurn]);
      const boardAt = after.indexOf("a3:0");
      assert.ok(boardAt >= 0 && boardAt < after.indexOf("a4:0"), `看板应在回复前：${after.join(" ")}`);
      assert.equal(after[after.length - 1], "ft1");
      // 补卡只在末尾追加，其余顺序与补卡前逐个相同（React 不搬动任何已有节点）
      assert.deepEqual(after.slice(0, -1), before);
    });
  }
});
