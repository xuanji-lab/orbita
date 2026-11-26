import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { HandshakeReplyFrame, SealedFrame } from "../../../src/shared/mobile.ts";
import { fromBase64, fromHex, toBase64 } from "./bytes.ts";
import { PhoneChannel } from "./channel.ts";
import { channelKey, generateBoxKeyPair, helloKey, openFrame, sealFrame, sharedSecret } from "./primitives.ts";

// 电脑侧 crypto.test.ts 的同一组向量（RFC 7748 的两把钥匙）
const HOST_PRIVATE = fromHex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const HOST_PUBLIC = fromHex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const DEVICE_PRIVATE = fromHex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
const DEVICE_PUBLIC = fromHex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
const DEVICE_ID = "fedcba9876543210fedcba9876543210";
const NONCE = fromHex("333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152");
const PN = fromHex("4445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60616263");
const HELLO_FRAME = "Iz2qU7Qiif04EkrMdfUS2hqC55GtE7VBy6Pqt1dYTHS6KQXhnBloA3ZIT8EjnqUzeXsMYU8NrD2IP89jtNgIWAk4uHUNggbJjsVfLPey6tKU3W6XlfS2rWYfUrl/";
const HANDSHAKE_REPLY =
  "n88KCDtTjhxZqwfFKU/7HKVfbAVyl1gZxb/thjmzJQUQmetftu6OQj+4mXyrzGvMasVFwKSuSrckI68oCroEEzBnWBD4X3lV0QoOqtfq0g4Oz7qVyd7/AT/gGg7xEBIM6c/n3/gdro0Svg==";
const PING = "05+F0Iho5AaqujS4mQU/L3lLHCkJ3QFTzSdqeYfQ85kOPBBDcmDipA==";
const LIST = "gttASOb/oqgqM72SyHXYEmkDI2VUFfeCJcDoEAoqIVuTyYotc7nxW5wcWF7BpvTndQ==";
const PONG = "iR6oRy0XV2pP1qMpOSjNs6PZKAEaYugYqo4nteSKkkMNGKFT7JVpe2TFEBNxyAy7iBJWuR8C1/30zTUnfPWZbxg=";

/** 扮电脑：用电脑那把钥匙算 Kh / K、密封电脑方向的帧 */
function hostSide(devicePublic: Uint8Array, nonce: Uint8Array, deviceId: string) {
  const dh = sharedSecret(HOST_PRIVATE, devicePublic);
  assert.ok(dh);
  const kh = helloKey(dh, nonce);
  let sendSeq = 0;
  let key: Uint8Array | null = null;
  return {
    reply(body: string, d = deviceId): HandshakeReplyFrame {
      return { v: 1, d, n: 1, ct: toBase64(sealFrame(kh, "hostToDevice", 1, deviceId, body)) };
    },
    openHello(ct: string): string | null {
      const bytes = fromBase64(ct);
      return bytes === null ? null : openFrame(kh, "deviceToHost", 1, deviceId, bytes);
    },
    open(pn: Uint8Array) {
      key = channelKey(dh, nonce, pn, deviceId);
    },
    seal(body: string, n?: number): SealedFrame {
      if (key === null) throw new Error("no key");
      sendSeq = n ?? sendSeq + 1;
      return { v: 1, n: sendSeq, ct: toBase64(sealFrame(key, "hostToDevice", sendSeq, deviceId, body)) };
    },
    openFromDevice(frame: SealedFrame): string | null {
      if (key === null) return null;
      const bytes = fromBase64(frame.ct);
      return bytes === null ? null : openFrame(key, "deviceToHost", frame.n, deviceId, bytes);
    },
  };
}

const okReply = '{"v":1,"id":1,"ok":true,"result":{"host":{"name":"wafo 的 MacBook","protocol":1},"protocol":1}}';

describe("手机信道：hello → 握手应答 → 加密段", () => {
  test("定值向量：hello 帧与电脑侧逐字节一致；向量里的握手应答、pong 解得开；ping / list 的密文一致", () => {
    const channel = PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: HOST_PUBLIC });
    assert.ok(channel);
    const hello = channel.hello({ hostNonce: toBase64(NONCE), requestId: 1, name: "wafo 的 Pixel", pn: PN });
    assert.ok(hello);
    assert.deepEqual(hello, { v: 1, type: "hello", id: 1, d: DEVICE_ID, n: 1, ct: HELLO_FRAME });
    assert.equal(channel.isOpen, false);
    const outcome = channel.acceptHandshake({ v: 1, d: DEVICE_ID, n: 1, ct: HANDSHAKE_REPLY });
    assert.deepEqual(outcome, { ok: true, result: { host: { name: "wafo 的 MacBook", protocol: 1 }, protocol: 1 } });
    assert.equal(channel.isOpen, true);
    assert.deepEqual(channel.sealOutbound('{"id":1,"method":"ping"}'), { v: 1, n: 1, ct: PING });
    assert.deepEqual(channel.sealOutbound('{"id":2,"method":"sessions.list"}'), { v: 1, n: 2, ct: LIST });
    assert.equal(channel.openInbound({ v: 1, n: 1, ct: PONG }), '{"id":1,"ok":true,"result":{"now":1700000000000}}');
  });

  test("握手之前不能发数据帧；hello 只能发一次；nonce 写法不对不发", () => {
    const channel = PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: HOST_PUBLIC });
    assert.ok(channel);
    assert.throws(() => channel.sealOutbound("{}"), /before handshake/);
    assert.equal(channel.hello({ hostNonce: "AAAA", requestId: 1 }), null);
    assert.ok(channel.hello({ hostNonce: toBase64(NONCE), requestId: 1 }));
    assert.equal(channel.hello({ hostNonce: toBase64(NONCE), requestId: 2 }), null);
    assert.throws(() => channel.sealOutbound("{}"), /before handshake/);
    assert.equal(channel.openInbound({ v: 1, n: 1, ct: PONG }), null);
  });

  test("每条连接现生成 pn：两条信道的 hello 密文不同，电脑都解得开", () => {
    const a = PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: HOST_PUBLIC });
    const b = PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: HOST_PUBLIC });
    const helloA = a?.hello({ hostNonce: toBase64(NONCE), requestId: 1 });
    const helloB = b?.hello({ hostNonce: toBase64(NONCE), requestId: 1 });
    assert.ok(helloA && helloB);
    assert.notEqual(helloA.ct, helloB.ct);
    const host = hostSide(DEVICE_PUBLIC, NONCE, DEVICE_ID);
    const bodyA = JSON.parse(host.openHello(helloA.ct) ?? "null") as { pn: string };
    const bodyB = JSON.parse(host.openHello(helloB.ct) ?? "null") as { pn: string };
    assert.notEqual(bodyA.pn, bodyB.pn);
    assert.equal(fromBase64(bodyA.pn)?.length, 32);
  });

  test("握手应答：d 不是自己、n 不是 1、密文被改、明文形状不对、换了把钥匙——都不认", () => {
    const fresh = () => {
      const channel = PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: HOST_PUBLIC });
      assert.ok(channel);
      assert.ok(channel.hello({ hostNonce: toBase64(NONCE), requestId: 1, pn: PN }));
      return channel;
    };
    const host = hostSide(DEVICE_PUBLIC, NONCE, DEVICE_ID);
    assert.equal(fresh().acceptHandshake(host.reply(okReply, "0".repeat(32))), null);
    assert.equal(fresh().acceptHandshake({ v: 1, d: DEVICE_ID, n: 2, ct: HANDSHAKE_REPLY } as unknown as HandshakeReplyFrame), null);
    const tampered = fromBase64(HANDSHAKE_REPLY);
    assert.ok(tampered);
    tampered[3] = (tampered[3] ?? 0) ^ 1;
    assert.equal(fresh().acceptHandshake({ v: 1, d: DEVICE_ID, n: 1, ct: toBase64(tampered) }), null);
    assert.equal(fresh().acceptHandshake(host.reply('{"id":1,"ok":true}')), null);
    assert.equal(fresh().acceptHandshake(host.reply("not json")), null);
    // 冒充者：另一把电脑钥匙算出来的应答
    const impostor = generateBoxKeyPair();
    const fakeDh = sharedSecret(impostor.privateRaw, DEVICE_PUBLIC);
    assert.ok(fakeDh);
    const fakeKh = helloKey(fakeDh, NONCE);
    assert.equal(
      fresh().acceptHandshake({ v: 1, d: DEVICE_ID, n: 1, ct: toBase64(sealFrame(fakeKh, "hostToDevice", 1, DEVICE_ID, okReply)) }),
      null,
    );
    // 失败的应答：解得开就如实给出，但不打开信道
    const failed = fresh();
    assert.deepEqual(failed.acceptHandshake(host.reply('{"v":1,"id":1,"ok":false,"error":{"code":"unauthorized","message":"x"}}')), {
      ok: false,
      code: "unauthorized",
      message: "x",
    });
    assert.equal(failed.isOpen, false);
  });

  test("加密段：seq 恰好加 1 才收；跳号、重号、旧帧重放都拒，且不推进序号", () => {
    const channel = PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: HOST_PUBLIC });
    assert.ok(channel);
    const host = hostSide(DEVICE_PUBLIC, NONCE, DEVICE_ID);
    const hello = channel.hello({ hostNonce: toBase64(NONCE), requestId: 1 });
    assert.ok(hello);
    const body = JSON.parse(host.openHello(hello.ct) ?? "null") as { pn: string };
    const pn = fromBase64(body.pn);
    assert.ok(pn);
    assert.ok(channel.acceptHandshake(host.reply(okReply))?.ok);
    host.open(pn);
    const first = host.seal('{"event":"a"}');
    assert.equal(channel.openInbound(first), '{"event":"a"}');
    assert.equal(channel.openInbound(first), null, "重号");
    const third = host.seal('{"event":"c"}', 3);
    assert.equal(channel.openInbound(third), null, "跳号");
    const second = host.seal('{"event":"b"}', 2);
    assert.equal(channel.openInbound(second), '{"event":"b"}');
    assert.equal(channel.openInbound(third), '{"event":"c"}');
    // 手机 → 电脑：电脑解得开，序号从 1 起连续
    const out1 = channel.sealOutbound('{"id":1,"method":"ping"}');
    const out2 = channel.sealOutbound('{"id":2,"method":"ping"}');
    assert.deepEqual([out1.n, out2.n], [1, 2]);
    assert.equal(host.openFromDevice(out2), '{"id":2,"method":"ping"}');
  });

  test("电脑公钥是坏点：建不了信道", () => {
    assert.equal(PhoneChannel.create({ deviceId: DEVICE_ID, devicePrivate: DEVICE_PRIVATE, hostPublic: new Uint8Array(32) }), null);
  });
});
