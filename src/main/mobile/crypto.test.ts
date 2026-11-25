import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  InvalidPeerKeyError,
  boxKeyPairFromRaw,
  boxPrivateKeyFromRaw,
  boxPublicKeyFromRaw,
  channelKey,
  createPairingOffer,
  derivePinKey,
  generateBoxKeyPair,
  helloKey,
  hkdfSha256,
  hmacSha256,
  hostProofOf,
  openFrame,
  openPairingBox,
  pairMessage,
  pairProofOf,
  rawPrivateOf,
  rawPublicOf,
  sealFrame,
  sharedSecret,
  verifyPairProof,
} from "./crypto.ts";
import { MOBILE_CRYPTO } from "../../shared/mobile.ts";

const hex = (bytes: Buffer): string => bytes.toString("hex");
const fromHex = (text: string): Buffer => Buffer.from(text, "hex");
const bytes = (length: number, fill: number): Buffer => Buffer.from(Array.from({ length }, (_, i) => (fill + i) & 0xff));

/**
 * 定值向量——安卓端照 `MOBILE_CRYPTO` 用 `@noble/*` 各写一遍，逐字节对得上才算实现对了。
 * 输入全部是确定性的（见每一项旁边的说明）；密钥用的是 RFC 7748 的 X25519 测试向量，
 * 所以共享秘密那一行同时有 RFC 背书。
 */
const VECTORS = {
  /** RFC 7748 §6.1 的 a */
  hostPrivate: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  /** RFC 7748 §6.1 的 A */
  hostPublic: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  /** RFC 7748 §6.1 的 b */
  devicePrivate: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  /** RFC 7748 §6.1 的 B */
  devicePublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  /** 配对码 */
  code: "246813",
  /** 16 字节：0x11 起 */
  salt: "1112131415161718191a1b1c1d1e1f20",
  /** 12 字节：0x22 起 */
  iv: "22232425262728292a2b2c2d",
  /** 种子 S：0x00 起的 32 字节 */
  seed: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  keyPin: "2e8a15079d813694a0512abe491acacab70c13f911fa6480b66f1f771ba698bf",
  box: "ece9b0909141525deefc72b7a7d8fb0f3a707ca0e0a19470b4f0d5a7041bf79702234f736d0618c33e9dd3c436214551",
  offerId: "0123456789abcdef0123456789abcdef",
  deviceId: "fedcba9876543210fedcba9876543210",
  deviceName: "wafo 的 Pixel",
  M: "6f72626974612d706169722d763130313233343536373839616263646566303132333435363738396162636465661112131415161718191a1b1c1d1e1f2022232425262728292a2b2c2dece9b0909141525deefc72b7a7d8fb0f3a707ca0e0a19470b4f0d5a7041bf79702234f736d0618c33e9dd3c4362145518520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6ade9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f7761666f20e79a8420506978656c",
  proof: "920030ae7aad22bece5be343b268b509be3c557de36c704748fae913399234ca",
  hostProof: "3095a454ba8408ae9350712c685a16e0efa082a703b535353f6c65e358e82e41",
  /** RFC 7748 §6.1 的共享秘密 K */
  dh: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  /** 电脑的新鲜数：32 字节，0x33 起 */
  nonce: "333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152",
  pn: "4445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60616263",
  helloKey: "e418e76918fb0f7dafe466100c9a9a9b5a60c04704881ba00a866bae8340d612",
  channelKey: "829c3f3dc4c0665a27e64661f0c81c0f1603324c593669565b6622543fcd6fd7",
  helloBody: '{"pn":"REVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmM=","name":"wafo 的 Pixel"}',
  helloFrame: "Iz2qU7Qiif04EkrMdfUS2hqC55GtE7VBy6Pqt1dYTHS6KQXhnBloA3ZIT8EjnqUzeXsMYU8NrD2IP89jtNgIWAk4uHUNggbJjsVfLPey6tKU3W6XlfS2rWYfUrl/",
  /** 握手应答的明文 */
  handshakeReplyBody:
    '{"id":1,"ok":true,"result":{"host":{"name":"wafo 的 MacBook","protocol":1},"protocol":1}}',
  handshakeReply:
    "n88KCDtTjhxZqwfFKU/7HKVfbAVyl1gZxb/thjmzJQUQmetftu6OQj+4mXyrzGvMasVFwKSuSrckI68oCroEEzBnWBD4X3lV0QoOqtfq0g4Oz7qVyd7/AT/gGg7xEBIM6c/n3/gdro0Svg==",
  pingBody: '{"id":1,"method":"ping"}',
  ping: "05+F0Iho5AaqujS4mQU/L3lLHCkJ3QFTzSdqeYfQ85kOPBBDcmDipA==",
  pongBody: '{"id":1,"ok":true,"result":{"now":1700000000000}}',
  pong: "iR6oRy0XV2pP1qMpOSjNs6PZKAEaYugYqo4nteSKkkMNGKFT7JVpe2TFEBNxyAy7iBJWuR8C1/30zTUnfPWZbxg=",
  listBody: '{"id":2,"method":"sessions.list"}',
  list: "gttASOb/oqgqM72SyHXYEmkDI2VUFfeCJcDoEAoqIVuTyYotc7nxW5wcWF7BpvTndQ==",
} as const;

describe("已知答案：原语的封装没写错", () => {
  test("X25519：RFC 7748 §6.1——私钥推公钥、两边的共享秘密相同", () => {
    const host = boxKeyPairFromRaw(fromHex(VECTORS.hostPrivate));
    const device = boxKeyPairFromRaw(fromHex(VECTORS.devicePrivate));
    assert.equal(hex(host.publicRaw), VECTORS.hostPublic);
    assert.equal(hex(device.publicRaw), VECTORS.devicePublic);
    assert.equal(hex(rawPrivateOf(host.privateKey)), VECTORS.hostPrivate);
    assert.equal(hex(rawPublicOf(boxPublicKeyFromRaw(fromHex(VECTORS.hostPublic)))), VECTORS.hostPublic);
    assert.equal(hex(sharedSecret(device.privateKey, host.publicRaw)), VECTORS.dh);
    assert.equal(hex(sharedSecret(host.privateKey, device.publicRaw)), VECTORS.dh);
  });

  test("HKDF-SHA256：RFC 5869 Test Case 1", () => {
    const okm = hkdfSha256(
      Buffer.alloc(22, 0x0b),
      fromHex("000102030405060708090a0b0c"),
      fromHex("f0f1f2f3f4f5f6f7f8f9"),
      42,
    );
    assert.equal(
      hex(okm),
      "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
    );
  });

  test("HMAC-SHA256：RFC 4231 Test Case 2（分段喂与一次喂结果一样）", () => {
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    assert.equal(hex(hmacSha256(Buffer.from("Jefe"), Buffer.from("what do ya want for nothing?"))), expected);
    assert.equal(
      hex(hmacSha256(Buffer.from("Jefe"), Buffer.from("what do ya want "), Buffer.from("for nothing?"))),
      expected,
    );
  });

  test(`scrypt N=2^17 r=8 p=1（真参数，一次约几百毫秒）：配对码 → keyPin → box 解出种子`, async () => {
    const keyPin = await derivePinKey(Buffer.from(VECTORS.code), fromHex(VECTORS.salt));
    assert.equal(hex(keyPin), VECTORS.keyPin);
    const seed = await openPairingBox(fromHex(VECTORS.box), fromHex(VECTORS.salt), fromHex(VECTORS.iv), VECTORS.code);
    assert.equal(hex(seed ?? Buffer.alloc(0)), VECTORS.seed);
    // 配对码不对：认证过不了，解不开（手机此时不该再发 pair.prove）
    assert.equal(await openPairingBox(fromHex(VECTORS.box), fromHex(VECTORS.salt), fromHex(VECTORS.iv), "000000"), null);
  });
});

describe("定值向量：整条流程逐字节（安卓端照此对拍）", () => {
  const host = fromHex(VECTORS.hostPublic);
  const device = fromHex(VECTORS.devicePublic);
  const salt = fromHex(VECTORS.salt);
  const iv = fromHex(VECTORS.iv);
  const box = fromHex(VECTORS.box);
  const seed = fromHex(VECTORS.seed);

  test("配对：M → proof → hostProof", () => {
    const message = pairMessage({
      offerId: VECTORS.offerId,
      salt,
      iv,
      box,
      hostBoxPublic: host,
      deviceBoxPublic: device,
      deviceName: VECTORS.deviceName,
    });
    assert.equal(hex(message), VECTORS.M);
    assert.equal(hex(pairProofOf(seed, message)), VECTORS.proof);
    assert.equal(hex(hostProofOf(seed, message, VECTORS.deviceId)), VECTORS.hostProof);
    assert.equal(verifyPairProof(fromHex(VECTORS.proof), seed, message), true);
  });

  test("握手与信道：DH → Kh → hello 帧 / 握手应答；DH → K → 数据帧", () => {
    const nonce = fromHex(VECTORS.nonce);
    const pn = fromHex(VECTORS.pn);
    // 手机侧拿电脑的公钥算，电脑侧拿手机的公钥算，同一个 DH
    const fromDevice = sharedSecret(boxPrivateKeyFromRaw(fromHex(VECTORS.devicePrivate)), host);
    const fromHost = sharedSecret(boxPrivateKeyFromRaw(fromHex(VECTORS.hostPrivate)), device);
    assert.equal(hex(fromDevice), VECTORS.dh);
    assert.equal(hex(fromHost), VECTORS.dh);

    const kh = helloKey(fromHost, nonce);
    assert.equal(hex(kh), VECTORS.helloKey);
    const key = channelKey(fromDevice, nonce, pn, VECTORS.deviceId);
    assert.equal(hex(key), VECTORS.channelKey);

    assert.equal(JSON.stringify({ pn: pn.toString("base64"), name: VECTORS.deviceName }), VECTORS.helloBody);
    const hello = sealFrame(kh, "deviceToHost", 1, VECTORS.deviceId, VECTORS.helloBody);
    assert.equal(hello.n, 1);
    assert.equal(hello.ct, VECTORS.helloFrame);
    assert.equal(
      sealFrame(kh, "hostToDevice", 1, VECTORS.deviceId, VECTORS.handshakeReplyBody).ct,
      VECTORS.handshakeReply,
    );
    assert.equal(sealFrame(key, "deviceToHost", 1, VECTORS.deviceId, VECTORS.pingBody).ct, VECTORS.ping);
    assert.equal(sealFrame(key, "deviceToHost", 2, VECTORS.deviceId, VECTORS.listBody).ct, VECTORS.list);
    assert.equal(sealFrame(key, "hostToDevice", 1, VECTORS.deviceId, VECTORS.pongBody).ct, VECTORS.pong);

    // 反方向：拿向量里的密文能解回原文
    assert.equal(openFrame(kh, "deviceToHost", 1, VECTORS.deviceId, Buffer.from(VECTORS.helloFrame, "base64")), VECTORS.helloBody);
    assert.equal(openFrame(key, "deviceToHost", 2, VECTORS.deviceId, Buffer.from(VECTORS.list, "base64")), VECTORS.listBody);
    assert.equal(openFrame(key, "hostToDevice", 1, VECTORS.deviceId, Buffer.from(VECTORS.pong, "base64")), VECTORS.pongBody);
  });
});

describe("解密的硬规矩", () => {
  const { privateKey } = boxKeyPairFromRaw(fromHex(VECTORS.devicePrivate));
  const peer = generateBoxKeyPair().publicRaw;
  const dh = sharedSecret(privateKey, peer);
  const nonce = Buffer.alloc(32, 1);
  const key = channelKey(dh, nonce, Buffer.alloc(32, 2), VECTORS.deviceId);
  const aad = VECTORS.deviceId;

  test("改一个字节的密文解不开；tag 不是 16 字节解不开；密文比一个 tag 还短解不开", () => {
    const sealed = Buffer.from(sealFrame(key, "deviceToHost", 1, aad, "机密").ct, "base64");
    assert.equal(openFrame(key, "deviceToHost", 1, aad, sealed), "机密");
    const flipped = Buffer.from(sealed);
    flipped[0] = (flipped[0] ?? 0) ^ 0x01;
    assert.equal(openFrame(key, "deviceToHost", 1, aad, flipped), null);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x80;
    assert.equal(openFrame(key, "deviceToHost", 1, aad, flipped), null);
    // 只认 16 字节的 tag：把 tag 截成 12 字节，前面补一个字节让总长不变也没用
    const shortTag = Buffer.concat([sealed.subarray(0, sealed.length - 16), sealed.subarray(sealed.length - 12)]);
    assert.equal(shortTag.length, sealed.length - 4);
    assert.equal(openFrame(key, "deviceToHost", 1, aad, shortTag), null);
    assert.equal(openFrame(key, "deviceToHost", 1, aad, sealed.subarray(0, 15)), null);
    // 空明文的帧正好只有一个 tag，是合法的，不能被「太短」误拒
    const empty = Buffer.from(sealFrame(key, "deviceToHost", 2, aad, "").ct, "base64");
    assert.equal(empty.length, MOBILE_CRYPTO.tagBytes);
    assert.equal(openFrame(key, "deviceToHost", 2, aad, empty), "");
  });

  test("认证没过时拿不到任何原文（update() 吐出来的那份不认）", () => {
    const sealed = Buffer.from(sealFrame(key, "deviceToHost", 7, aad, "一句很长很长的话，update 一定会先吐出前半段").ct, "base64");
    // 换一把钥匙：前半段的密文字节照样能「解」出乱码，但 tag 过不了——必须回 null
    const other = channelKey(sharedSecret(privateKey, generateBoxKeyPair().publicRaw), nonce, Buffer.alloc(32, 2), aad);
    assert.equal(openFrame(other, "deviceToHost", 7, aad, sealed), null);
  });

  test("seq、方向、AAD 任何一样不对都解不开", () => {
    const sealed = Buffer.from(sealFrame(key, "deviceToHost", 5, aad, "x").ct, "base64");
    assert.equal(openFrame(key, "deviceToHost", 4, aad, sealed), null);
    assert.equal(openFrame(key, "deviceToHost", 6, aad, sealed), null);
    assert.equal(openFrame(key, "hostToDevice", 5, aad, sealed), null);
    assert.equal(openFrame(key, "deviceToHost", 5, `${aad}x`, sealed), null);
    assert.equal(openFrame(key, "deviceToHost", 5, "0".repeat(32), sealed), null);
  });

  test("seq 不是正整数、或超出安全整数：密封时直接抛", () => {
    for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => sealFrame(key, "deviceToHost", bad, aad, "x"), /sequence out of range/);
    }
    assert.doesNotThrow(() => sealFrame(key, "deviceToHost", Number.MAX_SAFE_INTEGER, aad, "x"));
  });

  test("低阶点公钥：协商直接抛 InvalidPeerKeyError，不给出共享秘密", () => {
    // 全零是确定的低阶点。全 0xff 与全 1 在这台 Node 上都能正常派生，不能当成低阶点测试数据。
    assert.throws(() => sharedSecret(privateKey, Buffer.alloc(32)), InvalidPeerKeyError);
    // 长度不对：共享秘密这条口一律当「认不出」；直接构造公钥时则报长度
    assert.throws(() => sharedSecret(privateKey, Buffer.alloc(31)), InvalidPeerKeyError);
    assert.throws(() => boxPublicKeyFromRaw(Buffer.alloc(31)), /32 bytes/);
    assert.throws(() => boxPrivateKeyFromRaw(Buffer.alloc(33)), /32 bytes/);
    assert.throws(() => boxKeyPairFromRaw(Buffer.alloc(0)), /32 bytes/);
  });

  test("常数时间比对：长度不同算不等、不抛", () => {
    const a = pairProofOf(fromHex(VECTORS.seed), fromHex(VECTORS.M));
    assert.equal(verifyPairProof(a, fromHex(VECTORS.seed), fromHex(VECTORS.M)), true);
    assert.equal(verifyPairProof(a.subarray(0, 31), fromHex(VECTORS.seed), fromHex(VECTORS.M)), false);
    assert.equal(verifyPairProof(Buffer.concat([a, Buffer.from([0])]), fromHex(VECTORS.seed), fromHex(VECTORS.M)), false);
    // 种子不对（配对码猜错了）验不过
    const wrongSeed = Buffer.from(fromHex(VECTORS.seed));
    wrongSeed[31] = (wrongSeed[31] ?? 0) ^ 0x01;
    assert.equal(verifyPairProof(a, wrongSeed, fromHex(VECTORS.M)), false);
  });
});

describe("每条连接一把钥匙：录下来的帧换一条连接就作废", () => {
  const host = boxKeyPairFromRaw(fromHex(VECTORS.hostPrivate));
  const device = boxKeyPairFromRaw(fromHex(VECTORS.devicePrivate));
  const dh = sharedSecret(device.privateKey, host.publicRaw);
  const aad = VECTORS.deviceId;

  test("两条连接的 Kh、K 都不同（新鲜数不同）；旧连接录下的帧在新连接解不开", () => {
    const first = { nonce: bytes(32, 0x33), pn: bytes(32, 0x44) };
    const second = { nonce: bytes(32, 0x55), pn: bytes(32, 0x66) };
    const kh1 = helloKey(dh, first.nonce);
    const kh2 = helloKey(dh, second.nonce);
    const k1 = channelKey(dh, first.nonce, first.pn, aad);
    const k2 = channelKey(dh, second.nonce, second.pn, aad);
    assert.notEqual(hex(kh1), hex(kh2));
    assert.notEqual(hex(k1), hex(k2));
    // 重放旧连接的 hello、旧的数据帧：新连接的钥匙解不开
    assert.equal(openFrame(kh2, "deviceToHost", 1, aad, Buffer.from(VECTORS.helloFrame, "base64")), null);
    assert.equal(openFrame(k2, "deviceToHost", 1, aad, Buffer.from(VECTORS.ping, "base64")), null);
    // 同一条连接里换个 pn 也不同
    assert.notEqual(hex(channelKey(dh, first.nonce, second.pn, aad)), hex(k1));
    // 设备 id 进了盐：同一对新鲜数、另一台设备的 id 算不出这把钥匙
    assert.notEqual(hex(channelKey(dh, first.nonce, first.pn, "0".repeat(32))), hex(k1));
  });

  test("握手钥匙与信道钥匙互不通用；两个方向的 IV 不同", () => {
    const nonce = fromHex(VECTORS.nonce);
    const pn = fromHex(VECTORS.pn);
    const kh = helloKey(dh, nonce);
    const key = channelKey(dh, nonce, pn, aad);
    const hello = Buffer.from(VECTORS.helloFrame, "base64");
    const ping = Buffer.from(VECTORS.ping, "base64");
    assert.equal(openFrame(key, "deviceToHost", 1, aad, hello), null);
    assert.equal(openFrame(kh, "deviceToHost", 1, aad, ping), null);
    // 同一把钥匙、同一个 seq，方向不同：电脑方向发的帧拿手机方向解不开
    const toDevice = Buffer.from(sealFrame(key, "hostToDevice", 3, aad, "给手机的").ct, "base64");
    assert.equal(openFrame(key, "deviceToHost", 3, aad, toDevice), null);
    assert.equal(openFrame(key, "hostToDevice", 3, aad, toDevice), "给手机的");
  });
});

describe("配对提议的生成", () => {
  /** 轻量派生：测试用例不必每个都付 scrypt 的 128 MiB */
  const lite = { now: () => 1_700_000_000_000, derivePinKey: (code: Buffer, salt: Buffer) => Promise.resolve(createHash("sha256").update(code).update(salt).digest()) };

  test("6 位数字、首位不为 0；发给手机的形状齐；种子留在电脑这头", async () => {
    const hostPublic = fromHex(VECTORS.hostPublic);
    const offer = await createPairingOffer(hostPublic, lite);
    assert.match(offer.code, /^[1-9]\d{5}$/);
    assert.match(offer.offerId, MOBILE_CRYPTO.offerIdPattern);
    assert.equal(offer.expiresAt, lite.now() + MOBILE_CRYPTO.offerTtlMs);
    assert.equal(offer.seed.length, 32);
    assert.deepEqual(Object.keys(offer.wire), ["offerId", "expiresAt", "kdf", "salt", "iv", "box", "hostBoxPublic"]);
    assert.deepEqual(offer.wire.kdf, { name: "scrypt", N: 131072, r: 8, p: 1 });
    assert.equal(offer.wire.hostBoxPublic, hostPublic.toString("base64"));
    assert.equal(offer.wire.offerId, offer.offerId);
    assert.equal(offer.wire.expiresAt, offer.expiresAt);
    // 手机能用配对码解开
    const seed = await openPairingBox(Buffer.from(offer.wire.box, "base64"), Buffer.from(offer.wire.salt, "base64"), Buffer.from(offer.wire.iv, "base64"), offer.code, lite.derivePinKey);
    assert.equal(hex(seed ?? Buffer.alloc(0)), hex(offer.seed));
    assert.equal(await openPairingBox(Buffer.from(offer.wire.box, "base64"), Buffer.from(offer.wire.salt, "base64"), Buffer.from(offer.wire.iv, "base64"), "000000", lite.derivePinKey), null);
  });

  test("每次的种子、盐、IV、配对码都是新的", async () => {
    const offers = await Promise.all([createPairingOffer(Buffer.alloc(32, 9), lite), createPairingOffer(Buffer.alloc(32, 9), lite)]);
    assert.notEqual(hex(offers[0]?.seed ?? Buffer.alloc(0)), hex(offers[1]?.seed ?? Buffer.alloc(0)));
    assert.notEqual(offers[0]?.wire.salt, offers[1]?.wire.salt);
    assert.notEqual(offers[0]?.wire.iv, offers[1]?.wire.iv);
    assert.notEqual(offers[0]?.offerId, offers[1]?.offerId);
  });
});
