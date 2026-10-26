/**
 * permission 事件构造器 —— 钉住「闸门给的可选字段一个都不丢」。
 *
 * 回归背景（2026-10-26 真机验收）：runtime 的 askPermission 曾只转发 toolName / input，
 * `scope` 与 `risk` 半路掉了——skip 档的会话授权卡退化成普通逐次审批卡（点一次允许却
 * 放行整条会话的十个写工具），破坏性确认也没有风险行。这个构造器是那次修复留下的缝：
 * 装配动作搬出 runtime（它是负责人进程入口，import 就启动），这里可以直接断言。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { permissionEvent } from "./permission-event.ts";
import type { ComputerUseRisk } from "../shared/computer-guard.ts";

const risk: ComputerUseRisk = {
  level: "confirm",
  rule: "command",
  detail: "format",
  message: "This command is destructive.",
};

describe("permissionEvent —— 审批事件的拼装", () => {
  test("会话授权卡：scope 与 risk 原样带上（丢掉就是「逐次卡放行整条会话」）", () => {
    const event = permissionEvent({
      sessionId: "S",
      requestId: "S:c1",
      toolName: "sandbox_type",
      input: { selector: "#q", text: "format d: /q" },
      scope: "session",
      risk,
    });

    assert.deepEqual(event, {
      type: "permission",
      sessionId: "S",
      requestId: "S:c1",
      toolName: "sandbox_type",
      input: { selector: "#q", text: "format d: /q" },
      scope: "session",
      risk,
    });
  });

  test("逐次审批（scope=call）也带 risk：破坏性确认卡必须有风险行", () => {
    const event = permissionEvent({
      sessionId: "S",
      requestId: "S:c2",
      toolName: "computer_type",
      input: { text: "format d: /q" },
      scope: "call",
      risk,
    });

    assert.equal(event.scope, "call");
    assert.equal(event.risk?.rule, "command");
  });

  test("两个可选字段都缺席时不留空键（renderer 按「缺席 = 普通审批」判）", () => {
    const event = permissionEvent({
      sessionId: "S",
      requestId: "S:c3",
      toolName: "bash",
      input: { command: "ls src" },
      scope: undefined,
      risk: undefined,
    });

    assert.equal("scope" in event, false);
    assert.equal("risk" in event, false);
    assert.deepEqual(event, {
      type: "permission",
      sessionId: "S",
      requestId: "S:c3",
      toolName: "bash",
      input: { command: "ls src" },
    });
  });
});
