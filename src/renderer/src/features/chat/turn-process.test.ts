/**
 * 「一轮一行」过程显示：分组（groupTurnsByTurn）+ 章节 / 计数 / 现场快照的推导。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import {
  flattenRenderUnits,
  groupToolUnits,
  groupTurnsByTurn,
  indexToolResults,
  type TurnProcessUnit,
  type TurnViewEntry,
} from "./tool-results.ts";
import { firstLine, processChapters, processCounts, processLive } from "./turn-process.ts";

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
    assert.deepEqual(counts.byTool.map((b) => b.key).sort(), ["bash", "read", "write"]);
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
