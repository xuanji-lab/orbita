import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { interruptWithQueued, type InterruptOps } from "./interrupt.ts";

/** 记录调用序的假会话：顺序正是本模块要守的东西。 */
function fakeOps(
  queue: { steering: string[]; followUp: string[] },
  streaming = true,
): {
  ops: InterruptOps;
  calls: string[];
} {
  const calls: string[] = [];
  const ops: InterruptOps = {
    clearQueue: () => {
      calls.push("clearQueue");
      return { steering: [...queue.steering], followUp: [...queue.followUp] };
    },
    isStreaming: () => streaming,
    abort: async () => {
      calls.push("abort");
    },
    followUp: async (text) => {
      calls.push(`followUp:${text}`);
    },
    echoUserPrompt: (text) => {
      calls.push(`echo:${text}`);
    },
    prompt: async (text) => {
      calls.push(`prompt:${text}`);
    },
  };
  return { ops, calls };
}

describe("interruptWithQueued —— 打断的调用序", () => {
  test("单条排队：清队 → abort → 开新一轮", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲"] });
    assert.equal(await interruptWithQueued(ops, 0, "甲"), true);
    assert.deepEqual(calls, ["clearQueue", "abort", "echo:甲", "prompt:甲"]);
  });

  test("其余排队项在 prompt 之前回队——prompt 会 await 完整一轮，排它后面就晚了一整轮", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "乙", "丙"] });
    assert.equal(await interruptWithQueued(ops, 0, "甲"), true);
    assert.deepEqual(calls, [
      "clearQueue",
      "abort",
      "followUp:乙",
      "followUp:丙",
      "echo:甲",
      "prompt:甲",
    ]);
    // 回队必须早于 prompt：这一条挂了就是「乙丙消失一整轮且不会被自动投递」
    assert.ok(calls.indexOf("followUp:乙") < calls.indexOf("prompt:甲"));
    assert.ok(calls.indexOf("followUp:丙") < calls.indexOf("prompt:甲"));
  });

  test("clearQueue 必须早于 abort——反过来 post-run 会自动续轮，打断变换人", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "乙"] });
    await interruptWithQueued(ops, 0, "甲");
    assert.ok(calls.indexOf("clearQueue") < calls.indexOf("abort"));
  });

  test("打断队列中间一条：前后的都回队，相对顺序不变", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "乙", "丙"] });
    assert.equal(await interruptWithQueued(ops, 1, "乙"), true);
    assert.deepEqual(calls, [
      "clearQueue",
      "abort",
      "followUp:甲",
      "followUp:丙",
      "echo:乙",
      "prompt:乙",
    ]);
  });

  test("steering 与 followUp 合成一个视图，回队一律走 followUp", async () => {
    const { ops, calls } = fakeOps({ steering: ["插队的"], followUp: ["等着的"] });
    // index 1 指的是拼接视图 [插队的, 等着的] 里的第二条
    assert.equal(await interruptWithQueued(ops, 1, "等着的"), true);
    assert.deepEqual(calls, [
      "clearQueue",
      "abort",
      "followUp:插队的",
      "echo:等着的",
      "prompt:等着的",
    ]);
  });

  test("目标不在队列里：整单放弃，不 abort 不 prompt，队列原样放回", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "乙"] });
    assert.equal(await interruptWithQueued(ops, 0, "已经不在了"), false);
    assert.deepEqual(calls, ["clearQueue", "followUp:甲", "followUp:乙"]);
    assert.ok(!calls.includes("abort"));
    assert.ok(!calls.some((call) => call.startsWith("prompt:")));
  });

  test("下标过期但文本还在：按文本找回来，不落空", async () => {
    // 真实事故（wafo 2026-09-06）：[甲,乙,丙] 先发走乙，丙的下标从 2 变成 1，
    // UI 仍按旧快照传 2。精确对账会静默丢掉命令，表现为「点了没反应」
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "丙"] });
    assert.equal(await interruptWithQueued(ops, 2, "丙"), true);
    assert.deepEqual(calls, ["clearQueue", "abort", "followUp:甲", "echo:丙", "prompt:丙"]);
  });

  test("下标指到了别人身上：以文本为准，不切错人", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "乙"] });
    assert.equal(await interruptWithQueued(ops, 0, "乙"), true);
    assert.deepEqual(calls, ["clearQueue", "abort", "followUp:甲", "echo:乙", "prompt:乙"]);
  });

  test("那条真的已被投递：整单放弃并放回", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲"] });
    assert.equal(await interruptWithQueued(ops, 5, "已经飞了的"), false);
    assert.deepEqual(calls, ["clearQueue", "followUp:甲"]);
  });

  test("空闲时不 abort：没有在跑的一轮，直接发就是", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["停止后滞留的"] }, false);
    assert.equal(await interruptWithQueued(ops, 0, "停止后滞留的"), true);
    assert.deepEqual(calls, ["clearQueue", "echo:停止后滞留的", "prompt:停止后滞留的"]);
    assert.ok(!calls.includes("abort"));
  });

  test("空闲时其余排队项照样先回队，再开新一轮", async () => {
    const { ops, calls } = fakeOps({ steering: [], followUp: ["甲", "乙"] }, false);
    assert.equal(await interruptWithQueued(ops, 0, "甲"), true);
    assert.deepEqual(calls, ["clearQueue", "followUp:乙", "echo:甲", "prompt:甲"]);
  });
});
