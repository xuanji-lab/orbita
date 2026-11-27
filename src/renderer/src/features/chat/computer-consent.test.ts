/**
 * 电脑使用授权的纯派生层（computer-consent.ts）：三段状态各自对应哪张 UI 元素。
 *
 * 这些断言就是两张 UI 的契约：未授权 / 等回答 / 已允许 / 已拒绝 四种形态下，
 * 确认行与记录行分别出不出现、挂在哪一条工具调用下面。
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import {
  consentRecordKind,
  firstComputerUseToolCallId,
  isComputerUseToolName,
  runningComputerUseToolCallId,
  showsConsentStatusLine,
} from "./computer-consent.ts";

/** 一条 assistant 消息（带 n 个工具调用） */
function assistantToolCalls(id: string, calls: Array<{ id: string; name: string }>): TranscriptItem {
  return {
    role: "assistant",
    id,
    timestamp: 1,
    content: calls.map((call) => ({ type: "toolCall", toolCallId: call.id, toolName: call.name, input: {} })),
  } as unknown as TranscriptItem;
}

/** 一条工具结果 */
function toolResult(id: string, name: string, status: "running" | "success" | "error"): TranscriptItem {
  return {
    role: "tool",
    id: `r-${id}`,
    toolCallId: id,
    toolName: name,
    timestamp: 2,
    status,
    content: [],
  } as unknown as TranscriptItem;
}

const TRANSCRIPT: TranscriptItem[] = [
  assistantToolCalls("a1", [
    { id: "t0", name: "bash" },
    { id: "t1", name: "computer_screenshot" },
  ]),
  toolResult("t0", "bash", "success"),
  assistantToolCalls("a2", [{ id: "t2", name: "sandbox_navigate" }]),
  toolResult("t1", "computer_screenshot", "success"),
];

test("工具名：computer_* 与 sandbox_* 才算电脑操作，别的（bash / read）不算", () => {
  assert.equal(isComputerUseToolName("computer_screenshot"), true);
  assert.equal(isComputerUseToolName("computer_uia"), true);
  assert.equal(isComputerUseToolName("sandbox_navigate"), true);
  assert.equal(isComputerUseToolName("bash"), false);
  assert.equal(isComputerUseToolName("computer"), false);
  assert.equal(isComputerUseToolName("read_task"), false);
});

test("第一处电脑工具调用：名额给最早那条（记录行的挂点），不问它有没有结果", () => {
  assert.equal(firstComputerUseToolCallId(TRANSCRIPT), "t1");
  assert.equal(firstComputerUseToolCallId([]), null);
});

test("正在等授权的调用：最后一条还没落定的（确认行的挂点）；都落定就是 null", () => {
  // t2 还没有结果 → 它是正在跑的那条
  assert.equal(runningComputerUseToolCallId(TRANSCRIPT), "t2");
  // 加一条 running 的结果帧 → 它才是最靠后、还在等授权的那条
  const withRunning = [
    ...TRANSCRIPT,
    assistantToolCalls("a3", [{ id: "t3", name: "computer_click" }]),
    toolResult("t3", "computer_click", "running"),
  ];
  assert.equal(runningComputerUseToolCallId(withRunning), "t3");
  // 全部落定 → 没有确认行的挂点（落在 footer 兜底位）
  const settled = [...TRANSCRIPT, assistantToolCalls("a3", [{ id: "t2", name: "sandbox_navigate" }]), toolResult("t2", "sandbox_navigate", "success")];
  assert.equal(runningComputerUseToolCallId(settled), null);
});

test("记录行：只在第一处电脑调用下面画，且 unset（撤销后）整行消失", () => {
  assert.equal(consentRecordKind("allowed", "t1", "t1"), "allowed");
  assert.equal(consentRecordKind("denied", "t1", "t1"), "denied");
  // 不是挂点：别的工具行（哪怕也是电脑工具）下面不重复画
  assert.equal(consentRecordKind("allowed", "t2", "t1"), null);
  assert.equal(consentRecordKind("allowed", "t0", "t1"), null);
  // 撤销 / 从没问过：没有记录可画
  assert.equal(consentRecordKind("unset", "t1", "t1"), null);
  // 转录里还没有电脑工具：没有挂点
  assert.equal(consentRecordKind("allowed", "t1", null), null);
});

test("乙的状态行：只有已允许才出现（未授权交给甲，拒绝不常驻打扰）", () => {
  assert.equal(showsConsentStatusLine("allowed"), true);
  assert.equal(showsConsentStatusLine("unset"), false);
  assert.equal(showsConsentStatusLine("denied"), false);
});
