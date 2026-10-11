import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createTurnFailureTracker, type TurnFailureEvent } from "./turn-failure.ts";

const PROMA_400 = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Model is not available"}}';
const errorReply = (errorMessage?: string) => ({
  role: "assistant",
  stopReason: "error",
  ...(errorMessage === undefined ? {} : { errorMessage }),
});
const user = { role: "user" };

/** 按序喂事件，收集非 null 的返回 */
function run(events: readonly TurnFailureEvent[]): string[] {
  const observe = createTurnFailureTracker();
  return events.map(observe).filter((value): value is string => value !== null);
}

describe("createTurnFailureTracker —— 不重试的模型错误要报出来", () => {
  test("400 不重试：settled 时交出 pi 的错误串（真实事故：Proma 的 deepseek-flash 走 Anthropic 协议）", () => {
    assert.deepEqual(
      run([
        { type: "agent_start" },
        { type: "agent_end", willRetry: false, messages: [user, errorReply(PROMA_400)] },
        { type: "agent_settled" },
      ]),
      [PROMA_400],
    );
  });

  test("只在 settled 报，且只报一次", () => {
    const observe = createTurnFailureTracker();
    assert.equal(observe({ type: "agent_end", willRetry: false, messages: [errorReply("boom")] }), null);
    assert.equal(observe({ type: "agent_settled" }), "boom");
    assert.equal(observe({ type: "agent_settled" }), null);
  });

  test("正常说完不报", () => {
    assert.deepEqual(
      run([
        { type: "agent_end", willRetry: false, messages: [user, { role: "assistant", stopReason: "stop" }] },
        { type: "agent_settled" },
      ]),
      [],
    );
  });

  test("用户打断（aborted）不报", () => {
    assert.deepEqual(
      run([
        { type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "aborted" }] },
        { type: "agent_settled" },
      ]),
      [],
    );
  });

  test("会重试的错误不报；重试成功后也不报", () => {
    assert.deepEqual(
      run([
        { type: "agent_end", willRetry: true, messages: [errorReply("503 overloaded")] },
        { type: "agent_start" },
        { type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] },
        { type: "auto_retry_end" },
        { type: "agent_settled" },
      ]),
      [],
    );
  });

  test("重试耗尽由 auto_retry_end 那条路报，这里不报第二遍", () => {
    assert.deepEqual(
      run([
        { type: "agent_end", willRetry: false, messages: [errorReply("503 overloaded")] },
        { type: "auto_retry_end" },
        { type: "agent_settled" },
      ]),
      [],
    );
  });

  test("上下文溢出交给压缩续跑：压缩后成功就不报", () => {
    assert.deepEqual(
      run([
        { type: "agent_end", willRetry: false, messages: [errorReply("prompt is too long")] },
        { type: "compaction_start" },
        { type: "agent_start" },
        { type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] },
        { type: "agent_settled" },
      ]),
      [],
    );
  });

  test("错误串为空时给兜底文案，不交出空串", () => {
    assert.deepEqual(
      run([
        { type: "agent_end", willRetry: false, messages: [errorReply("  ")] },
        { type: "agent_settled" },
      ]),
      ["The model returned an error"],
    );
  });

  test("看的是最后一条 assistant：前面工具轮成功、末条出错也要报", () => {
    assert.deepEqual(
      run([
        {
          type: "agent_end",
          willRetry: false,
          messages: [user, { role: "assistant", stopReason: "toolUse" }, { role: "toolResult" }, errorReply("401")],
        },
        { type: "agent_settled" },
      ]),
      ["401"],
    );
  });
});

describe("createTurnFailureTracker —— 被我们自己停下的轮不报", () => {
  // 真实时序（2026-09-29 CDP 复现）：bash 执行中被抢跑 → 工具出错 → pi 再调一次模型，
  // 拿着已 abort 的 signal 立刻得到 stopReason=error 的空回答
  const abortedInTool: TurnFailureEvent[] = [
    { type: "agent_start" },
    { type: "agent_end", willRetry: false, messages: [user, errorReply("This operation was aborted")] },
    { type: "agent_settled" },
  ];

  test("停止 / 抢跑过的轮：abort 带出的错误回答不报", () => {
    const observe = createTurnFailureTracker(() => true);
    assert.deepEqual(abortedInTool.map(observe).filter((value) => value !== null), []);
  });

  test("没停过的轮照报：判定读的是 settled 那一刻的 abort 状态", () => {
    let aborted = false;
    const observe = createTurnFailureTracker(() => aborted);
    assert.equal(observe(abortedInTool[1] as TurnFailureEvent), null);
    assert.equal(observe({ type: "agent_settled" }), "This operation was aborted");
    aborted = true;
    observe(abortedInTool[1] as TurnFailureEvent);
    assert.equal(observe({ type: "agent_settled" }), null);
  });
});
