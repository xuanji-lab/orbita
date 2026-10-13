/**
 * 回答前确认（Tier B 第二批）的可测核：等待器（等待 / 应答 / 结掉 / 陈旧应答）、
 * /feedback 客户端（成功 / 404 / 网络失败）、行状态机（三态 / 改字 / 两个按钮的
 * answers）、IntentRecallRecord 的 confirm 校验。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { IntentConfirmWaiter } from "./intent-confirm-wait.ts";
import { submitIntentFeedback } from "./intent-recall-client.ts";
import { INTENT_FEEDBACK_FAILED } from "../shared/intent-recall.ts";
import {
  buildConfirmAnswers,
  buildSkipAllAnswers,
  editConfirmRow,
  initialConfirmRows,
  toggleConfirmVerdict,
  type IntentConfirmDecision,
} from "../shared/intent-confirm.ts";
import { isIntentRecallRecord, type IntentRecallRecord } from "../shared/session.ts";
import type { IntentAskView } from "../shared/intent-recall.ts";
import type { AgentEvent } from "../shared/agent-ipc.ts";

const ASK: IntentAskView[] = [
  { askId: "a1", qaId: "q1", slot: "岗一", statement: "陈述一", quote: "摘句一", when: "09-25 10:00", title: "会话一", whyUncertain: "理由" },
  { askId: "a2", qaId: "q2", slot: "岗二", statement: "陈述二", quote: "", when: "09-25 11:00", title: "会话二", whyUncertain: "理由" },
];

test("等待器：请示发出、应答按 requestId 结掉", async () => {
  const sent: AgentEvent[] = [];
  const waiter = new IntentConfirmWaiter((event) => sent.push(event));
  const pending = waiter.ask("s1", "run-1", "t1", ASK);
  assert.equal(sent.length, 1);
  const ask = sent[0];
  assert.equal(ask?.type, "intentAsk");
  if (ask?.type === "intentAsk") {
    assert.equal(ask.sessionId, "s1");
    assert.equal(ask.runId, "run-1");
    assert.equal(ask.turnId, "t1");
    assert.equal(ask.ask.length, 2);
    assert.ok(ask.requestId.startsWith("s1:intent:"));
    const decision: IntentConfirmDecision = { action: "confirm", answers: buildSkipAllAnswers(ASK), note: "" };
    assert.equal(waiter.answer(ask.requestId, decision), true);
    assert.equal(await pending, decision);
  }
  assert.equal(waiter.size, 0);
});

test("等待器：settle 把等待按取消结掉（停止 / 抢跑 / 删会话）", async () => {
  const waiter = new IntentConfirmWaiter(() => {});
  const pending = waiter.ask("s1", "run-1", "t1", ASK);
  waiter.settle("s1");
  assert.equal(await pending, "cancelled");
  waiter.settle("s1"); // 没有 waiting 是 no-op，不抛
});

test("等待器：陈旧应答丢弃，不串台", async () => {
  const waiter = new IntentConfirmWaiter(() => {});
  const first = waiter.ask("s1", "run-1", "t1", ASK);
  waiter.settle("s1");
  const second = waiter.ask("s1", "run-2", "t1", ASK);
  // 陈旧 requestId（第一轮的）应答：不结第二轮
  assert.equal(waiter.answer("s1:intent:stale", { action: "skip-all", answers: [], note: "" }), false);
  assert.equal(waiter.size, 1);
  // 正常应答第二轮
  const sent: AgentEvent[] = [];
  const waiter2 = new IntentConfirmWaiter((event) => sent.push(event));
  void second;
  void first;
  void waiter2;
});

test("等待器：requestId 无法解析时拒绝", () => {
  const waiter = new IntentConfirmWaiter(() => {});
  assert.equal(waiter.answer("not-a-request-id", { action: "skip-all", answers: [], note: "" }), false);
});

test("/feedback：成功返回 injection / edgesWritten / promoted（契约 7，缺席容忍）", async () => {
  // 带 promoted（表态提升条数）与 context（上下文文件全文）
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { runId: string; note?: string };
      assert.equal(parsed.runId, "run-1");
      assert.equal(parsed.note, "补一句"); // note 非空要带上
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          injection: "最终注入块",
          edgesWritten: 3,
          promoted: 2,
          context: { question: 4, md: "# 上下文", jsonl: "{}", added: 5, notice: "（在上下文.md 第 1–5 行）" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const result = await submitIntentFeedback(`http://127.0.0.1:${port}`, "run-1", [{ askId: "a1", verdict: "yes" }], "补一句");
  assert.deepEqual(result, {
    ok: true,
    injection: "最终注入块",
    edgesWritten: 3,
    promoted: 2,
    context: { question: 4, md: "# 上下文", jsonl: "{}", added: 5, notice: "（在上下文.md 第 1–5 行）" },
  });
  server.close();
});

test("/feedback：旧服务端没有 promoted / context → null（容忍缺失）", async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, injection: "注入", edgesWritten: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const result = await submitIntentFeedback(`http://127.0.0.1:${port}`, "run-1", [], "");
  assert.deepEqual(result, { ok: true, injection: "注入", edgesWritten: 1, promoted: null, context: null });
  server.close();
});

test("/feedback：404（run 过期）→ 机器码前缀 + retryable 语义的 message", async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "run not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const result = await submitIntentFeedback(`http://127.0.0.1:${port}`, "run-1", [], "");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.message.startsWith(INTENT_FEEDBACK_FAILED));
    assert.ok(result.message.includes("404"));
  }
  server.close();
});

test("/feedback：连不上 → 机器码前缀", async () => {
  const result = await submitIntentFeedback("http://127.0.0.1:1", "run-1", [], "");
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.message.startsWith(INTENT_FEEDBACK_FAILED));
});

test("行状态机：默认全不表态；点选中、再点同一个回到不表态", () => {
  let rows = initialConfirmRows(ASK);
  assert.deepEqual(rows.map((row) => row.verdict), ["skip", "skip"]);
  rows = toggleConfirmVerdict(rows, "a1", "yes");
  assert.equal(rows[0]?.verdict, "yes");
  rows = toggleConfirmVerdict(rows, "a1", "yes"); // 再点「对」→ 回到不表态
  assert.equal(rows[0]?.verdict, "skip");
  rows = toggleConfirmVerdict(rows, "a1", "no");
  rows = toggleConfirmVerdict(rows, "a1", "yes"); // 从「不对」切到「对」
  assert.equal(rows[0]?.verdict, "yes");
});

test("行状态机：改字与原文相同（trim）不带 edited；不同则带", () => {
  let rows = initialConfirmRows(ASK);
  rows = editConfirmRow(rows, "a1", "陈述一 "); // 只是空白差异 → 不算改过
  rows = editConfirmRow(rows, "a2", "矫正后的说法");
  const answers = buildConfirmAnswers(rows, ASK);
  assert.equal(answers[0]?.edited, undefined);
  assert.equal(answers[1]?.edited, "矫正后的说法");
  // verdict 与 edited 并存
  rows = toggleConfirmVerdict(rows, "a2", "no");
  const answers2 = buildConfirmAnswers(rows, ASK);
  assert.equal(answers2[1]?.verdict, "no");
  assert.equal(answers2[1]?.edited, "矫正后的说法");
});

test("两个按钮的 answers：确认按钮按行态生成；不确认按钮全 skip", () => {
  let rows = initialConfirmRows(ASK);
  rows = toggleConfirmVerdict(rows, "a1", "yes");
  rows = toggleConfirmVerdict(rows, "a2", "no");
  const confirmed = buildConfirmAnswers(rows, ASK);
  assert.deepEqual(
    confirmed.map((a) => [a.askId, a.verdict]),
    [["a1", "yes"], ["a2", "no"]],
  );
  const skipped = buildSkipAllAnswers(ASK);
  assert.deepEqual(
    skipped.map((a) => a.verdict),
    ["skip", "skip"],
  );
});

const WITH_CONFIRM: IntentRecallRecord = {
  role: "intent-recall",
  id: "c1",
  turnId: "t1",
  status: "done",
  runId: "r1",
  timestamp: 1,
  startedAt: 1,
  finishedAt: 2,
  scene: null,
  qaTotal: null,
  passed: null,
  budgetMs: null,
  peak: false,
  timings: null,
  summary: null,
  selected: [],
  ask: [],
  error: null,
  halted: null,
  skipped: null,
  gateWhy: null,
  confirm: {
    action: "confirm",
    answers: [
      { askId: "a1", verdict: "yes" },
      { askId: "a2", verdict: "no", edited: "矫正说法" },
    ],
    note: "补的背景",
    edgesWritten: 3,
  },
};

test("IntentRecallRecord 的 confirm 逐字段校验：结构对才收，坏值整条跳过", () => {
  assert.equal(isIntentRecallRecord(WITH_CONFIRM), true);
  assert.equal(isIntentRecallRecord({ ...WITH_CONFIRM, confirm: null }), true); // null = 没弹过卡
  assert.equal(isIntentRecallRecord({ ...WITH_CONFIRM, confirm: { action: "maybe", answers: [], note: "", edgesWritten: 0 } }), false);
  assert.equal(isIntentRecallRecord({ ...WITH_CONFIRM, confirm: { action: "confirm", answers: [{ askId: "a", verdict: "maybe" }], note: "", edgesWritten: 0 } }), false);
  assert.equal(isIntentRecallRecord({ ...WITH_CONFIRM, confirm: { action: "confirm", answers: [{ askId: "a", verdict: "yes", edited: 42 }], note: "", edgesWritten: 0 } }), false);
  assert.equal(isIntentRecallRecord({ ...WITH_CONFIRM, confirm: { action: "confirm", answers: [], note: 5, edgesWritten: 0 } }), false);
});
