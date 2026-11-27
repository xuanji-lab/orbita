/**
 * 电脑使用的护栏（自 cu/full 移植，按 2026-11-16「只留放行」收缩后的口径）——
 * 工具分档名单 + 两级预算，全部经 `createToolCallGate` 的公开行为测。
 *
 * 会话授权 / 破坏性确认弹卡 / 「这类不再问」随审批体系一起删了，对应的测试不再存在；
 * 预算是沙箱写动作仅剩的硬护栏，必须钉住。一轮一份 gate（runtime 的开轮装配），
 * 所以每个测试里的 gate 都是「一轮」：计数随 gate 一起重置，这正是「按轮重置」的口径。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createToolCallGate, type ToolCallLike } from "./permission.ts";
import {
  COMPUTER_USE_CONFINED_WRITE_TOOLS,
  COMPUTER_USE_ESCAPING_WRITE_TOOLS,
  COMPUTER_USE_READ_TOOLS,
  computerUseWriteTier,
} from "../shared/permission.ts";
import { COMPUTER_USE_TOOL_NAMES } from "./computer-tools.ts";
import { SANDBOX_BROWSER_TOOL_NAMES } from "./sandbox-tools.ts";

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallLike {
  return { toolCallId: `c-${toolName}`, toolName, input };
}

/** 一轮的闸门：abort 收集硬限中断，now 注入固定时钟（20 分钟边界不 sleep） */
function computerGate(options: { now?: () => number } = {}) {
  const aborts: string[] = [];
  const gate = createToolCallGate([], "/tmp", {
    abort: (message) => aborts.push(message),
    now: options.now ?? (() => 1_000),
  });
  return { gate, aborts };
}

describe("电脑使用：写件分档（名单真源核对）", () => {
  /**
   * **表驱动 + 名字真源**：工具名不在这里手抄，而是从两处工具定义列表（computer-tools.ts /
   * sandbox-tools.ts）取——以后加一件写工具、忘了归类，这条测试当场红。「只留放行」后
   * 分档不再驱动审批，但它是预算归类与「逸出口径」的唯一真源，漏归类=绕过计数。
   */
  test("每一件写工具都被分档，一件不漏：写件两档 ∪ 读件 = 全部工具名", () => {
    const classified = new Set<string>();
    for (const tool of COMPUTER_USE_CONFINED_WRITE_TOOLS) classified.add(tool);
    for (const tool of COMPUTER_USE_ESCAPING_WRITE_TOOLS) classified.add(tool);
    assert.equal(
      classified.size,
      COMPUTER_USE_CONFINED_WRITE_TOOLS.length + COMPUTER_USE_ESCAPING_WRITE_TOOLS.length,
      "两档之间有重叠",
    );

    for (const tool of [...COMPUTER_USE_TOOL_NAMES, ...SANDBOX_BROWSER_TOOL_NAMES]) {
      const tier = computerUseWriteTier(tool);
      const readOnly = (COMPUTER_USE_READ_TOOLS as readonly string[]).includes(tool);
      assert.equal(
        tier !== null || readOnly,
        true,
        `${tool} 既不是读件也没有分档——新增 computer use 工具必须归到 confined / escaping`,
      );
      assert.equal(tier !== null && readOnly, false, `${tool} 不能同时是读件与写件`);
    }
  });
});

describe("电脑使用：两级预算", () => {
  const NOW = 1_000;

  test("第 60 次放行，第 61 次返回软限错误且**不中断**", () => {
    const { gate, aborts } = computerGate({ now: () => NOW });
    for (let i = 1; i <= 60; i += 1) {
      assert.deepEqual(gate(event("computer_screenshot")), {}, `第 ${i} 次应放行`);
    }
    const soft = gate(event("computer_screenshot"));
    assert.equal(soft.block, true);
    assert.match(soft.reason ?? "", /budget/i);
    assert.deepEqual(aborts, [], "软限不中断本轮");
  });

  test("第 90 次仍是软限；第 91 次触发硬限并调用 abort（中断本轮）", () => {
    const { gate, aborts } = computerGate({ now: () => NOW });
    for (let i = 1; i <= 60; i += 1) {
      assert.deepEqual(gate(event("computer_screenshot")), {}, `第 ${i} 次应放行`);
    }
    // 第 61..90 次：软限挡下，但每次尝试都计数
    for (let attempt = 61; attempt <= 90; attempt += 1) {
      const soft = gate(event("computer_screenshot"));
      assert.equal(soft.block, true, `第 ${attempt} 次应为软限`);
      assert.match(soft.reason ?? "", /budget/i);
    }
    assert.deepEqual(aborts, [], "第 90 次还是软限");
    // 第 91 次：硬限
    const hard = gate(event("computer_screenshot"));
    assert.equal(hard.block, true);
    assert.match(hard.reason ?? "", /hard limit/i);
    assert.equal(aborts.length, 1, "硬限必须中断本轮");
    assert.match(aborts[0] ?? "", /hard limit/i);
  });

  test("20 分钟硬限：差 1ms 放行，正好到线 abort 并给出人话原因", () => {
    let now = 5_000;
    const { gate, aborts } = computerGate({ now: () => now });
    gate(event("computer_screenshot"));
    now += 20 * 60_000 - 1;
    assert.deepEqual(gate(event("computer_screenshot")), {}, "差 1ms 仍放行");
    now += 1;
    const hard = gate(event("computer_screenshot"));
    assert.equal(hard.block, true);
    assert.match(hard.reason ?? "", /20 minutes|hard limit/i);
    assert.equal(aborts.length, 1);
    assert.match(aborts[0] ?? "", /20 minutes/i);
  });

  test("预算按轮重置：新 gate（新一轮）从 0 开始", () => {
    const first = computerGate({ now: () => NOW });
    for (let i = 1; i <= 61; i += 1) first.gate(event("computer_screenshot"));
    assert.equal(first.gate(event("computer_screenshot")).block, true);

    const second = computerGate({ now: () => NOW });
    assert.deepEqual(second.gate(event("computer_screenshot")), {});
  });

  test("非 computer 工具不耗预算", () => {
    const { gate } = computerGate({ now: () => NOW });
    for (let i = 0; i < 200; i += 1) gate(event("bash", { command: "ls" }));
    assert.deepEqual(gate(event("computer_screenshot")), {});
  });

  test("computer use 不注入预算钩子 = 不计数（工具组没注册的轮次）", () => {
    const gate = createToolCallGate([], "/tmp");
    for (let i = 1; i <= 100; i += 1) {
      assert.deepEqual(gate(event("computer_screenshot")), {}, `第 ${i} 次应放行（没有钩子）`);
    }
  });

  test("网页车道与 UIA 车道的写工具同耗预算", () => {
    const { gate } = computerGate({ now: () => NOW });
    for (let i = 1; i <= 59; i += 1) gate(event("computer_screenshot"));
    assert.deepEqual(gate(event("sandbox_click", { selector: "#x" })), {}, "第 60 次放行");
    const soft = gate(event("computer_uia", { action: "invoke" }));
    assert.equal(soft.block, true, "sandbox_* 与 computer_uia 同在预算口径里");
  });
});
