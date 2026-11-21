import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  compactAheadDue,
  compactionBoundaryTimestamp,
  compactionLeadTokens,
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

describe("compactAheadDue——轮末要不要在后台把压缩先做掉", () => {
  // 64k 窗口、剩余 20%：reserve 12.8k，内核阻塞线 51.2k；提前量 5% = 3.2k → 夹到下限 4096，预先压的线 47.1k
  const base = { enabled: true, delegated: false, contextWindow: 64_000, reserveTokens: 12_800 };

  test("提前量：窗口 5%，夹在 4096–16384", () => {
    assert.equal(compactionLeadTokens(64_000), 4096);
    assert.equal(compactionLeadTokens(200_000), 10_000);
    assert.equal(compactionLeadTokens(1_000_000), 16_384);
    assert.equal(compactionLeadTokens(0), 0);
  });

  test("已越过内核阻塞线：一定压（否则下一次发送必被挡）", () => {
    assert.equal(compactAheadDue({ ...base, contextTokens: 60_000 }), true);
  });

  test("差一点到阻塞线（落在提前量里）：压——下一句一来就会越线", () => {
    assert.equal(compactAheadDue({ ...base, contextTokens: 51_200 - 4096 + 1 }), true);
    assert.equal(compactAheadDue({ ...base, contextTokens: 50_000 }), true);
  });

  test("离阻塞线还远：不压（压缩有损，还多一次摘要调用）", () => {
    assert.equal(compactAheadDue({ ...base, contextTokens: 51_200 - 4096 }), false);
    assert.equal(compactAheadDue({ ...base, contextTokens: 20_000 }), false);
  });

  test("派出去的活（子会话）：越线也不预先压", () => {
    assert.equal(compactAheadDue({ ...base, delegated: true, contextTokens: 60_000 }), false);
  });

  test("自动压缩关着、占用未知、窗口未知：不压", () => {
    assert.equal(compactAheadDue({ ...base, enabled: false, contextTokens: 60_000 }), false);
    assert.equal(compactAheadDue({ ...base, contextTokens: null }), false);
    assert.equal(compactAheadDue({ ...base, contextWindow: 0, contextTokens: 60_000 }), false);
  });
});
