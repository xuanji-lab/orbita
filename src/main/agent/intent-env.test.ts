/**
 * 意图系统开轮装配的判定核（intentTurnEnv）—— 谁才跑召回、谁才存档、backfill
 * 什么时候带。纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { intentTurnEnv } from "./intent-env.ts";
import type { SessionRecord } from "../../shared/session.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import { CLOSING_SCAN_PROMPT } from "../../shared/closing-scan.ts";

const ENVELOPE = `<channel from="parent" kind="task" peer="p1" message="m1">父会话投来的任务</channel>`;
assert.notEqual(parseChannelPrompt(ENVELOPE), null); // 夹具自证：信封能被解出

const META_ROOT = { title: "根会话" };
const META_CHILD = { title: "子会话", parentId: "p1" };
// 最后一条 assistant 之后有一条 user（失败尾巴）：backfill 该带它
/** 转录夹具：最后一条 assistant 之后留一条 user（失败尾巴，backfill 该带）。 */
const TRANSCRIPT: SessionRecord[] = [
  { role: "user", id: "u1", content: [{ type: "text", text: "第一句" }], timestamp: 1 },
  {
    role: "assistant",
    id: "a1",
    status: "complete",
    stopReason: "stop",
    model: { provider: "p", id: "m" },
    content: [{ type: "text", text: "答" }],
    timestamp: 2,
  },
  { role: "user", id: "u2", content: [{ type: "text", text: "没答上的那句" }], timestamp: 3 },
];

test("实验开关关：整条链路不碰（命令形状与 main 一字不差）", () => {
  assert.deepEqual(
    intentTurnEnv({ experimentOn: false, baseUrl: "http://x", meta: META_ROOT, transcript: TRANSCRIPT, text: "帮我看看" }),
    { ingest: false },
  );
});

test("根会话的用户原话：召回 + 存档 + backfill", () => {
  const env = intentTurnEnv({
    experimentOn: true,
    sessionIntentEnabled: true,
    baseUrl: "http://x",
    models: { gate: "deepseek", s1: "deepseek", s4: "deepseek", s3: "deepseek" },
    meta: META_ROOT,
    transcript: TRANSCRIPT,
    text: "帮我看看",
  });
  assert.equal(env.ingest, true);
  assert.deepEqual(env.intent, {
    baseUrl: "http://x",
    title: "根会话",
    models: { gate: "deepseek", s1: "deepseek", s4: "deepseek", s3: "deepseek" },
  });
  assert.deepEqual(env.backfill, ["没答上的那句"]);
});

test("models 缺席不带字段（跟随服务端配置）", () => {
  const env = intentTurnEnv({ experimentOn: true, sessionIntentEnabled: true, baseUrl: "http://x", meta: META_ROOT, transcript: null, text: "问" });
  assert.deepEqual(env.intent, { baseUrl: "http://x", title: "根会话" });
});

test("子会话一律不召回不存档；backfill 也只给根会话", () => {
  assert.deepEqual(
    intentTurnEnv({ experimentOn: true, sessionIntentEnabled: true, baseUrl: "http://x", meta: META_CHILD, transcript: TRANSCRIPT, text: "用户在子会话界面发的话" }),
    { ingest: false },
  );
});

test("通道信封不是用户的话：不召回不存档，但 backfill 照带（两本账对齐）", () => {
  const env = intentTurnEnv({
    experimentOn: true,
    sessionIntentEnabled: true,
    baseUrl: "http://x",
    meta: META_ROOT,
    transcript: TRANSCRIPT,
    text: ENVELOPE,
  });
  assert.equal(env.ingest, false);
  assert.equal(env.intent, undefined);
  assert.deepEqual(env.backfill, ["没答上的那句"]);
});

test("收尾扫描的机器提问不召回不存档", () => {
  const env = intentTurnEnv({
    experimentOn: true,
    sessionIntentEnabled: true,
    baseUrl: "http://x",
    meta: META_ROOT,
    transcript: null,
    text: CLOSING_SCAN_PROMPT,
  });
  assert.equal(env.ingest, false);
  assert.equal(env.intent, undefined);
});

test("会话级开关关：不召回（intent 不带）但照常存档攒历史；backfill 不带", () => {
  const env = intentTurnEnv({
    experimentOn: true,
    sessionIntentEnabled: false,
    baseUrl: "http://x",
    meta: META_ROOT,
    transcript: TRANSCRIPT,
    text: "帮我看看",
  });
  assert.equal(env.ingest, true);
  assert.equal(env.intent, undefined);
  assert.equal(env.backfill, undefined);
});

test("meta 缺席（新根会话首条 submit）按根会话处理", () => {
  const env = intentTurnEnv({ experimentOn: true, sessionIntentEnabled: true, baseUrl: "http://x", meta: null, transcript: null, text: "第一句" });
  assert.deepEqual(env.intent, { baseUrl: "http://x", title: "" });
  assert.equal(env.ingest, true);
});
