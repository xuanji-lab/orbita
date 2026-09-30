import { test } from "node:test";
import assert from "node:assert/strict";
import type { ProtocolEvent } from "./dictation.ts";
import { createStepfunProtocol } from "./stepfun-protocol.ts";

/** 取出一条出站文本消息并解析成对象 */
function sentJson(frame: { kind: string; data: unknown }): Record<string, unknown> {
  assert.equal(frame.kind, "text");
  return JSON.parse(String(frame.data)) as Record<string, unknown>;
}

/** 模拟服务端的一条消息（字符串与二进制两种来法都测） */
function delta(itemId: string, text: string): string {
  return JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", item_id: itemId, text });
}

function completed(itemId: string, transcript: string): string {
  return JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    item_id: itemId,
    transcript,
  });
}

function serverError(code: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type: "invalid_request_error", code, message } });
}

/** 入站一条消息，返回推给生命周期的判定 */
function feed(protocol: ReturnType<typeof createStepfunProtocol>, raw: string): ProtocolEvent[] {
  return protocol.inbound(raw);
}

test("openFrame：session.update 写全音频格式与识别参数；鉴权头是 Bearer", () => {
  const protocol = createStepfunProtocol("sk-test");
  assert.deepEqual(protocol.headers, { Authorization: "Bearer sk-test" });
  const message = sentJson(protocol.openFrame());
  assert.equal(message["type"], "session.update");
  assert.ok(typeof message["event_id"] === "string" && message["event_id"] !== "");
  const input = ((message["session"] as Record<string, unknown>)["audio"] as Record<string, unknown>)["input"] as Record<string, unknown>;
  assert.deepEqual(input["format"], { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 });
  assert.deepEqual(input["transcription"], {
    model: "stepaudio-2.5-asr-stream",
    language: "zh",
    full_rerun_on_commit: true,
    enable_itn: true,
  });
  assert.deepEqual(input["turn_detection"], { type: "server_vad", silence_duration_ms: 1200 });
});

test("audioFrame：PCM 转 base64；event_id 递增不重号", () => {
  const protocol = createStepfunProtocol("sk-test");
  const first = sentJson(protocol.audioFrame(new Uint8Array([1, 2, 255])));
  assert.equal(first["type"], "input_audio_buffer.append");
  assert.equal(first["audio"], "AQL/");
  const second = sentJson(protocol.audioFrame(new Uint8Array([3])));
  assert.notEqual(second["event_id"], first["event_id"]);
});

test("拼句：delta 整体替换不追加；多个 item 按出现顺序拼；二进制来法也认", () => {
  const protocol = createStepfunProtocol("sk-test");
  assert.deepEqual(feed(protocol, delta("a", "你")), [{ kind: "transcript", text: "你", final: false }]);
  // 同一句的第二个 delta 是纠错后的全量，替换
  assert.deepEqual(feed(protocol, delta("a", "你好，请")), [{ kind: "transcript", text: "你好，请", final: false }]);
  // 第二句接在后面
  assert.deepEqual(feed(protocol, delta("b", "帮我查")), [
    { kind: "transcript", text: "你好，请帮我查", final: false },
  ]);
  // 二进制（ArrayBuffer/Uint8Array 的来法）
  const events = protocol.inbound(new TextEncoder().encode(delta("b", "帮我查一下")));
  assert.deepEqual(events, [{ kind: "transcript", text: "你好，请帮我查一下", final: false }]);
});

test("completed 定稿：句子最终文本替换进行中文本；全定稿后 final=true", () => {
  const protocol = createStepfunProtocol("sk-test");
  feed(protocol, delta("a", "你好"));
  feed(protocol, delta("b", "世界"));
  // a 先定稿，b 还在进行：final=false
  assert.deepEqual(feed(protocol, completed("a", "你好，")), [{ kind: "transcript", text: "你好，世界", final: false }]);
  // b 定稿（二遍纠错改了字），全部定稿：final=true
  assert.deepEqual(feed(protocol, completed("b", "世界！")), [
    { kind: "transcript", text: "你好，世界！", final: true },
  ]);
});

test("completed 定稿顺序不影响拼接顺序（按出现顺序，不按完成顺序）", () => {
  const protocol = createStepfunProtocol("sk-test");
  feed(protocol, delta("a", "第一句"));
  feed(protocol, delta("b", "第二句"));
  // 第二句先定稿，第一句还在进行：拼出来仍是「第一句第二句」
  assert.deepEqual(feed(protocol, completed("b", "第二句。")), [
    { kind: "transcript", text: "第一句第二句。", final: false },
  ]);
});

test("stop：发 commit；收尾中最后一句 completed → 先推最终文字再报结束", () => {
  const protocol = createStepfunProtocol("sk-test");
  feed(protocol, delta("a", "收尾"));
  const stop = sentJson(protocol.stopFrame());
  assert.equal(stop["type"], "input_audio_buffer.commit");
  assert.deepEqual(feed(protocol, completed("a", "收尾。")), [
    { kind: "transcript", text: "收尾。", final: true },
    { kind: "ended" },
  ]);
});

test("stop：空缓冲的 commit 回执（没说过话）也当收尾完成", () => {
  const protocol = createStepfunProtocol("sk-test");
  protocol.stopFrame();
  assert.deepEqual(
    feed(protocol, JSON.stringify({ type: "input_audio_buffer.committed", item_id: "item_x", previous_item_id: null })),
    [{ kind: "ended" }],
  );
});

test("收尾阶段服务端报错：安静结束，不当错误（如空缓冲 commit 被拒）", () => {
  const protocol = createStepfunProtocol("sk-test");
  protocol.stopFrame();
  assert.deepEqual(feed(protocol, serverError("invalid_value", "buffer is empty")), [{ kind: "ended" }]);
});

test("没在收尾时：committed（VAD 自动提交）不当结束；报错原样给；max_idle_timeout 当正常结束", () => {
  const protocol = createStepfunProtocol("sk-test");
  assert.deepEqual(
    feed(protocol, JSON.stringify({ type: "input_audio_buffer.committed", item_id: "a", previous_item_id: null })),
    [],
  );
  assert.deepEqual(feed(protocol, serverError("risk_blocked", "内容被拦截")), [
    { kind: "error", failure: { reason: "server", detail: "risk_blocked 内容被拦截" } },
  ]);
  assert.deepEqual(feed(protocol, serverError("max_idle_timeout", "idle")), [{ kind: "ended" }]);
});

test("不认识的消息安静丢弃：坏 JSON、非对象 JSON、没见过的 type", () => {
  const protocol = createStepfunProtocol("sk-test");
  assert.deepEqual(feed(protocol, "not json"), []);
  assert.deepEqual(feed(protocol, "123"), []);
  assert.deepEqual(feed(protocol, JSON.stringify({ type: "session.created", session: {} })), []);
  assert.deepEqual(feed(protocol, JSON.stringify({ type: "conversation.item.created", item: {} })), []);
  assert.deepEqual(feed(protocol, JSON.stringify({ type: "conversation.item.input_audio_transcription.delta" })), []);
});
