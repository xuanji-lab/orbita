/**
 * Codex rollout 转换的 fixture 测试。**本机没有真实 Codex 样本**——fixture 按
 * 公开逆向描述构造（dev.to / agentworth.dev / codingagent2otel / memory-engine，
 * 见 codex.ts 文件头的依据说明）；首次接真实数据时以樊嘉铭的样本校准。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { codexUserText, parseCodexRollout } from "./codex.ts";

function line(type: string, payload: unknown, timestamp = "2026-09-12T10:00:00.000Z"): string {
  return JSON.stringify({ timestamp, type, payload });
}

const FIXTURE = [
  line("session_meta", { id: "6f1c2b70", timestamp: "2026-09-12T09:00:00.000Z", cwd: "/Users/fjm/paper", cli_version: "0.8.0" }),
  line("turn_context", { cwd: "/Users/fjm/paper", model: "gpt-5-codex" }),
  line("response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context>\nmode: cli\n</environment_context>\n\n帮我把第二章的论证理一遍" }],
  }),
  line("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "先看章节结构" }] }),
  line("response_item", { type: "function_call", name: "read_file", arguments: "{}", call_id: "c1" }),
  line("response_item", { type: "function_call_output", call_id: "c1", output: "..." }),
  line("response_item", { type: "reasoning", summary: [{ type: "summary_text", text: "给出口径" }] }),
  line("response_item", {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "第二章的批判是为引出核心问题。" }],
  }, "2026-09-12T10:05:00.000Z"),
  line("event_msg", { type: "token_count", payload: {} }),
].join("\n");

test("解析：meta / 模型 / 消息与 thinking / 工具项不导 / 注入剥掉", () => {
  const rollout = parseCodexRollout(FIXTURE, "unassigned");
  assert.equal(rollout.meta.id, "6f1c2b70");
  // provider 由调用方给（导入落占位），不再写死
  const reply = rollout.messages.find((message) => message.role === "assistant");
  assert.equal(reply?.role === "assistant" ? reply.provider : null, "unassigned");
  assert.equal(rollout.meta.cwd, "/Users/fjm/paper");
  assert.equal(rollout.model, "gpt-5-codex");
  assert.equal(rollout.hasAssistant, true);
  assert.equal(rollout.lastTimestamp, Date.parse("2026-09-12T10:05:00.000Z"));
  // user 一条（display 剥掉 environment_context）、assistant 一条（thinking 两条拼上）
  assert.deepEqual(
    rollout.messages.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.equal(rollout.userDisplays[0], "帮我把第二章的论证理一遍");
  const assistant = rollout.messages[1];
  assert.ok(assistant !== undefined && assistant.role === "assistant");
  assert.deepEqual(
    assistant.content.map((block) => block.type),
    ["thinking", "thinking", "text"],
  );
  // 工具项（function_call / output）没进消息
  assert.equal(rollout.messages.length, 2);
  // 首条用户自己的话
  assert.equal(rollout.firstPrompt, "帮我把第二章的论证理一遍");
});

test("解析：纯注入的 user 是 display null；没有 assistant = 不可转换；坏行跳过", () => {
  const raw = [
    line("session_meta", { id: "x", cwd: "/w" }),
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<user_instructions>别乱动</user_instructions>" }] }),
    "{ 这是一行坏 JSON",
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "真实问题" }] }),
  ].join("\n");
  const rollout = parseCodexRollout(raw, "p");
  assert.deepEqual(rollout.userDisplays, [null, "真实问题"]);
  assert.equal(rollout.hasAssistant, false);
  assert.equal(rollout.messages.length, 2, "坏行跳过，前后都保留");
});

test("codexUserText：剥 environment_context 与 user_instructions，全注入为 null", () => {
  assert.equal(codexUserText("<environment_context>\nabc\n</environment_context>\n你好"), "你好");
  assert.equal(codexUserText("没有注入的话"), "没有注入的话");
  assert.equal(codexUserText("<user_instructions>x</user_instructions>"), null);
});
