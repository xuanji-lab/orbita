/**
 * 两个 pi patch 的行为守卫（patches/README.md）：重试退避拍平为固定 baseDelayMs。
 * 未 patch 的 pi 是指数退避（baseDelayMs × 2^(n-1)），pi 升级后 patch 没重打的话
 * 这个测试当场红——第 2、3 次等待会翻倍成 10 秒、20 秒。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { retryAssistantCall } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";

/** 最小可用的 AssistantMessage：retryAssistantCall 的循环只读 stopReason / errorMessage。 */
function message(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: 0,
  };
}

test("重试间隔拍平为固定 baseDelayMs——第 2、3 次不翻倍（patch 守卫）", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delays: number[] = [];
  let calls = 0;
  // 每次调用都返回可重试的网络错误（"network error" 命中 pi 的可重试模式表）
  const produce = async (): Promise<AssistantMessage> => {
    calls += 1;
    return message("error", "network error");
  };
  const pending = retryAssistantCall(
    produce,
    { enabled: true, maxRetries: 3, baseDelayMs: 5000 },
    undefined,
    {
      onRetryScheduled: (_attempt, _maxAttempts, delayMs) => {
        delays.push(delayMs);
      },
    },
  );
  // 三轮「放干微任务 → 拨表 5 秒」：让循环走到下一次尝试、依次睡完三次
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    t.mock.timers.tick(5000);
  }
  // 兜底大拨一表：未 patch 时第三次等待是 20 秒、上面只拨到 15 秒——这里补足，
  // 让指数版本也能走完、由下面的断言抓出来，测试是「失败」而不是「挂起」
  for (let j = 0; j < 20; j++) await Promise.resolve();
  t.mock.timers.tick(60000);
  const final = await pending;
  // 未 patch 的指数退避这里是 [5000, 10000, 20000]
  assert.deepEqual(delays, [5000, 5000, 5000]);
  // 三次耗尽后原样返回最后一次的错误，不发第 4 次请求
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "network error");
  assert.equal(calls, 4);
});
