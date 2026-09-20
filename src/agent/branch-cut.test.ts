import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { planBranchCut, type BranchCutEntry } from "./branch-cut.ts";

/** 造一条 pi 文件条目；type 默认 message，role 必填。 */
const entry = (id: string, role: string, type = "message"): BranchCutEntry => ({
  id,
  type,
  message: { role },
});

/** 造一条 pi 本子里的「空 error 回答」（abort / auto_retry 产物，我们不落盘）。 */
const emptyError = (id: string): BranchCutEntry => ({
  id,
  type: "message",
  message: { role: "assistant", stopReason: "error", content: [] },
});

/** 一段典型对话的 pi 文件：头 + user + (assistant → toolResult)*2 + 最终 assistant。 */
const TYPICAL: BranchCutEntry[] = [
  { id: "h", type: "session" },
  { id: "u1", type: "message", message: { role: "user" } },
  entry("a1", "assistant"),
  entry("r1", "toolResult"),
  entry("r2", "toolResult"),
  entry("a2", "assistant"),
  entry("r3", "toolResult"),
  entry("a3", "assistant"),
  { id: "c1", type: "compaction" },
  entry("a4", "assistant"),
];

describe("planBranchCut", () => {
  test("对上且锚点后无 toolResult：返回锚点自身", () => {
    // roles = 前缀里 user/assistant 的序列；锚点是最后一条 assistant
    const roles = ["user", "assistant", "assistant", "assistant"] as const;
    assert.equal(planBranchCut(TYPICAL, roles), "a3");
  });

  test("锚点后跟着它的 toolResult：连吃进来，返回最后一个结果条目", () => {
    // 锚点 = a2（后面是 r3、然后 a3 不是 toolResult，停）
    const roles = ["user", "assistant", "assistant"] as const;
    assert.equal(planBranchCut(TYPICAL, roles), "r3");
  });

  test("锚点后是压缩界碑：不吃，停在锚点（分支点在压缩之前，上下文还原全量）", () => {
    const roles = ["user", "assistant", "assistant", "assistant", "assistant"] as const;
    assert.equal(planBranchCut(TYPICAL, roles), "a4");
  });

  test("toolResult 之后紧跟下一条 assistant 之前停——同轮后续回答不带入", () => {
    const file: BranchCutEntry[] = [
      entry("u1", "user"),
      entry("a1", "assistant"),
      entry("r1", "toolResult"),
      entry("a2", "assistant"),
    ];
    assert.equal(planBranchCut(file, ["user", "assistant"]), "r1");
    assert.equal(planBranchCut(file, ["user", "assistant", "assistant"]), "a2");
  });

  test("pi 的消息比本地记录还少：拒绝", () => {
    assert.throws(
      () =>
        planBranchCut(TYPICAL, [
          "user",
          "assistant",
          "assistant",
          "assistant",
          "assistant",
          "assistant",
        ] as const),
      /Ledger mismatch/,
    );
  });

  test("顺序对不上（漂移）：拒绝", () => {
    assert.throws(
      () => planBranchCut(TYPICAL, ["user", "user", "assistant", "assistant"] as const),
      /order mismatch/,
    );
  });

  test("roles 为空或末位不是 assistant：拒绝", () => {
    assert.throws(() => planBranchCut(TYPICAL, []), /No messages before/);
    assert.throws(() => planBranchCut(TYPICAL, ["user"] as const), /must be an agent reply/);
  });

  test("pi 序列里夹着空 error 回答：不入对账序列，后文照样对得上", () => {
    // 被打断（工具执行中点「打断并发送」）时 pi 会落一条 stopReason:"error" 且
    // content 为空的 assistant，我们不落盘——两侧同样排除才对得上
    const file: BranchCutEntry[] = [
      entry("u1", "user"),
      entry("a1", "assistant"),
      emptyError("e1"),
      entry("u2", "user"),
      entry("a2", "assistant"),
    ];
    assert.equal(planBranchCut(file, ["user", "assistant", "user", "assistant"]), "a2");
  });

  test("空 error 回答紧跟锢点之后：不被吃进裁点", () => {
    const file: BranchCutEntry[] = [
      entry("u1", "user"),
      entry("a1", "assistant"),
      emptyError("e1"),
      entry("u2", "user"),
    ];
    assert.equal(planBranchCut(file, ["user", "assistant"]), "a1");
  });

  test("带内容的 error assistant 照常计入——真失败但说了话，我们也落盘", () => {
    const file: BranchCutEntry[] = [
      entry("u1", "user"),
      { id: "a1", type: "message", message: { role: "assistant", stopReason: "error", content: [{ type: "text" }] } },
    ];
    assert.equal(planBranchCut(file, ["user", "assistant"]), "a1");
    assert.throws(() => planBranchCut(file, ["user", "assistant", "assistant"]), /Ledger mismatch/);
  });

  test("stopReason:\"aborted\" 的空 assistant 不跳——半截回答我们是落盘的", () => {
    const file: BranchCutEntry[] = [
      entry("u1", "user"),
      { id: "a1", type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
    ];
    assert.equal(planBranchCut(file, ["user", "assistant"]), "a1");
  });

  test("压缩界碑与非消息条目不入对账序列", () => {
    // c1（compaction）与 h（session）都不计——上面对上的用例已经隐含这一点，
    // 这里显式再钉一次：单条 user 前全是非消息条目也能对上。
    const file: BranchCutEntry[] = [
      { id: "h", type: "session" },
      { id: "m", type: "model_change" },
      entry("u1", "user"),
      entry("a1", "assistant"),
    ];
    assert.equal(planBranchCut(file, ["user", "assistant"]), "a1");
  });
});
