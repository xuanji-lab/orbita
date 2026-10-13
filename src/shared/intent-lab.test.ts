/**
 * intent-lab 契约的可测面：/health 解析（contract 7、s3Presets 含 proma）、
 * 渠道常量表（一处真源）、意图口径的 q、/ingest 行的推导。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INTENT_CHANNEL,
  INTENT_MODELS_BY_CHANNEL,
  parseIntentChannel,
  parseIntentHealth,
  ingestRowOf,
  userSpeechIn,
  intentQuestionText,
  type IntentHealth,
} from "./intent-lab.ts";
import { CLOSING_SCAN_PROMPT } from "./closing-scan.ts";
import type { SessionRecord } from "./session.ts";

const HEALTH_7 = {
  ok: true,
  contract: 7,
  source: "orbita",
  qaImported: 10,
  qaIngested: 32,
  qaVisible: 42,
  swarm: { endpoint: "deepseek", model: "deepseek-chat" },
  main: { model: "deepseek-chat" },
  gate: { endpoint: "deepseek", model: "deepseek-chat" },
  s1: { endpoint: "deepseek", model: "deepseek-chat" },
  s4: { endpoint: "proma", model: "proma/27b" },
  s3Presets: ["two-stage", "b-only", "deepseek", "proma"],
  endpoints: { deepseek: { model: "deepseek-chat" }, proma: { model: "proma/27b" } },
  budgetMs: 900000,
  peak: false,
};

test("contract 7 的 /health 全字段解析（s3Presets 含 proma）", () => {
  const parsed = parseIntentHealth(HEALTH_7);
  assert.notEqual(parsed, null);
  if (parsed === null) return;
  const health: IntentHealth = parsed;
  assert.equal(health.contract, 7);
  assert.equal(health.qaIngested, 32);
  assert.deepEqual(health.s3Presets, ["two-stage", "b-only", "deepseek", "proma"]);
  assert.equal(health.endpoints?.["proma"]?.model, "proma/27b");
});

test("畸形 /health 返回 null（探活语义：畸形等于不可用）", () => {
  assert.equal(parseIntentHealth(null), null);
  assert.equal(parseIntentHealth({ ok: true }), null); // 缺 swarm / main
  assert.equal(parseIntentHealth({ ...HEALTH_7, contract: 1 }), null);
  // s3Presets 逐项校验：坏值过滤掉，不连带拒收探活结论（端点清单只是展示面）
  assert.deepEqual(parseIntentHealth({ ...HEALTH_7, s3Presets: [1, "deepseek", null] })?.s3Presets, ["deepseek"]);
});

test("渠道常量表：两条渠道都全显式（gate/s1/s4/s3），端名与预设对应", () => {
  assert.deepEqual(INTENT_MODELS_BY_CHANNEL.proma, { gate: "proma", s1: "proma", s4: "proma", s3: "proma" });
  assert.deepEqual(INTENT_MODELS_BY_CHANNEL.deepseek, { gate: "deepseek", s1: "deepseek", s4: "deepseek", s3: "deepseek" });
});

test("渠道解析：缺省 proma，坏值回 proma，认 deepseek", () => {
  assert.equal(DEFAULT_INTENT_CHANNEL, "proma");
  assert.equal(parseIntentChannel(undefined), "proma");
  assert.equal(parseIntentChannel("deepseek"), "deepseek");
  assert.equal(parseIntentChannel("nonsense"), "proma");
});

test("意图口径的 q：引用块原样保留，粘贴全文接在后面", () => {
  assert.equal(intentQuestionText("正文", []), "正文");
  const composed = intentQuestionText("看这段", ["很长的粘贴文本"]);
  assert.ok(composed.includes("看这段"));
  assert.ok(composed.includes("<pasted-text>"));
  assert.ok(composed.includes("很长的粘贴文本"));
});

test("userSpeechIn：信封与收尾扫描不是用户的话，空文本也不算", () => {
  assert.equal(userSpeechIn("帮我看看"), true);
  assert.equal(userSpeechIn("<channel from=\"parent\" kind=\"task\" peer=\"p1\" message=\"m1\">任务</channel>"), false);
  assert.equal(userSpeechIn(CLOSING_SCAN_PROMPT), false);
  assert.equal(userSpeechIn("   "), false);
});

test("ingestRowOf：q 用意图口径、a 取最后一条 assistant 终态的最后一段", () => {
  const transcript: SessionRecord[] = [
    { role: "user", id: "u1", content: [{ type: "text", text: "问" }], timestamp: 1 },
    {
      role: "assistant",
      id: "a1",
      status: "complete",
      stopReason: "stop",
      model: { provider: "p", id: "m" },
      content: [
        { type: "text", text: "中间" },
        { type: "text", text: "最终答案" },
      ],
      timestamp: 2,
    },
  ];
  const row = ingestRowOf("s1", "t1", "标题", "问", ["粘贴"], transcript, 5);
  assert.equal(row.sessionId, "s1");
  assert.equal(row.turnId, "t1");
  assert.equal(row.a, "最终答案");
  assert.ok(row.q.includes("粘贴"));
  // 没有任何回答 → a 空串（契约：空回答也送）
  const empty = ingestRowOf("s1", "t1", "标题", "问", [], [], 5);
  assert.equal(empty.a, "");
});
