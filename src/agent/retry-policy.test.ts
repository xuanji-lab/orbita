/**
 * 重试策略的行为守卫（./retry-policy.ts 是参数与阈值的真源）：
 *
 * 1. pi 的指数退避必须原样在位——当初拍平它的 patch 已撤销，若 pi 升级后行为
 *    变了（或有人悄悄重新拍平），退避序列断言当场红。
 * 2. 次数上限：8 次耗尽后原样返回错误，不发第 9 次请求。
 * 3. 界面可见性阈值：前 5 次不显示、第 6 次起显示。
 * 4. 确定性超限不重试：413 request_too_large 不进重试循环（主链路走溢出→压缩，
 *    见 pi 的 isContextOverflow 先于可重试判定）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  isContextOverflow,
  isRetryableAssistantError,
  retryAssistantCall,
} from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_VISIBILITY_THRESHOLD,
  retryVisibleToUi,
} from "./retry-policy.ts";

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

test("指数退避序列 1s、2s、4s…128s，8 次耗尽后不再发请求", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const delays: number[] = [];
  let calls = 0;
  // 每次调用都返回可重试的错误（"502" 命中 pi 的可重试模式表——正是 sub2api 网关的瞬时抖动）
  const produce = async (): Promise<AssistantMessage> => {
    calls += 1;
    return message("error", "502 Bad Gateway");
  };
  const pending = retryAssistantCall(
    produce,
    { enabled: true, maxRetries: RETRY_MAX_ATTEMPTS, baseDelayMs: RETRY_BASE_DELAY_MS },
    undefined,
    {
      onRetryScheduled: (_attempt, _maxAttempts, delayMs) => {
        delays.push(delayMs);
      },
    },
  );
  // 按指数逐次拨表：第 n 次等待 1000 × 2^(n-1) 毫秒。拨少了循环会卡在睡眠里，
  // 所以每次拨完放干微任务再看——总数由 attempts 守住，不会多睡。
  const expected = [1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000];
  for (const wait of expected) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    t.mock.timers.tick(wait);
  }
  for (let j = 0; j < 20; j++) await Promise.resolve();
  const final = await pending;
  // 总窗口 255 秒（≈4 分 15 秒）：扛得住网关级瞬时故障，又不会无限等
  assert.deepEqual(delays, expected);
  assert.equal(final.stopReason, "error");
  assert.equal(final.errorMessage, "502 Bad Gateway");
  // 1 次首发 + 8 次重试
  assert.equal(calls, 9);
});

test("502 判为可重试，413 request_too_large 判为不可重试（走溢出→压缩，不烧重试预算）", () => {
  assert.equal(isRetryableAssistantError(message("error", "502 Bad Gateway")), true);
  const tooLarge = '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}';
  assert.equal(isRetryableAssistantError(message("error", tooLarge)), false);
  // 主链路的分类口径：request_too_large 是溢出（pi 的 _isRetryableError 先查它，
  // 溢出进压缩恢复，与 auto retry 互斥）
  assert.equal(isContextOverflow(message("error", tooLarge)), true);
  // 502 不是溢出
  assert.equal(isContextOverflow(message("error", "502 Bad Gateway")), false);
});

test("413 request_too_large 不进重试循环：首发即返回、只调一次", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const produce = async (): Promise<AssistantMessage> => {
    calls += 1;
    return message("error", '413 {"type":"request_too_large"}');
  };
  const final = await retryAssistantCall(
    produce,
    { enabled: true, maxRetries: RETRY_MAX_ATTEMPTS, baseDelayMs: RETRY_BASE_DELAY_MS },
    undefined,
  );
  assert.equal(final.stopReason, "error");
  assert.equal(calls, 1);
});

test("可见性阈值：前 5 次不进界面，第 6 次起显示", () => {
  for (let attempt = 1; attempt <= RETRY_VISIBILITY_THRESHOLD; attempt++) {
    assert.equal(retryVisibleToUi(attempt), false, `attempt ${attempt} 不应显示`);
  }
  assert.equal(retryVisibleToUi(RETRY_VISIBILITY_THRESHOLD + 1), true);
  assert.equal(retryVisibleToUi(RETRY_MAX_ATTEMPTS), true);
});
