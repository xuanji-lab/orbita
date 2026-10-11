import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
  appendReplay,
  clampTerminalDimension,
  isTerminalId,
  TERMINAL_DIMENSION_MAX,
  type TerminalOutputEvent,
} from "./terminal.ts";

describe("isTerminalId —— renderer 铸的 id 过形状闸", () => {
  it("uuid（带连字符）认", () => {
    strictEqual(isTerminalId("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), true);
  });

  it("路径分隔符、空白、控制字符与超长串不认", () => {
    strictEqual(isTerminalId("../../etc/passwd"), false);
    strictEqual(isTerminalId("has space"), false);
    strictEqual(isTerminalId(""), false);
    strictEqual(isTerminalId("a".repeat(65)), false);
    strictEqual(isTerminalId(123), false);
    strictEqual(isTerminalId(undefined), false);
  });
});

describe("clampTerminalDimension —— 行列夹取", () => {
  it("非有限数回退 fallback，负数与 0 抬到 1，越界压到上界，小数向下取整", () => {
    strictEqual(clampTerminalDimension(undefined, 80), 80);
    strictEqual(clampTerminalDimension(Number.NaN, 24), 24);
    strictEqual(clampTerminalDimension(0, 80), 1);
    strictEqual(clampTerminalDimension(-5, 80), 1);
    strictEqual(clampTerminalDimension(TERMINAL_DIMENSION_MAX + 1, 80), TERMINAL_DIMENSION_MAX);
    strictEqual(clampTerminalDimension(12.7, 80), 12);
    strictEqual(clampTerminalDimension(120, 80), 120);
  });
});

describe("appendReplay —— 快照重放缓冲", () => {
  const batch = (sequence: number, data: string): TerminalOutputEvent => ({
    terminalId: "t1",
    sequence,
    data,
  });

  it("按序追加，sequence 前进", () => {
    let buffer = { output: "", sequence: 0 };
    buffer = appendReplay(buffer, batch(1, "abc"), 1024);
    buffer = appendReplay(buffer, batch(2, "def"), 1024);
    deepStrictEqual(buffer, { output: "abcdef", sequence: 2 });
  });

  it("旧批与重复批（sequence 不前进）整个丢掉——renderer 重挂载靠它去重", () => {
    const buffer = { output: "abc", sequence: 3 };
    deepStrictEqual(appendReplay(buffer, batch(2, "stale"), 1024), buffer);
    deepStrictEqual(appendReplay(buffer, batch(3, "repeat"), 1024), buffer);
  });

  it("超容量从头部截断，只留末尾——重放永远从最近的历史开始", () => {
    let buffer = { output: "", sequence: 0 };
    buffer = appendReplay(buffer, batch(1, "a".repeat(600)), 1024);
    buffer = appendReplay(buffer, batch(2, "b".repeat(600)), 1024);
    strictEqual(buffer.output.length, 1024);
    // 前 176 个 a 被截掉，留下 424 个 a + 全部 600 个 b
    strictEqual(buffer.output, "a".repeat(424) + "b".repeat(600));
    strictEqual(buffer.sequence, 2);
  });
});
