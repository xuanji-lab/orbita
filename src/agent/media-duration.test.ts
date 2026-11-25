/** 读音视频容器头的时长：wav / mp3（Xing、CBR、ID3）/ mp4 mvhd / flac；认不得的容器与残缺文件回 null。 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flacDuration, measureMedia, mp3Duration, mvhdDuration, readMediaDuration, wavDuration } from "./media-duration.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-duration-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function wav(seconds: number, sampleRate = 16000): Buffer {
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(seconds * byteRate);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + dataSize, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(byteRate, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(dataSize, 40);
  return Buffer.concat([head, Buffer.alloc(dataSize)]);
}

/** MPEG1 Layer III 帧头：128 kbps、44.1 kHz、立体声（0xFFFB 9004 → bitrate idx 9 = 128） */
const MP3_FRAME_HEAD = Buffer.from([0xff, 0xfb, 0x90, 0x04]);

describe("wav", () => {
  test("data 块大小 / byteRate", async () => {
    const buf = wav(3);
    assert.equal(wavDuration(buf.subarray(0, 64 * 1024), buf.length), 3);
    const path = join(dir, "a.wav");
    await writeFile(path, buf);
    assert.equal(await readMediaDuration(path), 3);
  });
  test("流式写的 wav（data 大小为 0xFFFFFFFF）按文件剩余字节算", () => {
    const buf = wav(2);
    buf.writeUInt32LE(0xffffffff, 40);
    assert.equal(wavDuration(buf, buf.length), 2);
  });
  test("不是 RIFF / 没有 fmt 就 data：null", () => {
    assert.equal(wavDuration(Buffer.from("not a wav file at all"), 21), null);
  });
});

describe("mp3", () => {
  test("CBR：按「音频字节 / 比特率」", () => {
    // 128 kbps = 16000 B/s；160000 字节 → 10 秒
    const buf = Buffer.concat([MP3_FRAME_HEAD, Buffer.alloc(159996)]);
    assert.equal(mp3Duration(buf, buf.length), 10);
  });
  test("ID3v2 头（10 字节 + 声明的大小）要跳过，不算进音频字节", () => {
    const id3 = Buffer.alloc(10 + 100);
    id3.write("ID3", 0, "latin1");
    id3[3] = 3;
    id3[9] = 100; // syncsafe 大小 = 100
    const buf = Buffer.concat([id3, MP3_FRAME_HEAD, Buffer.alloc(159996)]);
    assert.equal(mp3Duration(buf, buf.length), 10);
  });
  test("Xing 帧数：VBR 精确（1000 帧 × 1152 / 44100）", () => {
    const frame = Buffer.alloc(4 + 32 + 120);
    MP3_FRAME_HEAD.copy(frame, 0);
    frame.write("Xing", 36, "latin1");
    frame.writeUInt32BE(1, 36 + 4); // flags: 有帧数
    frame.writeUInt32BE(1000, 36 + 8);
    const seconds = mp3Duration(frame, 1_000_000);
    assert.ok(seconds !== null && Math.abs(seconds - (1000 * 1152) / 44100) < 1e-9);
  });
  test("找不到帧同步 / 比特率非法：null", () => {
    assert.equal(mp3Duration(Buffer.alloc(2048), 2048), null);
    assert.equal(mp3Duration(Buffer.from([0xff, 0xfb, 0xf0, 0x04, 0, 0, 0, 0]), 8), null);
  });
});

describe("mp4 / mov", () => {
  function box(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, "latin1");
    return Buffer.concat([head, body]);
  }
  function mvhd(timescale: number, duration: number, version = 0): Buffer {
    const body = Buffer.alloc(version === 1 ? 32 : 20);
    body[0] = version;
    if (version === 1) {
      body.writeUInt32BE(timescale, 20);
      body.writeBigUInt64BE(BigInt(duration), 24);
    } else {
      body.writeUInt32BE(timescale, 12);
      body.writeUInt32BE(duration, 16);
    }
    return box("mvhd", body);
  }
  test("mvhd v0：timescale / duration", () => {
    assert.equal(mvhdDuration(mvhd(1000, 18923)), 18.923);
  });
  test("mvhd v1：64 位 duration", () => {
    assert.equal(mvhdDuration(mvhd(600, 6000, 1)), 10);
  });
  test("顶层原子顺序是 ftyp / mdat / moov（moov 在末尾，非 faststart）也找得到", async () => {
    const file = Buffer.concat([box("ftyp", Buffer.from("isom0000", "latin1")), box("mdat", Buffer.alloc(5000)), box("moov", mvhd(1000, 12500))]);
    const path = join(dir, "clip.mp4");
    await writeFile(path, file);
    assert.equal(await readMediaDuration(path), 12.5);
  });
  test("没有 moov / 残缺：null", async () => {
    const path = join(dir, "bad.mp4");
    await writeFile(path, box("ftyp", Buffer.from("isom0000", "latin1")));
    assert.equal(await readMediaDuration(path), null);
  });
});

describe("flac", () => {
  test("STREAMINFO 的采样率与总采样数", () => {
    const buf = Buffer.alloc(42);
    buf.write("fLaC", 0, "latin1");
    // 采样率 44100 = 0x0AC44：20 位，落在字节 18、19、20 的高 4 位
    buf[18] = 0x0a;
    buf[19] = 0xc4;
    buf[20] = 0x40;
    // 总采样数 441000（36 位）：高 4 位在字节 21 低半字节，低 32 位在 22..25
    buf[21] = 0x00;
    buf.writeUInt32BE(441000, 22);
    assert.equal(flacDuration(buf), 10);
  });
});

describe("readMediaDuration / measureMedia", () => {
  test("认不得的容器（ogg / opus / webm / aac）与不存在的文件：null，不抛", async () => {
    const path = join(dir, "x.opus");
    await writeFile(path, Buffer.alloc(100));
    assert.equal(await readMediaDuration(path), null);
    assert.equal(await readMediaDuration(join(dir, "missing.mp3")), null);
  });
  test("measureMedia：量得到的带 duration（一位小数），量不到的缺席", async () => {
    const a = join(dir, "a.wav");
    await writeFile(a, wav(3.04));
    const b = join(dir, "b.ogg");
    await writeFile(b, Buffer.alloc(10));
    assert.deepEqual(await measureMedia([a, b]), [{ path: a, duration: 3 }, { path: b }]);
  });
});
