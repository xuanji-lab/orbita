/**
 * 电脑使用的护栏（computer use PR4）—— 会话授权 / 破坏性确认 / 两级预算，全部经
 * `createToolCallGate` 的公开行为测。
 *
 * 一轮一份 gate（runtime 的开轮装配），所以每个测试里的 gate 都是「一轮」：预算与
 * 点击历史随 gate 一起重置，这正是「按轮重置」的口径。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createToolCallGate, type ToolCallLike } from "./permission.ts";
import type { PermissionAnswer, PermissionMode } from "../shared/permission.ts";

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallLike {
  return { toolCallId: `c-${toolName}`, toolName, input };
}

function computerGate(options: {
  mode?: PermissionMode;
  state?: "none" | "granted" | "denied" | "revoked";
  answers?: PermissionAnswer[];
  now?: () => number;
}) {
  const asked: ToolCallLike[] = [];
  const grants: boolean[] = [];
  const aborts: string[] = [];
  const answers = [...(options.answers ?? [])];
  let state = options.state ?? "none";
  const gate = createToolCallGate(
    () => options.mode ?? "skip",
    async (request) => {
      asked.push({ ...request, input: { ...request.input } });
      return answers.shift() ?? { behavior: "allow" };
    },
    [],
    "/tmp",
    {
      grantState: () => state,
      grant: () => {
        state = "granted";
        grants.push(true);
      },
      deny: () => {
        state = "denied";
      },
      abort: (message) => aborts.push(message),
      now: options.now ?? (() => 1_000),
    },
  );
  return {
    gate,
    asked,
    grants,
    aborts,
    setState: (next: "none" | "granted" | "denied" | "revoked") => {
      state = next;
    },
  };
}

describe("电脑使用：会话授权（skip 档的洞）", () => {
  test("skip + 未授权：第一次写工具弹**会话卡**，允许后授权成立且这次照常执行", async () => {
    const { gate, asked, grants } = computerGate({ mode: "skip" });
    assert.deepEqual(await gate(event("computer_click", { x: 10, y: 20 })), {});
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.scope, "session");
    assert.deepEqual(grants, [true]);
  });

  test("授权之后同一轮不再问（普通点击 / 打字）", async () => {
    const { gate, asked } = computerGate({ mode: "skip" });
    await gate(event("computer_click", { x: 10, y: 20 }));
    assert.equal(asked.length, 1);
    await gate(event("computer_click", { x: 100, y: 200 }));
    await gate(event("computer_type", { text: "hello" }));
    assert.equal(asked.length, 1, "只有第一次的会话卡");
  });

  test("拒绝会话卡：本会话后续写工具一律人话拒绝，截图仍可看", async () => {
    const { gate, grants } = computerGate({ mode: "skip", answers: [{ behavior: "deny" }] });
    const blocked = await gate(event("computer_click", { x: 1, y: 1 }));
    assert.equal(blocked.block, true);
    assert.match(blocked.reason ?? "", /did not authorize computer use/i);
    assert.deepEqual(grants, []);
    // 第二件：不再弹卡，直接拒
    const again = await gate(event("computer_type", { text: "hello" }));
    assert.equal(again.block, true);
    // 截图是只读：放行（它也不需要授权）
    assert.deepEqual(await gate(event("computer_screenshot")), {});
  });

  test("manual 档照旧逐次问：问的是普通卡（不是会话卡），也不写会话授权", async () => {
    const { gate, asked, grants } = computerGate({ mode: "manual" });
    assert.deepEqual(await gate(event("computer_click", { x: 5, y: 5 })), {});
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.scope, undefined);
    assert.deepEqual(grants, []);
  });

  test("plan 档直接拒，不问也不执行（截图除外）", async () => {
    const { gate, asked } = computerGate({ mode: "plan" });
    const blocked = await gate(event("computer_click", { x: 1, y: 1 }));
    assert.equal(blocked.block, true);
    assert.deepEqual(asked, []);
    assert.deepEqual(await gate(event("computer_screenshot")), {});
  });

  test("撤销后**当前轮立即生效**：下一次写工具直接拒，不再弹卡", async () => {
    const { gate, asked, setState } = computerGate({ mode: "skip" });
    await gate(event("computer_click", { x: 1, y: 1 }));
    assert.equal(asked.length, 1);
    setState("revoked");
    const blocked = await gate(event("computer_click", { x: 2, y: 2 }));
    assert.equal(blocked.block, true);
    assert.match(blocked.reason ?? "", /revoked|emergency stop/i);
    assert.equal(asked.length, 1, "撤销之后不再问");
  });

  test("撤销态下 manual 档同样直接拒（急停不分档位）", async () => {
    const { gate, asked } = computerGate({ mode: "manual", state: "revoked" });
    const blocked = await gate(event("computer_type", { text: "hello" }));
    assert.equal(blocked.block, true);
    assert.deepEqual(asked, []);
  });

  test("重新授权后同一轮恢复放行（撤销不是不可逆的）", async () => {
    const { gate, setState } = computerGate({ mode: "skip", state: "revoked" });
    assert.equal((await gate(event("computer_click", { x: 1, y: 1 }))).block, true);
    setState("granted");
    assert.deepEqual(await gate(event("computer_click", { x: 1, y: 1 })), {});
  });
});

describe("电脑使用：破坏性确认是「弹卡」不是「拒绝」", () => {
  test("D1 组合键：已授权也弹确认（scope=call），允许后照常执行", async () => {
    const { gate, asked } = computerGate({ state: "granted", answers: [{ behavior: "allow" }] });
    assert.deepEqual(await gate(event("computer_key", { key: "alt+f4" })), {});
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.scope, "call");
    assert.equal((asked[0]?.risk)?.rule, "key");
  });

  test("D2 破坏词：拒绝时拦下；允许时执行（不是硬拒规则）", async () => {
    const denied = computerGate({ state: "granted", answers: [{ behavior: "deny" }] });
    const blocked = await denied.gate(event("computer_type", { text: "format d: /q" }));
    assert.equal(blocked.block, true);
    assert.equal((denied.asked[0]?.risk)?.rule, "command");

    const allowed = computerGate({ state: "granted", answers: [{ behavior: "allow" }] });
    assert.deepEqual(await allowed.gate(event("computer_type", { text: "format d: /q" })), {});
    assert.equal((allowed.asked[0]?.risk)?.rule, "command");
  });

  test("D3 同点连点：前 4 次静默，第 5 次弹确认", async () => {
    const { gate, asked } = computerGate({ state: "granted", answers: [{ behavior: "allow" }] });
    for (let i = 0; i < 4; i += 1) {
      await gate(event("computer_click", { x: 300, y: 400 }));
    }
    assert.equal(asked.length, 0);
    await gate(event("computer_click", { x: 302, y: 401 }));
    assert.equal(asked.length, 1);
    assert.equal((asked[0]?.risk)?.rule, "repeat");
    assert.equal((asked[0]?.risk)?.detail, "5");
  });

  test("未授权时第一件就是危险动作：会话卡带上风险，允许一次即确认（不连弹两张）", async () => {
    const { gate, asked } = computerGate({ mode: "skip", answers: [{ behavior: "allow" }] });
    assert.deepEqual(await gate(event("computer_key", { key: "win+l" })), {});
    assert.equal(asked.length, 1);
    assert.equal(asked[0]?.scope, "session");
    assert.equal((asked[0]?.risk)?.rule, "key");
  });

  test("manual 档：风险附在同一张审批卡上，不连问两次", async () => {
    const { gate, asked } = computerGate({ mode: "manual" });
    assert.deepEqual(await gate(event("computer_type", { text: "diskpart" })), {});
    assert.equal(asked.length, 1);
    assert.equal((asked[0]?.risk)?.rule, "command");
  });
});

describe("电脑使用：两级预算", () => {
  const NOW = 1_000;

  test("第 60 次放行，第 61 次返回软限错误且**不中断**", async () => {
    const { gate, aborts } = computerGate({ state: "granted", now: () => NOW });
    for (let i = 1; i <= 60; i += 1) {
      assert.deepEqual(await gate(event("computer_screenshot")), {}, `第 ${i} 次应放行`);
    }
    const soft = await gate(event("computer_screenshot"));
    assert.equal(soft.block, true);
    assert.match(soft.reason ?? "", /budget/i);
    assert.deepEqual(aborts, [], "软限不中断本轮");
  });

  test("第 90 次仍是软限；第 91 次触发硬限并调用 abort（中断本轮）", async () => {
    const { gate, aborts } = computerGate({ state: "granted", now: () => NOW });
    for (let i = 1; i <= 60; i += 1) {
      assert.deepEqual(await gate(event("computer_screenshot")), {}, `第 ${i} 次应放行`);
    }
    // 第 61..90 次：软限挡下，但每次尝试都计数
    for (let attempt = 61; attempt <= 90; attempt += 1) {
      const soft = await gate(event("computer_screenshot"));
      assert.equal(soft.block, true, `第 ${attempt} 次应为软限`);
      assert.match(soft.reason ?? "", /budget/i);
    }
    assert.deepEqual(aborts, [], "第 90 次还是软限");
    // 第 91 次：硬限
    const hard = await gate(event("computer_screenshot"));
    assert.equal(hard.block, true);
    assert.match(hard.reason ?? "", /hard limit/i);
    assert.equal(aborts.length, 1, "硬限必须中断本轮");
    assert.match(aborts[0] ?? "", /hard limit/i);
  });

  test("20 分钟硬限：差 1ms 放行，正好到线 abort 并给出人话原因", async () => {
    let now = 5_000;
    const { gate, aborts } = computerGate({ state: "granted", now: () => now });
    await gate(event("computer_screenshot"));
    now += 20 * 60_000 - 1;
    assert.deepEqual(await gate(event("computer_screenshot")), {}, "差 1ms 仍放行");
    now += 1;
    const hard = await gate(event("computer_screenshot"));
    assert.equal(hard.block, true);
    assert.match(hard.reason ?? "", /20 minutes|hard limit/i);
    assert.equal(aborts.length, 1);
    assert.match(aborts[0] ?? "", /20 minutes/i);
  });

  test("预算按轮重置：新 gate（新一轮）从 0 开始", async () => {
    const first = computerGate({ state: "granted", now: () => NOW });
    for (let i = 1; i <= 60; i += 1) await first.gate(event("computer_screenshot"));
    assert.equal((await first.gate(event("computer_screenshot"))).block, true);

    const second = computerGate({ state: "granted", now: () => NOW });
    assert.deepEqual(await second.gate(event("computer_screenshot")), {});
  });

  test("非 computer 工具不耗预算", async () => {
    const { gate } = computerGate({ state: "granted", now: () => NOW });
    for (let i = 0; i < 200; i += 1) await gate(event("bash", { command: "ls" }));
    assert.deepEqual(await gate(event("computer_screenshot")), {});
  });

  test("未授权被拒的写工具不耗预算（它根本没执行）", async () => {
    const { gate } = computerGate({ mode: "skip", answers: [{ behavior: "deny" }], now: () => NOW });
    assert.equal((await gate(event("computer_click", { x: 1, y: 1 }))).block, true);
    // 被授权拒绝的调用不该占掉额度：60 张截图仍全部放行
    for (let i = 1; i <= 60; i += 1) {
      assert.deepEqual(await gate(event("computer_screenshot")), {}, `第 ${i} 张应放行`);
    }
  });
});
