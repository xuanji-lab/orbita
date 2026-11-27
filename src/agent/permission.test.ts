import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createToolCallGate, type ToolCallLike } from "./permission.ts";
import { COMMAND_TIMEOUT_DEFAULT_SECONDS } from "../shared/permission.ts";

function event(toolName: string, input: Record<string, unknown> = {}): ToolCallLike {
  return { toolCallId: "c1", toolName, input };
}

describe("createToolCallGate（只留放行）", () => {
  test("写文件、命令与自定义工具都直接放行，没有审批回调", () => {
    const gate = createToolCallGate();
    assert.deepEqual(gate(event("write", { path: "a.ts", content: "x" })), {});
    assert.deepEqual(gate(event("bash", { command: "ls" })), {});
    assert.deepEqual(gate(event("mcp__demo__write", { value: 1 })), {});
  });

  test("旧档不再参与判定：同一个闸门没有 mode 入参，普通写入不会因旧 meta 改变", () => {
    const gate = createToolCallGate([], "/repo");
    assert.deepEqual(gate(event("edit", { path: "src/a.ts", oldText: "a", newText: "b" })), {});
  });

  test("子会话写父会话的工作台不被路径保护误拦", () => {
    const gate = createToolCallGate(["/userData/sessions", "/userData/pi-sessions"], "/repo");
    const write = gate(
      event("write", { path: "/userData/workbenches/parent-1/subsessions/abcd1234-report/report.md", content: "x" }),
    );
    assert.deepEqual(write, {});
    const blocked = gate(event("write", { path: "/userData/sessions/parent-1.jsonl", content: "x" }));
    assert.equal(blocked.block, true);
  });

  test("受保护路径的拒绝语不提权限档", () => {
    const gate = createToolCallGate(["/userData/sessions"], "/repo");
    const result = gate(event("write", { path: "/userData/sessions/a.jsonl", content: "x" }));
    assert.equal(result.block, true);
    assert.doesNotMatch(result.reason ?? "", /permission mode|Plan mode|manual|skip/i);
  });
});

/** 命令超时兜底仍与权限档无关：所有放行调用都先经过它。 */
describe("命令超时兜底（经 createToolCallGate）", () => {
  function clampedTimeout(toolName: string, timeout: unknown): unknown {
    const gate = createToolCallGate();
    const input: Record<string, unknown> = { command: "bun run test" };
    if (timeout !== undefined) input["timeout"] = timeout;
    gate({ toolCallId: "c1", toolName, input });
    return input["timeout"];
  }

  test("填了但太小 → 抬到下限 600 秒", () => {
    assert.equal(clampedTimeout("bash", 60), 600);
    assert.equal(clampedTimeout("bash", 30), 600);
    assert.equal(clampedTimeout("bash", 1), 600);
    assert.equal(clampedTimeout("bash", 599), 600);
    assert.equal(clampedTimeout("powershell", 10), 600);
  });

  test("不填 → 补默认上限 1 小时", () => {
    assert.equal(clampedTimeout("bash", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
    assert.equal(COMMAND_TIMEOUT_DEFAULT_SECONDS, 3600);
    assert.equal(clampedTimeout("powershell", undefined), COMMAND_TIMEOUT_DEFAULT_SECONDS);
  });

  test("填得比下限大就尊重模型自己的判断", () => {
    assert.equal(clampedTimeout("bash", 600), 600);
    assert.equal(clampedTimeout("bash", 900), 900);
    assert.equal(clampedTimeout("bash", 120000), 120000);
  });

  test("非法值不在这里修：工具自己会报 Invalid timeout", () => {
    assert.equal(clampedTimeout("bash", 0), 0);
    assert.equal(clampedTimeout("bash", -5), -5);
    assert.equal(clampedTimeout("bash", Number.NaN), Number.NaN);
    assert.equal(clampedTimeout("bash", "60"), "60");
    assert.equal(clampedTimeout("bash", null), null);
  });

  test("只动命令类工具：read 与 MCP 的同名字段不碰", () => {
    assert.equal(clampedTimeout("read", 5), 5);
    assert.equal(clampedTimeout("mcp__fs__read", 5), 5);
  });

  test("受保护路径拦住的那条早退也先抬", () => {
    const gate = createToolCallGate(["/secrets"], "/work");
    const e = event("bash", { command: "cat /secrets/a.json", timeout: 30 });
    const result = gate(e);
    assert.equal(result.block, true);
    assert.equal(e.input["timeout"], 600);
  });
});
