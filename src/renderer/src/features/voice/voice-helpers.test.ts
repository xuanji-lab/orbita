import { test } from "node:test";
import assert from "node:assert/strict";
import { CHUNK_BYTES, PcmChunker, toPcm16 } from "./pcm.ts";
import { composeDictation, joinSpoken, splitAtSelection } from "./dictation-text.ts";

test("toPcm16：48 kHz 每 3 个样本平均成 1 个；满幅截到 16 bit 两端", () => {
  const samples = new Float32Array([0, 0.3, 0.6, 1, 1, 1, -1, -1, -1]);
  assert.deepEqual([...toPcm16(samples, 48000)], [Math.round(0.3 * 0x7fff), 0x7fff, -0x8000]);
});

test("toPcm16：输入已是 16 kHz 就逐个转换；越界的值夹到 -1..1", () => {
  assert.deepEqual([...toPcm16(new Float32Array([0.5, 2, -3]), 16000)], [Math.round(0.5 * 0x7fff), 0x7fff, -0x8000]);
});

test("PcmChunker：攒够 200 ms 才出一段，余量留到下次；flush 交出不满一段的尾巴", () => {
  const chunker = new PcmChunker();
  // 每个样本 2 字节：CHUNK_BYTES / 4 个样本 = 半段
  assert.equal(chunker.push(new Int16Array(CHUNK_BYTES / 4)).length, 0);
  // 再来两段的量：凑出两个整段，剩半段
  const chunks = chunker.push(new Int16Array(CHUNK_BYTES));
  assert.deepEqual(chunks.map((chunk) => chunk.byteLength), [CHUNK_BYTES, CHUNK_BYTES]);
  assert.equal(chunker.flush()?.byteLength, CHUNK_BYTES / 2);
  assert.equal(chunker.flush(), null);
});

test("joinSpoken：英文词之间补空格，中文与标点直接相连", () => {
  assert.equal(joinSpoken("hello", "world"), "hello world");
  assert.equal(joinSpoken("你好。", "今天"), "你好。今天");
  assert.equal(joinSpoken("GPT", "模型"), "GPT模型");
  assert.equal(joinSpoken("", "你好"), "你好");
});

test("composeDictation 与 splitAtSelection：插在光标处，选区被替换，接缝按规则补空格", () => {
  const { before, after } = splitAtSelection("please call me later", 7, 11);
  assert.deepEqual({ before, after }, { before: "please ", after: " me later" });
  assert.equal(composeDictation(before, "email", after), "please email me later");
  assert.equal(composeDictation("see", "figure", "3"), "see figure 3");
  assert.equal(composeDictation("原文", "", "后文"), "原文后文");
  assert.deepEqual(splitAtSelection("abc", null, null), { before: "abc", after: "" });
});
