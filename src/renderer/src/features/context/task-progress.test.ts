import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";
import { latestPlan, turnDigests } from "./task-progress.ts";

const user = (id: string, timestamp: number, text = "hi"): TranscriptItem =>
  ({ id, role: "user", content: [{ type: "text", text }], timestamp }) as TranscriptItem;
const assistant = (id: string, timestamp: number, blocks: unknown[]): TranscriptItem =>
  ({ id, role: "assistant", content: blocks, timestamp }) as TranscriptItem;
const tool = (o: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, "toolCallId">): TranscriptItem =>
  ({ id: `item-${o.toolCallId}`, role: "tool", toolName: "read", input: {}, content: [], timestamp: 0, status: "complete", isError: false, ...o }) as TranscriptItem;
const plan = (id: string, at: number, items: unknown, status: ToolTranscriptItem["status"] = "complete") =>
  tool({ toolCallId: id, toolName: "update_plan", input: { items } as never, timestamp: at, status });

describe("latestPlan", () => {
  test("取最后一次成功的；失败与还在跑的不算", () => {
    const records = [
      plan("p1", 10, [{ text: "读", status: "done" }, { text: "改", status: "in_progress" }]),
      plan("p2", 20, [{ text: "坏", status: "doing" }], "error"),
      plan("p3", 30, [{ text: "x", status: "pending" }], "running"),
    ];
    assert.deepEqual(latestPlan(records), {
      items: [{ text: "读", status: "done" }, { text: "改", status: "in_progress" }],
      at: 10,
      done: 1,
    });
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
});
