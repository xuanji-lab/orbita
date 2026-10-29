import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { latestPlan, liveTail, settledEnd, stepClockFrom, taskHeadState, turnDigests, type PlanView } from "./task-progress.ts";
import { mergeHistory } from "../chat/task-inventory.ts";

const user = (id: string, timestamp: number, text = "hi"): TranscriptItem =>
  ({ id, role: "user", content: [{ type: "text", text }], timestamp }) as TranscriptItem;
const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
  ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
  ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
const plan = (id: string, at: number, items: unknown, status: ToolTranscriptItem["status"] = "complete") =>
  tool({ toolCallId: id, toolName: "update_plan", input: { items } as never, timestamp: at, status });
const plan_ = (id: string, at: number) => plan(id, at, [{ text: "改", status: "in_progress" }]);

describe("latestPlan", () => {
  test("取最后一张：被拒的（error）不算", () => {
    const records = [
      plan("p1", 10, [{ text: "读", status: "done" }, { text: "改", status: "in_progress" }]),
      plan("p2", 20, [{ text: "坏", status: "doing" }], "error"),
    ];
    assert.deepEqual(latestPlan(records), {
      items: [{ text: "读", status: "done" }, { text: "改", status: "in_progress" }],
      at: 10,
      done: 1,
    });
  });
  test("还在跑的也算：手动档下它和同批等审批的工具一起挂着，入参在开跑那一刻已是定稿", () => {
    // pi 的并行批次：update_plan 先落 running 帧，同批的 read 等你批准，整批过完才执行——
    // 只认 complete 的话，面板在你批准之前一直是上一张计划（2026-10-30 实测）
    const records = [
      plan("p1", 10, [{ text: "读", status: "done" }, { text: "改", status: "done" }]),
      user("u2", 20, "再来一遍"),
      plan("p2", 30, [{ text: "读", status: "in_progress" }, { text: "改", status: "pending" }], "running"),
      tool({ toolCallId: "r1", timestamp: 30, status: "running" }),
    ];
    assert.deepEqual(latestPlan(records), {
      items: [{ text: "读", status: "in_progress" }, { text: "改", status: "pending" }],
      at: 30,
      done: 0,
    });
  });
  test("还在跑但入参过不了工具的校验（两步同时在做）：不认，等工具拒了模型重调", () => {
    const records = [
      plan("p1", 10, [{ text: "读", status: "in_progress" }]),
      plan("p2", 20, [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }], "running"),
    ];
    assert.equal(latestPlan(records)?.at, 10);
  });
  test("没写过计划 = null", () => {
    assert.equal(latestPlan([user("u", 1)]), null);
  });
});

describe("turnDigests", () => {
  test("按轮列：用户那句话、章节、步数、写过的文件、失败", () => {
    const records = [
      user("u1", 1000, "帮我检查侧栏\n细节"),
      assistant("a1", 2000, [{ type: "text", text: "先读代码。" }, { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } }]),
      tool({ toolCallId: "r1", timestamp: 2500 }),
      assistant("a2", 3000, [{ type: "text", text: "再写笔记。" }, { type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "n.md" } }]),
      tool({ toolCallId: "w1", toolName: "write", timestamp: 3500 }),
      assistant("a3", 4000, [{ type: "text", text: "好了。" }]),
      user("u2", 5000, "再跑一遍"),
      assistant("a4", 6000, [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "x" } }]),
      tool({ toolCallId: "b1", toolName: "bash", timestamp: 6500, status: "error" }),
    ];
    const turns = turnDigests(records, true);
    assert.equal(turns.length, 2);
    const [one, two] = turns;
    assert.equal(one?.ask, "帮我检查侧栏");
    assert.equal(one?.steps, 2);
    assert.equal(one?.files, 1);
    // 第一个工具之前的那句话在过程块外（它是开场白），块里按「再写笔记。」切成两章
    assert.deepEqual(one?.chapters.map((c) => c.title), [null, "再写笔记。"]);
    assert.equal(one?.live, false);
    assert.equal(two?.failed, 1);
    assert.equal(two?.live, true);
  });
  test("在跑的那一轮不给用时：已落定各步的跨度在两步之间是冻住的，头一行的钟已经在走", () => {
    const records = [
      user("u1", 1000),
      assistant("a1", 2000, [{ type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a.ts" } }]),
      tool({ toolCallId: "r1", timestamp: 9000 }),
      assistant("a2", 9500, [{ type: "toolCall", toolCallId: "r2", toolName: "read", input: { path: "b.ts" } }]),
    ];
    assert.equal(turnDigests(records, true)[0]?.durationMs, null);
    assert.notEqual(turnDigests(records, false)[0]?.durationMs, null);
  });
  test("用户那句话以代码块开头：跳过只有围栏的行（含转义的 \\`\\`\\`），取第一行正文", () => {
    const fenced = "```\n\"两个旧文件怎么处理？\"=\"删除\"\n```\n继续";
    const escaped = "\\`\\`\\`\n\n\"dynamic 评论减少\"=\"先查\"\n\\`\\`\\`\n继续";
    const tagged = "```ts\nconst a = 1;\n```";
    const turns = turnDigests([user("u1", 1, fenced), user("u2", 2, escaped), user("u3", 3, tagged)], false);
    assert.deepEqual(
      turns.map((turn) => turn.ask),
      ['"两个旧文件怎么处理？"="删除"', '"dynamic 评论减少"="先查"', "const a = 1;"],
    );
  });
});

describe("taskHeadState（头一行：在跑 / 等你 / 做完了 / 出错了 / 停下了）", () => {
  const unfinished: PlanView = { items: [{ text: "读", status: "done" }, { text: "改", status: "in_progress" }], at: 10, done: 1 };
  const finished: PlanView = { items: [{ text: "读", status: "done" }], at: 10, done: 1 };
  test("在跑 / 等你取会话运行态（侧栏同一个推导），不看计划", () => {
    assert.equal(taskHeadState({ run: "running", turnError: false, turns: 1, plan: unfinished }), "running");
    assert.equal(taskHeadState({ run: "waiting", turnError: false, turns: 1, plan: finished }), "waiting");
  });
  test("一轮都没有：不说状态", () => {
    assert.equal(taskHeadState({ run: null, turnError: false, turns: 0, plan: null }), null);
  });
  test("这一轮以错误收场 = 出错了（与侧栏红饼同一个来源 turnError），压过计划", () => {
    assert.equal(taskHeadState({ run: null, turnError: true, turns: 2, plan: unfinished }), "failed");
  });
  test("计划还有没做完的步 = 停下了：用户点了停止、模型停下来问你，都不是「做完了」", () => {
    assert.equal(taskHeadState({ run: null, turnError: false, turns: 2, plan: unfinished }), "stopped");
  });
  test("计划全勾或没写计划 = 做完了；工具失败不等于这一轮出错（模型照样收尾了）", () => {
    assert.equal(taskHeadState({ run: null, turnError: false, turns: 1, plan: finished }), "done");
    assert.equal(taskHeadState({ run: null, turnError: false, turns: 1, plan: null }), "done");
  });
  test("未读标记（侧栏的跑完 / 出错）不当在跑：落定后的状态由这里自己判", () => {
    assert.equal(taskHeadState({ run: "done", turnError: false, turns: 1, plan: unfinished }), "stopped");
    assert.equal(taskHeadState({ run: "failed", turnError: false, turns: 1, plan: null }), "done");
  });
});

describe("stepClockFrom（「在做」那步从几点开始计）", () => {
  const plan: PlanView = { items: [{ text: "改", status: "in_progress" }], at: 1_000, done: 0 };
  test("计划是这一轮写的：从写下的时刻起", () => {
    const turns = turnDigests([user("u1", 500), plan_("p1", 1_000)], true);
    assert.equal(stepClockFrom(plan, turns), 1_000);
  });
  test("计划是前几轮写的、这一轮没更新（续聊）：从这一轮开始算，不把中间闲着的时间算进去", () => {
    const turns = turnDigests([user("u1", 500), plan_("p1", 1_000), user("u2", 90_000_000)], true);
    assert.equal(stepClockFrom(plan, turns), 90_000_000);
  });
});

describe("整个任务的轮：落定段 + 每次重算的尾巴 = 全量一次算", () => {
  // 三轮：u1（read）、u2（write，失败）、u3（还在跑）
  const all = [
    user("u1", 1000, "第一轮"),
    assistant("a1", 1100, [{ type: "text", text: "先读。" }, { type: "toolCall", toolCallId: "r1", toolName: "read", input: { path: "a" } }]),
    tool({ toolCallId: "r1", timestamp: 1200 }),
    assistant("a1b", 1300, [{ type: "text", text: "读完了。" }]),
    user("u2", 2000, "第二轮"),
    assistant("a2", 2100, [{ type: "toolCall", toolCallId: "w1", toolName: "write", input: { path: "b" } }]),
    tool({ toolCallId: "w1", toolName: "write", timestamp: 2200, status: "error" }),
    assistant("a2b", 2300, [{ type: "text", text: "写不进去。" }]),
    user("u3", 3000, "第三轮"),
    assistant("a3", 3100, [{ type: "toolCall", toolCallId: "b1", toolName: "bash", input: { command: "ls" } }]),
  ];
  const shape = (turns: ReturnType<typeof turnDigests>) =>
    turns.map((turn) => ({ key: turn.key, ask: turn.ask, steps: turn.steps, failed: turn.failed, live: turn.live, chapters: turn.chapters.length }));
  for (const [name, olderEnd, windowStart] of [
    ["更早那段切在第二轮中间、尾窗不重叠", 6, 6],
    ["尾窗往上翻过、和更早那段重叠到落定段里", 6, 2],
    ["更早那段只有第一轮的开头（落定段为空，全部进尾巴）", 2, 2],
  ] as const) {
    test(name, () => {
      const older = all.slice(0, olderEnd);
      const current = all.slice(windowStart);
      const end = settledEnd(older);
      const olderIds = new Set(older.map((record) => record.id));
      const split = [...turnDigests(older.slice(0, end), false), ...turnDigests(liveTail(older, end, current, olderIds), true)];
      assert.deepEqual(shape(split), shape(turnDigests(mergeHistory(older, current), true)));
      assert.equal(split.length, 3);
    });
  }
  test("落定段止于最后一条用户消息之前；没有用户消息就没有落定段", () => {
    assert.equal(settledEnd(all.slice(0, 6)), 4);
    assert.equal(settledEnd(all.slice(1, 4)), 0);
    assert.equal(settledEnd([]), 0);
  });
});
