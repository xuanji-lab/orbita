import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  failureCauseOf,
  subSessionRunOutcome,
  subSessionRunRecordOf,
  type SubSessionRunRecord,
} from "./sub-session-run.ts";

const assistant = (patch: Partial<Extract<SubSessionRunRecord, { role: "assistant" }>> = {}): SubSessionRunRecord => ({
  role: "assistant",
  status: "complete",
  stopReason: "stop",
  hasToolCall: false,
  ...patch,
});

describe("subSessionRunRecordOf", () => {
  it("只留终局字段：assistant 的 toolCall 与 errorMessage、tool / channel-mark 状态", () => {
    assert.deepEqual(
      subSessionRunRecordOf({
        role: "assistant",
        status: "error",
        stopReason: "error",
        errorMessage: "429 quota",
        content: [{ type: "toolCall", toolCallId: "t1" }, { type: "text", text: "large" }],
      }),
      { role: "assistant", status: "error", stopReason: "error", errorMessage: "429 quota", hasToolCall: true },
    );
    assert.deepEqual(subSessionRunRecordOf({ role: "tool", status: "complete", content: [{ text: " huge " }] }), {
      role: "tool",
      status: "complete",
    });
    assert.deepEqual(subSessionRunRecordOf({ role: "channel-mark", from: "parent", kind: "reply" }), {
      role: "channel-mark",
      from: "parent",
      kind: "reply",
    });
    assert.equal(subSessionRunRecordOf({ role: "file-turn", changes: [] }), null);
  });
});

describe("failureCauseOf", () => {
  it("违规 / 拒答、429 / 额度、网络、其它模型错误各自分类", () => {
    assert.equal(failureCauseOf("Request violates content policy"), "refusal");
    assert.equal(failureCauseOf("模型拒答"), "refusal");
    assert.equal(failureCauseOf("Failed after retries: 429 exceeded_current_quota_error"), "quota");
    assert.equal(failureCauseOf("rate limit reached"), "quota");
    assert.equal(failureCauseOf("fetch failed: socket disconnected"), "network");
    assert.equal(failureCauseOf("400 model is not available"), "model");
  });
});

describe("subSessionRunOutcome", () => {
  it("最后一条 assistant stop 且无工具调用 = 正常结束", () => {
    assert.deepEqual(subSessionRunOutcome([assistant()], "app-exit"), {
      kind: "done",
      endCause: "completed",
      text: "",
    });
  });

  it("最后一条 assistant error = 失败；即使带未完成 toolCall 也不能误判 running", () => {
    assert.deepEqual(
      subSessionRunOutcome([assistant({ status: "error", stopReason: "error", hasToolCall: true, errorMessage: "429 quota" })], "app-exit"),
      { kind: "failed", endCause: "quota", text: "429 quota" },
    );
    assert.equal(subSessionRunOutcome([assistant({ status: "error", stopReason: "error", hasToolCall: true })], "app-exit").endCause, "model");
  });

  it("最后一条是 tool（complete 或 running）= 中断；工具完成不等于最终回答完成", () => {
    for (const status of ["complete", "running", "error"]) {
      assert.deepEqual(subSessionRunOutcome([{ role: "tool", status }], "app-exit"), {
        kind: "interrupted",
        endCause: "app-exit",
        text: "",
      });
    }
  });

  it("assistant toolUse / streaming、空记录、最后 user / 新父通道标记都没有收尾", () => {
    const cases: SubSessionRunRecord[][] = [
      [],
      [assistant({ stopReason: "toolUse", hasToolCall: true })],
      [assistant({ status: "streaming", stopReason: "" })],
      [{ role: "user" }],
      [assistant(), { role: "channel-mark", from: "parent", kind: "reply" }],
    ];
    for (const records of cases) {
      assert.equal(subSessionRunOutcome(records, "incomplete").kind, "interrupted", JSON.stringify(records));
    }
  });

  it("abort 单独分类；进程崩溃 / 普通轮尾使用调用方给的中断原因", () => {
    assert.deepEqual(subSessionRunOutcome([assistant({ status: "aborted", stopReason: "aborted" })], "process-exit"), {
      kind: "interrupted",
      endCause: "aborted",
      text: "",
    });
    assert.equal(subSessionRunOutcome([{ role: "tool", status: "complete" }], "process-exit").endCause, "process-exit");
    assert.equal(subSessionRunOutcome([{ role: "tool", status: "complete" }], "incomplete").endCause, "incomplete");
  });
});
