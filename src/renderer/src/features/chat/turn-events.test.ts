/**
 * 对话流降噪（2026-11-17）：一轮的过程收成一行——子会话交回来的消息、派活、给子会话回话都收进过程块；
 * 过程行的摘要按种类数出来；「过程还是结果」的判定默认归过程。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@shared/transcript";
import type { TranscriptRecord } from "@shared/session";
import {
  flattenRenderUnits,
  groupToolUnits,
  groupTurnsByTurn,
  indexToolResults,
  isChildChannelRecord,
  isProcessEntry,
  type RenderEntry,
  type TurnProcessUnit,
  type TurnViewEntry,
} from "./tool-results.ts";
import {
  processVerb,
  processEvents,
  processSummary,
  processTally,
  processTurnUser,
  tallyHasEvents,
  userTurnHasProcess,
  type EventSources,
} from "./turn-events.ts";
import { splitAtLastUser } from "./transcript-split.ts";
import { zh } from "../../messages-zh.ts";

const user = (id: string, timestamp: number): TranscriptItem =>
  ({ id, role: "user", content: [{ type: "text", text: "hi" }], timestamp }) as TranscriptItem;
const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
  ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
  ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
const call = (id: string, toolName = "read", input: unknown = { path: `${id}.ts` }) => ({ type: "toolCall", toolCallId: id, toolName, input });
const text = (value: string) => ({ type: "text", text: value });
const mark = (id: string, timestamp: number, kind = "done", from = "child") =>
  ({ role: "channel-mark", id, peerId: "kid", messageId: `m-${id}`, from, kind, timestamp }) as unknown as TranscriptRecord;

function view(records: readonly TranscriptRecord[], active = false): TurnViewEntry[] {
  return groupTurnsByTurn(groupToolUnits(flattenRenderUnits(records)), active, indexToolResults(records));
}
const kinds = (v: readonly TurnViewEntry[]) => v.map((e) => e.kind);
const procOf = (v: readonly TurnViewEntry[]) => v.filter((e): e is TurnProcessUnit => e.kind === "turnProcess");

const sources = (records: readonly TranscriptRecord[], over: Partial<EventSources> = {}): EventSources => ({
  results: indexToolResults(records),
  planChanged: () => true,
  goalChanged: () => false,
  delegatedChild: () => "kid",
  ...over,
});

describe("一轮一行：子会话的来往收进过程块", () => {
  test("截图那一段：交回 → 读图 → 改计划 → 回话 → 答：只剩一行过程 + 正文", () => {
    const records: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 2, [text("好，我派出去了。")]),
      mark("k1", 10),
      assistant("a2", 11, [call("r1"), call("r2"), call("p1", "update_plan", { items: [] })]),
      tool({ toolCallId: "r1", timestamp: 12 }),
      tool({ toolCallId: "r2", timestamp: 12 }),
      tool({ toolCallId: "p1", toolName: "update_plan", timestamp: 12 }),
      assistant("a3", 13, [call("s1", "reply_subsession", { childId: "kid", text: "先量完旧版" })]),
      tool({ toolCallId: "s1", toolName: "reply_subsession", timestamp: 14 }),
      assistant("a4", 15, [text("图回来了，我逐张看过。")]),
    ];
    const v = view(records);
    // 用户 → 上一轮的回答 → 一行过程（交回、读、改计划、回话都在里面）→ 这一轮的回答
    assert.deepEqual(kinds(v), ["user", "text", "turnProcess", "text"]);
    const proc = procOf(v)[0];
    assert.ok(proc !== undefined);
    assert.deepEqual(
      proc.steps.map((s) => s.kind),
      ["channelMark", "toolGroup", "toolCall", "toolCall"],
    );
  });

  test("主会话还在干活时插进来的交回：不切轮，同一个过程块", () => {
    const records: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 2, [call("r1")]),
      tool({ toolCallId: "r1", timestamp: 3 }),
      mark("k1", 4),
      mark("k2", 5, "question"),
      assistant("a2", 6, [call("r2", "bash", { command: "ls" })]),
      tool({ toolCallId: "r2", toolName: "bash", timestamp: 7 }),
      assistant("a3", 8, [text("做完了。")]),
    ];
    const v = view(records);
    assert.deepEqual(kinds(v), ["user", "turnProcess", "text"]);
    assert.equal(procOf(v)[0]?.steps.filter((s) => s.kind === "channelMark").length, 2);
  });

  test("答完之后先落了轮尾文件账、再来交回：仍是新的一轮，前一轮的回答不被收进过程（实例里复现过）", () => {
    const fileTurn = { role: "file-turn", id: "ft1", timestamp: 5, changes: [], webArtifacts: ["/h/p.html"] } as unknown as TranscriptRecord;
    const records: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 2, [call("r1", "bash", { command: "x" })]),
      tool({ toolCallId: "r1", toolName: "bash", timestamp: 3 }),
      assistant("a2", 4, [text("父会话那张写好了")]),
      fileTurn,
      mark("k1", 6),
      assistant("a3", 7, [text("交回来了")]),
    ];
    assert.deepEqual(kinds(view(records)), ["user", "turnProcess", "text", "fileTurn", "turnProcess", "text"]);
  });

  test("只交回、主会话一个工具没跑就答：也有一行过程（交回 1 件），不再画灰块", () => {
    const records: TranscriptRecord[] = [user("u1", 1), assistant("a1", 2, [text("派了。")]), mark("k1", 3), assistant("a2", 4, [text("收到。")])];
    assert.deepEqual(kinds(view(records)), ["user", "text", "turnProcess", "text"]);
  });

  test("派活收进过程块，不再是一张独立的卡", () => {
    const records: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 2, [call("d1", "delegate", { title: "复现", task: "跑一下" }), call("d2", "delegate", { title: "基线", task: "跑" })]),
      tool({ toolCallId: "d1", toolName: "delegate", timestamp: 3 }),
      tool({ toolCallId: "d2", toolName: "delegate", timestamp: 3 }),
      assistant("a2", 4, [text("拆成两件。")]),
    ];
    assert.deepEqual(kinds(view(records)), ["user", "turnProcess", "text"]);
  });

  test("子会话视图：父会话派来的任务照旧是一轮的开头（它是子会话的用户消息），不收进过程", () => {
    const records: TranscriptRecord[] = [mark("k1", 1, "task", "parent"), assistant("a1", 2, [call("r1")]), tool({ toolCallId: "r1", timestamp: 3 }), assistant("a2", 4, [text("好")])];
    assert.deepEqual(kinds(view(records)), ["channelMark", "turnProcess", "text"]);
  });

  test("旧会话（没有任何通道标记）分组不变", () => {
    const records: TranscriptRecord[] = [user("u1", 1), assistant("a1", 2, [call("r1")]), tool({ toolCallId: "r1", timestamp: 3 }), assistant("a2", 4, [text("好")]), user("u2", 5), assistant("a3", 6, [text("嗯")])];
    assert.deepEqual(kinds(view(records)), ["user", "turnProcess", "text", "user", "text"]);
  });
});

describe("isProcessEntry：过程还是结果", () => {
  const entries = groupToolUnits(
    flattenRenderUnits([
      user("u1", 1),
      assistant("a1", 2, [
        text("答"),
        call("x1", "some_new_tool"),
        call("x2", "show_image", {}),
        call("x3", "request_user_action", {}),
        call("x4", "report_to_parent", {}),
        call("x5", "reply_subsession", {}),
      ]),
      mark("k1", 3),
      mark("k2", 4, "task", "parent"),
    ]),
  );
  const by = (pick: (e: RenderEntry) => boolean) => entries.filter(pick).map(isProcessEntry);
  test("用户消息、正文、给用户看的图、要用户点的交接、子会话交给父会话的报告是结果", () => {
    assert.deepEqual(by((e) => e.kind === "user" || e.kind === "text"), [false, false]);
    assert.deepEqual(
      by((e) => e.kind === "toolCall" && ["show_image", "request_user_action", "report_to_parent"].includes(e.toolName)),
      [false, false, false],
    );
  });
  test("认不出的新工具、给子会话回话、子会话交回来的消息默认是过程；父会话派来的任务不是", () => {
    assert.deepEqual(by((e) => e.kind === "toolCall" && (e.toolName === "some_new_tool" || e.toolName === "reply_subsession")), [true, true]);
    assert.deepEqual(by((e) => e.kind === "channelMark"), [true, false]);
  });
});

describe("历史段切分：不在子会话交回来的消息上切", () => {
  test("实时形态（user 记录里的通道信封）与落盘形态都不是切点", () => {
    const envelope = {
      id: "e1",
      role: "user",
      timestamp: 5,
      content: [{ type: "text", text: '<channel from="child" kind="done" peer="kid" message="m9">\n交回\n</channel>' }],
    } as unknown as TranscriptRecord;
    const records: TranscriptRecord[] = [user("u1", 1), assistant("a1", 2, [text("a")]), envelope, mark("k1", 6)];
    assert.equal(isChildChannelRecord(envelope), true);
    const split = splitAtLastUser(records, (r) => r.role === "user" && !isChildChannelRecord(r));
    assert.equal(split.boundary, 1);
  });
});

describe("过程行的摘要：按种类数，只列发生了的", () => {
  const records: TranscriptRecord[] = [
    user("u1", 1),
    assistant("a1", 2, [text("先派")]),
    mark("k1", 10),
    mark("k2", 10, "question"),
    assistant("a2", 11, [
      call("r1"),
      call("r2"),
      call("b1", "bash", { command: "false" }),
      call("p1", "update_plan", {}),
      call("p2", "update_plan", {}),
      call("s1", "reply_subsession", { childId: "kid", text: "好" }),
      call("d1", "delegate", { title: "再派一个" }),
    ]),
    tool({ toolCallId: "r1", timestamp: 12 }),
    tool({ toolCallId: "r2", timestamp: 12 }),
    tool({ toolCallId: "b1", toolName: "bash", status: "error", isError: true, timestamp: 12 }),
    assistant("a3", 13, [text("好了")]),
  ];
  const proc = procOf(view(records))[0];
  assert.ok(proc !== undefined);

  test("事件按时间排：交回、在问、读（两个并一行）、命令、改计划两次、回话、派活", () => {
    const events = processEvents(proc.steps, sources(records));
    assert.deepEqual(
      events.map((e) => e.kind),
      ["childIn", "childIn", "tools", "tools", "plan", "plan", "reply", "delegate"],
    );
    const reads = events[2];
    assert.ok(reads?.kind === "tools");
    assert.equal(reads.calls.length, 2);
  });

  test("摘要一句话：交回 · 被问 · 改了 2 次计划 · 回了 · 派了 · 1 条命令没成（命令失败不上色由视图管）", () => {
    const tally = processTally(processEvents(proc.steps, sources(records)));
    assert.deepEqual(processSummary(zh, tally), ["交回 1 件", "被问了 1 句", "改了 2 次计划", "回了 1 句", "派了 1 件", "1 条命令没成"]);
    assert.equal(tallyHasEvents(tally), true);
  });

  test("只打勾不改计划时不说「改了计划」；失败的不全是命令时说「步」", () => {
    const tally = processTally(processEvents(proc.steps, sources(records, { planChanged: () => false })));
    assert.equal(tally.plan, 0);
    const mixed = processTally([
      { kind: "tools", key: "a", toolKey: "read", calls: [], steps: [], failed: 1, time: 0 },
      { kind: "tools", key: "b", toolKey: "bash", calls: [], steps: [], failed: 1, time: 0 },
    ]);
    assert.deepEqual(processSummary(zh, mixed), ["2 步没成"]);
    assert.equal(tallyHasEvents(mixed), false);
  });

  test("记忆：读了 7 条 · 记住 1 条排在最前", () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, text: `第 ${i} 条` }));
    const tally = processTally([{ kind: "memory", key: "m", used: lines(7), remembered: lines(1), time: 0 }]);
    assert.deepEqual(processSummary(zh, tally), ["读了 7 条记忆", "记住 1 条"]);
  });

  test("思考不单独成行，挂到紧接着的那行工具上", () => {
    const rs: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 2, [{ type: "thinking", thinking: "想想" }, call("r1")]),
      tool({ toolCallId: "r1", timestamp: 3 }),
      assistant("a2", 4, [text("好")]),
    ];
    const p = procOf(view(rs))[0];
    assert.ok(p !== undefined);
    const events = processEvents(p.steps, sources(rs));
    assert.deepEqual(events.map((e) => e.kind), ["tools"]);
    assert.deepEqual(events[0]?.kind === "tools" ? events[0].steps.map((s) => s.kind) : [], ["thinking", "toolCall"]);
  });
});

describe("记忆挂在哪一行：这一轮的第一个过程行；没有过程行时挂在用户消息下", () => {
  const records: TranscriptRecord[] = [
    user("u1", 1),
    assistant("a1", 2, [call("r1")]),
    tool({ toolCallId: "r1", timestamp: 3 }),
    assistant("a2", 4, [text("先说一句")]),
    assistant("a3", 5, [call("r2")]),
    tool({ toolCallId: "r2", timestamp: 6 }),
    assistant("a4", 7, [text("答")]),
    user("u2", 8),
    assistant("a5", 9, [text("只答不干活")]),
  ];
  const v = view(records);
  test("第一个过程行拿到这一轮的用户消息；同一轮后面的过程行不拿", () => {
    const procs = v.flatMap((e, i) => (e.kind === "turnProcess" ? [i] : []));
    assert.equal(processTurnUser(v, procs[0] ?? -1, null), "u1");
    if (procs.length > 1) assert.equal(processTurnUser(v, procs[1] ?? -1, null), null);
  });
  test("尾段开头的过程行（用户消息在历史段）：拿 leadUserId", () => {
    const tail = view([assistant("a1", 2, [call("r1")]), tool({ toolCallId: "r1", timestamp: 3 })]);
    assert.equal(processTurnUser(tail, 0, "u9"), "u9");
  });
  test("用户消息这一轮有没有过程行；历史段最后一条看尾段", () => {
    const u1 = v.findIndex((e) => e.kind === "user" && e.item.id === "u1");
    const u2 = v.findIndex((e) => e.kind === "user" && e.item.id === "u2");
    assert.equal(userTurnHasProcess(v, u1, false), true);
    assert.equal(userTurnHasProcess(v, u2, false), false);
    assert.equal(userTurnHasProcess(v, u2, true), true);
  });
});

describe("用户中途插的话：和用户消息同一个框（同一种 user 单元），不另造样子", () => {
  test("子会话开的轮里用户插话：落成普通 user 单元，前后各一行过程", () => {
    const records: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 2, [text("派了")]),
      mark("k1", 3),
      assistant("a2", 4, [call("r1")]),
      tool({ toolCallId: "r1", timestamp: 5 }),
      user("u-steer", 6),
      assistant("a3", 7, [call("r2")]),
      tool({ toolCallId: "r2", timestamp: 8 }),
      assistant("a4", 9, [text("好")]),
    ];
    assert.deepEqual(kinds(view(records)), ["user", "text", "turnProcess", "user", "turnProcess", "text"]);
  });
});

describe("跑命令那一行默认说为什么跑，命令原文点开才看", () => {
  test("紧挨着的「说」并进命令那一行当说明，不单出；读文件那一行不并", () => {
    const records: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a0", 2, [call("r0")]),
      tool({ toolCallId: "r0", timestamp: 2 }),
      assistant("a1", 2, [text("先数一下这屏的颜色记号"), call("b1", "bash", { command: "cd /very/long/path && node probe.js" })]),
      tool({ toolCallId: "b1", toolName: "bash", timestamp: 3 }),
      assistant("a2", 4, [text("再读一下图"), call("r1")]),
      tool({ toolCallId: "r1", timestamp: 5 }),
      assistant("a3", 6, [text("好")]),
    ];
    const p = procOf(view(records))[0];
    assert.ok(p !== undefined);
    const events = processEvents(p.steps, sources(records));
    assert.deepEqual(events.map((e) => e.kind), ["tools", "tools", "say", "tools"]);
    assert.equal(events[1]?.kind === "tools" ? events[1].caption : null, "先数一下这屏的颜色记号");
    assert.equal(events[3]?.kind === "tools" ? events[3].caption : "none", undefined);
  });
});

describe("一连串同一种来往收成一行（满载：一轮派 41 件）", () => {
  test("连派 4 件收成一个 group，摘要照旧数 4 件；只派 2 件不收", () => {
    const delegates = (n: number) => Array.from({ length: n }, (_, i) => call(`d${i}`, "delegate", { title: `活${i}`, task: "x" }));
    const rs = (n: number): TranscriptRecord[] => [
      user("u1", 1),
      assistant("a1", 2, [call("r0"), ...delegates(n)]),
      tool({ toolCallId: "r0", timestamp: 3 }),
      assistant("a2", 4, [text("派了")]),
    ];
    const four = procOf(view(rs(4)))[0];
    assert.ok(four !== undefined);
    const events = processEvents(four.steps, sources(rs(4)));
    assert.deepEqual(events.map((e) => e.kind), ["tools", "group"]);
    assert.equal(events[1]?.kind === "group" ? events[1].members.length : 0, 4);
    assert.deepEqual(processSummary(zh, processTally(events)), ["派了 4 件"]);
    const two = procOf(view(rs(2)))[0];
    assert.ok(two !== undefined);
    assert.deepEqual(processEvents(two.steps, sources(rs(2))).map((e) => e.kind), ["tools", "delegate", "delegate"]);
  });
});

describe("外面插进来的一行（不在转录里的事，比如重开后「断过」）", () => {
  test("按时间并进去，不计入摘要", () => {
    const rs: TranscriptRecord[] = [
      user("u1", 1),
      assistant("a1", 10, [call("r1")]),
      tool({ toolCallId: "r1", timestamp: 11 }),
      assistant("a2", 30, [call("r2", "bash", { command: "ls" })]),
      tool({ toolCallId: "r2", toolName: "bash", timestamp: 31 }),
      assistant("a3", 40, [text("好")]),
    ];
    const p = procOf(view(rs))[0];
    assert.ok(p !== undefined);
    const events = processEvents(p.steps, sources(rs, { extra: [{ kind: "note", key: "n1", verb: "断过", text: "从第 2 步接着做", time: 20 }] }));
    assert.deepEqual(events.map((e) => e.kind), ["tools", "note", "tools"]);
    assert.deepEqual(processSummary(zh, processTally(events)), []);
  });
});

describe("processVerb：过程明细左列不出现英文工具名", () => {
  const words = zh.chat.procVerb;
  test("常用工具都有动词", () => {
    assert.deepEqual(
      ["bash", "read", "write", "edit", "grep", "read_task", "web_fetch", "browser_navigate"].map((name) => processVerb(name, name, words).verb),
      ["跑命令", "读文件", "写文件", "改文件", "搜索", "读任务", "打开网页", "打开网页"],
    );
    assert.equal(processVerb("read", "skill", words).verb, "读技能");
    // 主智能体读小卡：不露 work_cards 这个工具名
    assert.deepEqual(processVerb("work_cards", "work_cards", words), { verb: "看了手上的活", raw: null });
  });
  test("外接工具写所属服务名 +「工具」，原名放悬停；对不上的归「用工具」", () => {
    assert.deepEqual(processVerb("mcp__qgis__render_map", "mcp", words), { verb: "qgis 工具", raw: "mcp__qgis__render_map" });
    assert.deepEqual(processVerb("some_new_tool", "some_new_tool", words), { verb: "用工具", raw: "some_new_tool" });
  });
});
