import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { audioFrame, parseServerFrame, startFrame } from "./doubao-protocol.ts";

/** 造一帧服务端响应：可带序号、可标最后一包，负载 gzip JSON */
function serverFrame(body: unknown, options: { sequence?: number; last?: boolean } = {}): Buffer {
  const flags = (options.sequence !== undefined ? 0b0001 : 0) | (options.last === true ? 0b0010 : 0);
  const payload = gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
  const parts = [Buffer.from([0x11, (0b1001 << 4) | flags, 0x11, 0])];
  if (options.sequence !== undefined) {
    const seq = Buffer.alloc(4);
    seq.writeInt32BE(options.sequence, 0);
    parts.push(seq);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  parts.push(size, payload);
  return Buffer.concat(parts);
}

test("startFrame：头是完整请求 + JSON + gzip，负载解开是 16 kHz PCM 与全量结果", () => {
  const frame = startFrame("orbita");
  assert.deepEqual([...frame.subarray(0, 4)], [0x11, 0x10, 0x11, 0x00]);
  const size = frame.readUInt32BE(4);
  assert.equal(size, frame.length - 8);
  const body = JSON.parse(gunzipSync(frame.subarray(8)).toString("utf8"));
  assert.deepEqual(body.audio, { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 });
  assert.equal(body.request.result_type, "full");
  assert.equal(body.user.uid, "orbita");
});

test("audioFrame：仅音频 + 不序列化 + gzip；最后一包带标志，空包也合法", () => {
  const pcm = new Uint8Array([1, 2, 3, 4]);
  const middle = audioFrame(pcm, false);
  assert.deepEqual([...middle.subarray(0, 4)], [0x11, 0x20, 0x01, 0x00]);
  assert.deepEqual([...gunzipSync(middle.subarray(8))], [1, 2, 3, 4]);
  const last = audioFrame(new Uint8Array(), true);
  assert.equal(last[1], 0x22);
  assert.equal(gunzipSync(last.subarray(8)).length, 0);
});

test("parseServerFrame：带序号的中间结果取 result.text；最后一包才算 final", () => {
  const middle = serverFrame({ result: { text: "你好", utterances: [{ text: "你好", definite: true }] } }, { sequence: 3 });
  assert.deepEqual(parseServerFrame(middle), { kind: "result", text: "你好", final: false });
  const last = serverFrame({ result: { text: "你好世界。" } }, { sequence: -4, last: true });
  assert.deepEqual(parseServerFrame(last), { kind: "result", text: "你好世界。", final: true });
});

test("parseServerFrame：没有 text 时拼 utterances；结果是数组时取第一个候选，不拼接", () => {
  const joined = serverFrame({ result: { utterances: [{ text: "第一句。" }, { text: "第二句" }] } });
  assert.deepEqual(parseServerFrame(joined), { kind: "result", text: "第一句。第二句", final: false });
  const candidates = serverFrame({ result: [{ text: "甲" }, { text: "乙" }] });
  assert.deepEqual(parseServerFrame(candidates), { kind: "result", text: "甲", final: false });
});

test("parseServerFrame：错误帧读出码与消息", () => {
  const message = Buffer.from("invalid audio", "utf8");
  const head = Buffer.from([0x11, 0xf0, 0x10, 0]);
  const code = Buffer.alloc(4);
  code.writeUInt32BE(45000001, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(message.length, 0);
  assert.deepEqual(parseServerFrame(Buffer.concat([head, code, size, message])), {
    kind: "error",
    code: 45000001,
    message: "invalid audio",
  });
});

test("parseServerFrame：太短、不认识的类型、坏 JSON 都回 null，不抛", () => {
  assert.equal(parseServerFrame(new Uint8Array([0x11])), null);
  assert.equal(parseServerFrame(Buffer.from([0x11, 0x30, 0x11, 0, 0, 0, 0, 0])), null);
  const bad = gzipSync(Buffer.from("{not json", "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bad.length, 0);
  assert.equal(parseServerFrame(Buffer.concat([Buffer.from([0x11, 0x90, 0x11, 0]), size, bad])), null);
});
