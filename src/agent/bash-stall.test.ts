/**
 * 「疑似停滞」判定的测试。
 *
 * 这条判据的边界全在纯函数里（两次采样 + 静默时长），所以主体是纯函数测试：
 * 采样拿不到必须放弃、CPU 有增长必须不报、命令在确认窗口内结束必须不报。
 * 观察器本身另有三条线（复位、放弃、清理定时器），用毫秒级阈值跑真定时器。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STALL_CONFIRM_MS,
  STALL_CPU_DELTA_MS,
  STALL_QUIET_MS,
  createStallWatcher,
  judgeStall,
  stallNotice,
} from "./bash-stall.ts";

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("judgeStall：两段式判据的边界", () => {
  test("静默够长 + 确认窗口内 CPU 几乎不涨 → 停滞", () => {
    const verdict = judgeStall({ quietMs: 90_000, confirmMs: 60_000, s0CpuMs: 120, s1CpuMs: 160 });
    assert.deepEqual(verdict, { quietSeconds: 90, confirmSeconds: 60, cpuLimitMs: 100, cpuDeltaMs: 40 });
  });

  test("CPU 有明显增长 → 不停滞（它在干活，只是没吐字）", () => {
    assert.equal(judgeStall({ quietMs: 90_000, confirmMs: 60_000, s0CpuMs: 1_000, s1CpuMs: 3_500 }), null);
    // 正好等于阈值也算增长（判据是 < 100ms，不是 <= 100ms）
    assert.equal(judgeStall({ quietMs: 90_000, confirmMs: 60_000, s0CpuMs: 0, s1CpuMs: 100 }), null);
  });

  test("静默不够长 → 不停滞（判定条件的第一段）", () => {
    assert.equal(judgeStall({ quietMs: 29_999, confirmMs: 60_000, s0CpuMs: 0, s1CpuMs: 0 }), null);
    assert.equal(judgeStall({ quietMs: STALL_QUIET_MS, confirmMs: 60_000, s0CpuMs: 0, s1CpuMs: 0 })?.quietSeconds, 30);
  });

  test("任一采样为 null → 放弃判定（读不到就说不出来，不猜）", () => {
    assert.equal(judgeStall({ quietMs: 90_000, confirmMs: 60_000, s0CpuMs: null, s1CpuMs: 10 }), null);
    assert.equal(judgeStall({ quietMs: 90_000, confirmMs: 60_000, s0CpuMs: 10, s1CpuMs: null }), null);
  });

  test("命令在确认窗口内结束 → 不停滞（结束时它就不是停滞）", () => {
    assert.equal(
      judgeStall({ quietMs: 400_000, confirmMs: 200_000, s0CpuMs: 5, s1CpuMs: 5, ended: true }),
      null,
    );
  });

  test("差值为负（两次读到的不是同一棵树）→ 不猜", () => {
    assert.equal(judgeStall({ quietMs: 90_000, confirmMs: 60_000, s0CpuMs: 500, s1CpuMs: 100 }), null);
  });

  test("阈值可注入：默认值与常量一致", () => {
    assert.equal(STALL_QUIET_MS, 30_000);
    assert.equal(STALL_CONFIRM_MS, 60_000);
    assert.equal(STALL_CPU_DELTA_MS, 100);
    // 测试 / 未来调参走注入，不改线上默认
    assert.equal(
      judgeStall({ quietMs: 100, confirmMs: 200, s0CpuMs: 0, s1CpuMs: 0, quietThresholdMs: 100 })?.quietSeconds,
      0,
    );
  });
});

describe("stallNotice：文案只说看到的事实，不宣布卡死", () => {
  test("静默时长、采样窗口、CPU 阈值都来自判定结果", () => {
    const text = stallNotice({ quietSeconds: 92, confirmSeconds: 60, cpuLimitMs: 100, cpuDeltaMs: 3 });
    assert.match(text, /\[orbita\] 本命令有 92 秒无输出/);
    assert.match(text, /采样 60 秒，CPU 增长 < 100ms/);
    assert.match(text, /可考虑中止它，或改用 terminal_\*/);
    // 「已卡死」这类结论系统层面证明不了，文案里不许出现
    assert.doesNotMatch(text, /卡死/);
    assert.ok(text.startsWith("\n") && text.endsWith("\n"), "与后代提示同一种行内追加形态");
  });
});

describe("createStallWatcher：复位、放弃、清理", () => {
  const fast = { quietMs: 20, confirmMs: 20, cpuDeltaMs: 100 };

  test("静默 + CPU 不变 → 只发一次提示", async () => {
    const notices: string[] = [];
    let calls = 0;
    const watcher = createStallWatcher(1, (notice) => notices.push(notice), {
      ...fast,
      sampleCpuMs: async () => {
        calls += 1;
        return 42;
      },
    });
    await settle(120);
    watcher.stop();
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /无输出/);
    assert.equal(calls, 2, "判定只采样两次");
  });

  test("S0 之后又来输出 → 放弃观察，不发提示、不再采样", async () => {
    const notices: string[] = [];
    let calls = 0;
    const watcher = createStallWatcher(1, (notice) => notices.push(notice), {
      ...fast,
      sampleCpuMs: async () => {
        calls += 1;
        return 7;
      },
    });
    // 第一次静默到点（取 S0）后立刻喂一块输出：命令在动
    await settle(30);
    watcher.noteData();
    await settle(120);
    watcher.stop();
    assert.deepEqual(notices, []);
    assert.ok(calls <= 1, `应当停在 S0，实际采样 ${calls} 次`);
  });

  test("采样为 null → 不发提示", async () => {
    const notices: string[] = [];
    const watcher = createStallWatcher(1, (notice) => notices.push(notice), {
      ...fast,
      sampleCpuMs: async () => null,
    });
    await settle(120);
    watcher.stop();
    assert.deepEqual(notices, []);
  });

  test("stop() 之后定时器不再触发（命令结束就不许再有提示）", async () => {
    const notices: string[] = [];
    const watcher = createStallWatcher(1, (notice) => notices.push(notice), {
      ...fast,
      sampleCpuMs: async () => 0,
    });
    watcher.stop();
    await settle(100);
    assert.deepEqual(notices, []);
  });
});
