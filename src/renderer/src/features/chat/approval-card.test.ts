/**
 * 审批卡的形态判定 —— 钉住「会话卡不摆改参数」与「会话卡优先于风险卡」。
 *
 * 为什么这条值得一条测试：闸门在 skip 档发的第一张卡是**会话授权**，而它恰好可能同时
 * 命中破坏性风险（第一次就让它输入 format d: /q）。两种卡混着画时，「改参数」按钮会
 * 让人以为改过的这一步会按新参数执行——闸门的 session 分支根本不读 answer.input，
 * 那一下照样按原参数跑。按钮集合因此是契约的一部分，不是装饰。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { approvalCardShape } from "./approval-card.ts";
import type { ComputerUseRisk } from "@shared/computer-guard";

const risk: ComputerUseRisk = {
  level: "confirm",
  rule: "command",
  detail: "format",
  message: "This command is destructive.",
};

describe("approvalCardShape —— 卡面形态与按钮集合", () => {
  test("会话授权卡：kind=session、不许改参数（即便同时命中风险）", () => {
    assert.deepEqual(approvalCardShape({ scope: "session" }), { kind: "session", canEditArgs: false });
    assert.deepEqual(approvalCardShape({ scope: "session", risk }), { kind: "session", canEditArgs: false });
  });

  test("逐次审批 + 风险：kind=risk，照常可改参数", () => {
    assert.deepEqual(approvalCardShape({ scope: "call", risk }), { kind: "risk", canEditArgs: true });
  });

  test("scope 缺席：按有无风险落到 risk / call，行为与显式 call 一致", () => {
    assert.deepEqual(approvalCardShape({ risk }), { kind: "risk", canEditArgs: true });
    assert.deepEqual(approvalCardShape({}), { kind: "call", canEditArgs: true });
    assert.deepEqual(approvalCardShape({ scope: "call" }), { kind: "call", canEditArgs: true });
  });
});
