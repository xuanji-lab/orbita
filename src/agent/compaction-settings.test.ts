import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  compactionBoundaryTimestamp,
  compactionKeepRecentTokens,
  compactionReserveTokens,
} from "./compaction-settings.ts";

describe("compactionReserveTokens——剩余百分比 → pi 的 reserveTokens", () => {
  test("20% 的语义：200k 窗口留 40k、128k 窗口留 25.6k", () => {
    assert.equal(compactionReserveTokens(20, 200_000), 40_000);
    assert.equal(compactionReserveTokens(20, 128_000), 25_600);
  });

  test("越界与非数一律按出厂 20%——与 parseSettings 同一语义", () => {
    assert.equal(compactionReserveTokens(0, 100_000), 20_000);
    assert.equal(compactionReserveTokens(200, 100_000), 20_000);
    assert.equal(compactionReserveTokens(Number.NaN, 100_000), 20_000);
    // 端点合法
    assert.equal(compactionReserveTokens(5, 100_000), 5_000);
    assert.equal(compactionReserveTokens(50, 100_000), 50_000);
  });

  test("窗口未知退 pi 出厂 16384——不知道窗口就不乱调", () => {
    assert.equal(compactionReserveTokens(20, 0), 16384);
    assert.equal(compactionReserveTokens(20, Number.NaN), 16384);
  });
});

describe("compactionKeepRecentTokens——保留量内部钳制，不暴露", () => {
  test("大窗口取出厂 2 万", () => {
    assert.equal(compactionKeepRecentTokens(200_000), 20_000);
  });

  test("小窗口钳到窗口的 25%——pi 出厂 2 万对 8k 窗口大于整个上下文（退化）", () => {
    assert.equal(compactionKeepRecentTokens(8_000), 2_000);
    assert.equal(compactionKeepRecentTokens(16_000), 4_000);
  });

  test("窗口未知退 2 万", () => {
    assert.equal(compactionKeepRecentTokens(0), 20_000);
  });
});

describe("compactionBoundaryTimestamp——预检压缩的界碑盖回显时间戳", () => {
  test("预检压缩（有回显、还没出过 assistant）：盖回显的时间戳", () => {
    assert.equal(
      compactionBoundaryTimestamp({ echoedAt: 1000, sawAssistant: false }, 5000),
      1000,
    );
  });

  test("轮内压缩（已出过 assistant）：用当下时间，自然插进消息流", () => {
    assert.equal(compactionBoundaryTimestamp({ echoedAt: 1000, sawAssistant: true }, 5000), 5000);
  });

  test("手动压缩轮没有 echo：用当下时间", () => {
    assert.equal(compactionBoundaryTimestamp({ echoedAt: null, sawAssistant: false }, 5000), 5000);
  });

  // 同毫秒平局「界碑排前」的排序断言在 session-states.test.ts（渲染层，归约器在那边）——
  // 盖回显时间戳之后，界碑落到刚发那句之前靠的就是它。
});
