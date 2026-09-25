import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findGreetingOnly, GREETING_BATCH_SIZE, GREETING_MESSAGE_MAX, isObviousGreeting, onlyWrittenMessage } from "./greeting-only.ts";

describe("onlyWrittenMessage", () => {
  test("用户只写过一条 → 那一条；零条或不止一条 → null；模型读到、用户没写的不算", () => {
    assert.equal(onlyWrittenMessage(["  hi  "]), "hi");
    assert.equal(onlyWrittenMessage([null, "test", null]), "test");
    assert.equal(onlyWrittenMessage(["hi", "帮我看下这个报错"]), null);
    assert.equal(onlyWrittenMessage([]), null);
    assert.equal(onlyWrittenMessage([null, "   "]), null);
  });
});

describe("isObviousGreeting", () => {
  test("明摆着的招呼、测试语：大小写、标点、空白、全角都不影响", () => {
    for (const text of ["hi", "Hi!", "  hello  ", "hi there", "Hello, Claude.", "test", "Testing...", "test123", "ping", "你好！", "测试一下", "在吗？", "？", "1", "ｈｉ"]) {
      assert.equal(isObviousGreeting(text), true, text);
    }
  });

  test("带了任何实际内容的、单独的指令词都不算（交给模型）", () => {
    for (const text of ["hi, can you fix the build?", "test the login flow", "ok", "go", "/code-review", "你好，帮我看下这个报错", "测试用例跑一下"]) {
      assert.equal(isObviousGreeting(text), false, text);
    }
  });
});

describe("findGreetingOnly", () => {
  test("明摆着的直接判中不问模型；其余按批问、截短送出、下标映射回 sourceFile；越界与重复的下标忽略", async () => {
    const candidates = new Map<string, string>([["plain-hi", "hi"]]);
    for (let index = 0; index < GREETING_BATCH_SIZE + 3; index += 1) candidates.set(`file-${index}`, index === 1 ? "x".repeat(1000) : `message ${index}`);
    const batches: string[][] = [];
    const found = await findGreetingOnly(candidates, async (messages) => {
      batches.push(messages);
      return batches.length === 1 ? [0, 0, 1, 999] : [2];
    });
    assert.deepEqual(batches.map((batch) => batch.length), [GREETING_BATCH_SIZE, 3]);
    assert.ok(!batches.flat().includes("hi"));
    assert.equal(batches[0]![1]!.length, GREETING_MESSAGE_MAX);
    assert.deepEqual(found, { greetingOnly: ["plain-hi", "file-0", "file-1", `file-${GREETING_BATCH_SIZE + 2}`], asked: GREETING_BATCH_SIZE + 3 });
  });

  test("一批失败整次失败；全是明摆着的、或没有候选都不调模型", async () => {
    await assert.rejects(findGreetingOnly(new Map([["a", "can you hear me"]]), async () => { throw new Error("rate limited"); }), /rate limited/);
    let calls = 0;
    const classify = async (): Promise<number[]> => { calls += 1; return []; };
    assert.deepEqual(await findGreetingOnly(new Map([["a", "test"]]), classify), { greetingOnly: ["a"], asked: 0 });
    assert.deepEqual(await findGreetingOnly(new Map(), classify), { greetingOnly: [], asked: 0 });
    assert.equal(calls, 0);
  });
});
