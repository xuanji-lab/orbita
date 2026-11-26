import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOBILE_CRYPTO } from "../../../src/shared/mobile.ts";
import { fromBase64, fromHex, toBase64, toHex, utf8 } from "./bytes.ts";
import {
  acceptKdf,
  boxPublicOf,
  channelKey,
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
  sealFrame,
  sharedSecret,
  verifyHostProof,
} from "./primitives.ts";

/**
 * 电脑侧 `src/main/mobile/crypto.test.ts` 的 `VECTORS`，一字不改抄过来（下面第一个测试逐项核对
 * 这些串在那份文件里原样存在，电脑侧改了向量这里立刻红）。
 */
const VECTORS = {
  hostPrivate: "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
  hostPublic: "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a",
  devicePrivate: "5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb",
  devicePublic: "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f",
  code: "246813",
  salt: "1112131415161718191a1b1c1d1e1f20",
  iv: "22232425262728292a2b2c2d",
  seed: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  keyPin: "2e8a15079d813694a0512abe491acacab70c13f911fa6480b66f1f771ba698bf",
  box: "ece9b0909141525deefc72b7a7d8fb0f3a707ca0e0a19470b4f0d5a7041bf79702234f736d0618c33e9dd3c436214551",
  offerId: "0123456789abcdef0123456789abcdef",
  deviceId: "fedcba9876543210fedcba9876543210",
  deviceName: "wafo 的 Pixel",
  M: "6f72626974612d706169722d763130313233343536373839616263646566303132333435363738396162636465661112131415161718191a1b1c1d1e1f2022232425262728292a2b2c2dece9b0909141525deefc72b7a7d8fb0f3a707ca0e0a19470b4f0d5a7041bf79702234f736d0618c33e9dd3c4362145518520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6ade9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f7761666f20e79a8420506978656c",
  proof: "920030ae7aad22bece5be343b268b509be3c557de36c704748fae913399234ca",
  hostProof: "3095a454ba8408ae9350712c685a16e0efa082a703b535353f6c65e358e82e41",
  dh: "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
  nonce: "333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152",
  pn: "4445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60616263",
  helloKey: "e418e76918fb0f7dafe466100c9a9a9b5a60c04704881ba00a866bae8340d612",
  channelKey: "829c3f3dc4c0665a27e64661f0c81c0f1603324c593669565b6622543fcd6fd7",
  helloBody: '{"pn":"REVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmM=","name":"wafo 的 Pixel"}',
  helloFrame: "Iz2qU7Qiif04EkrMdfUS2hqC55GtE7VBy6Pqt1dYTHS6KQXhnBloA3ZIT8EjnqUzeXsMYU8NrD2IP89jtNgIWAk4uHUNggbJjsVfLPey6tKU3W6XlfS2rWYfUrl/",
  handshakeReplyBody: '{"id":1,"ok":true,"result":{"host":{"name":"wafo 的 MacBook","protocol":1},"protocol":1}}',
  handshakeReply:
    "n88KCDtTjhxZqwfFKU/7HKVfbAVyl1gZxb/thjmzJQUQmetftu6OQj+4mXyrzGvMasVFwKSuSrckI68oCroEEzBnWBD4X3lV0QoOqtfq0g4Oz7qVyd7/AT/gGg7xEBIM6c/n3/gdro0Svg==",
  pingBody: '{"id":1,"method":"ping"}',
  ping: "05+F0Iho5AaqujS4mQU/L3lLHCkJ3QFTzSdqeYfQ85kOPBBDcmDipA==",
  pongBody: '{"id":1,"ok":true,"result":{"now":1700000000000}}',
  pong: "iR6oRy0XV2pP1qMpOSjNs6PZKAEaYugYqo4nteSKkkMNGKFT7JVpe2TFEBNxyAy7iBJWuR8C1/30zTUnfPWZbxg=",
  listBody: '{"id":2,"method":"sessions.list"}',
  list: "gttASOb/oqgqM72SyHXYEmkDI2VUFfeCJcDoEAoqIVuTyYotc7nxW5wcWF7BpvTndQ==",
} as const;

const b64 = (text: string): Uint8Array => {
  const bytes = fromBase64(text);
  assert.ok(bytes, `not canonical base64: ${text}`);
  return bytes;
};

test("向量没有抄走样：每一项在电脑侧的测试文件里原样存在", () => {
  const desktop = readFileSync(join(import.meta.dirname, "../../../src/main/mobile/crypto.test.ts"), "utf8");
  for (const [name, value] of Object.entries(VECTORS)) {
    // 电脑侧文件里 JSON 串写在单引号里，原样出现即可
    assert.ok(desktop.includes(value), `VECTORS.${name} 和电脑侧对不上`);
  }
  // 一项不落：电脑侧 VECTORS 的键与这里的键完全相同
  const block = desktop.slice(desktop.indexOf("const VECTORS = {"), desktop.indexOf("} as const;"));
  const desktopKeys = [...block.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);
  assert.deepEqual(desktopKeys, Object.keys(VECTORS));
});

describe("已知答案：noble 的封装没写错", () => {
  test("X25519：RFC 7748 §6.1——私钥推公钥、两边的共享秘密相同", () => {
    assert.equal(toHex(boxPublicOf(fromHex(VECTORS.hostPrivate))), VECTORS.hostPublic);
    assert.equal(toHex(boxPublicOf(fromHex(VECTORS.devicePrivate))), VECTORS.devicePublic);
    assert.equal(toHex(sharedSecret(fromHex(VECTORS.devicePrivate), fromHex(VECTORS.hostPublic)) ?? new Uint8Array()), VECTORS.dh);
    assert.equal(toHex(sharedSecret(fromHex(VECTORS.hostPrivate), fromHex(VECTORS.devicePublic)) ?? new Uint8Array()), VECTORS.dh);
  });

  test("HKDF-SHA256：RFC 5869 Test Case 1；空盐与 32 个零字节的盐同值", () => {
    const okm = hkdfSha256(new Uint8Array(22).fill(0x0b), fromHex("000102030405060708090a0b0c"), fromHex("f0f1f2f3f4f5f6f7f8f9"), 42);
    assert.equal(toHex(okm), "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
    const ikm = fromHex(VECTORS.seed);
    assert.equal(toHex(hkdfSha256(ikm, new Uint8Array(0), utf8("x"))), toHex(hkdfSha256(ikm, new Uint8Array(32), utf8("x"))));
  });

  test("HMAC-SHA256：RFC 4231 Test Case 2（分段喂与一次喂一样）", () => {
    const expected = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";
    assert.equal(toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want for nothing?"))), expected);
    assert.equal(toHex(hmacSha256(utf8("Jefe"), utf8("what do ya want "), utf8("for nothing?"))), expected);
  });

  test("scrypt N=2^17 r=8 p=1（真参数）：配对码 → keyPin → box 解出种子；码不对解不开", async () => {
    const progress: number[] = [];
    const keyPin = await derivePinKey(VECTORS.code, fromHex(VECTORS.salt), (fraction) => progress.push(fraction));
    assert.equal(toHex(keyPin), VECTORS.keyPin);
    assert.ok(progress.length > 0 && (progress.at(-1) ?? 0) >= 0.99);
    assert.equal(toHex(openPairingBox(fromHex(VECTORS.box), fromHex(VECTORS.iv), keyPin) ?? new Uint8Array()), VECTORS.seed);
    const wrong = await derivePinKey("000000", fromHex(VECTORS.salt));
    assert.equal(openPairingBox(fromHex(VECTORS.box), fromHex(VECTORS.iv), wrong), null);
  });
});

describe("定值向量：整条流程逐字节（与电脑侧对拍）", () => {
  const host = fromHex(VECTORS.hostPublic);
  const device = fromHex(VECTORS.devicePublic);
  const salt = fromHex(VECTORS.salt);
  const iv = fromHex(VECTORS.iv);
  const box = fromHex(VECTORS.box);
  const seed = fromHex(VECTORS.seed);
  const message = pairMessage({
    offerId: VECTORS.offerId,
    salt,
    iv,
    box,
    hostBoxPublic: host,
    deviceBoxPublic: device,
    deviceName: VECTORS.deviceName,
  });

  test("配对：M → proof → hostProof，且 hostProof 验得过、改一位验不过", () => {
    assert.equal(toHex(message), VECTORS.M);
    assert.equal(toHex(pairProofOf(seed, message)), VECTORS.proof);
    assert.equal(toHex(hostProofOf(seed, message, VECTORS.deviceId)), VECTORS.hostProof);
    const hostProofB64 = toBase64(fromHex(VECTORS.hostProof));
    assert.equal(verifyHostProof(hostProofB64, seed, message, VECTORS.deviceId), true);
    const flipped = fromHex(VECTORS.hostProof);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    assert.equal(verifyHostProof(toBase64(flipped), seed, message, VECTORS.deviceId), false);
    assert.equal(verifyHostProof(hostProofB64, seed, message, "0".repeat(32)), false);
    assert.equal(verifyHostProof(toBase64(fromHex(VECTORS.hostProof).subarray(0, 31)), seed, message, VECTORS.deviceId), false);
    assert.equal(verifyHostProof("not base64", seed, message, VECTORS.deviceId), false);
  });

  test("握手与信道：DH → Kh → hello 帧 / 握手应答；DH → K → 数据帧（逐字节）", () => {
    const nonce = fromHex(VECTORS.nonce);
    const pn = fromHex(VECTORS.pn);
    const dh = sharedSecret(fromHex(VECTORS.devicePrivate), host);
    assert.ok(dh);
    const kh = helloKey(dh, nonce);
    assert.equal(toHex(kh), VECTORS.helloKey);
    const key = channelKey(dh, nonce, pn, VECTORS.deviceId);
    assert.equal(toHex(key), VECTORS.channelKey);
    assert.equal(JSON.stringify({ pn: toBase64(pn), name: VECTORS.deviceName }), VECTORS.helloBody);
    assert.equal(toBase64(sealFrame(kh, "deviceToHost", 1, VECTORS.deviceId, VECTORS.helloBody)), VECTORS.helloFrame);
    assert.equal(toBase64(sealFrame(kh, "hostToDevice", 1, VECTORS.deviceId, VECTORS.handshakeReplyBody)), VECTORS.handshakeReply);
    assert.equal(toBase64(sealFrame(key, "deviceToHost", 1, VECTORS.deviceId, VECTORS.pingBody)), VECTORS.ping);
    assert.equal(toBase64(sealFrame(key, "deviceToHost", 2, VECTORS.deviceId, VECTORS.listBody)), VECTORS.list);
    assert.equal(toBase64(sealFrame(key, "hostToDevice", 1, VECTORS.deviceId, VECTORS.pongBody)), VECTORS.pong);
    // 反方向：电脑密封的帧手机解得开
    assert.equal(openFrame(kh, "hostToDevice", 1, VECTORS.deviceId, b64(VECTORS.handshakeReply)), VECTORS.handshakeReplyBody);
    assert.equal(openFrame(key, "hostToDevice", 1, VECTORS.deviceId, b64(VECTORS.pong)), VECTORS.pongBody);
    assert.equal(openFrame(key, "deviceToHost", 2, VECTORS.deviceId, b64(VECTORS.list)), VECTORS.listBody);
  });
});

describe("解密的硬规矩", () => {
  const dh = sharedSecret(fromHex(VECTORS.devicePrivate), generateBoxKeyPair().publicRaw);
  assert.ok(dh);
  const key = channelKey(dh, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), VECTORS.deviceId);
  const aad = VECTORS.deviceId;

  test("改一个字节解不开；tag 截短解不开；比一个 tag 还短解不开；空明文合法", () => {
    const sealed = sealFrame(key, "hostToDevice", 1, aad, "机密");
    assert.equal(openFrame(key, "hostToDevice", 1, aad, sealed), "机密");
    const flipped = Uint8Array.from(sealed);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    assert.equal(openFrame(key, "hostToDevice", 1, aad, flipped), null);
    const shortTag = Uint8Array.from([...sealed.subarray(0, sealed.length - 16), ...sealed.subarray(sealed.length - 12)]);
    assert.equal(openFrame(key, "hostToDevice", 1, aad, shortTag), null);
    assert.equal(openFrame(key, "hostToDevice", 1, aad, sealed.subarray(0, 15)), null);
    const empty = sealFrame(key, "hostToDevice", 2, aad, "");
    assert.equal(empty.length, MOBILE_CRYPTO.tagBytes);
    assert.equal(openFrame(key, "hostToDevice", 2, aad, empty), "");
  });

  test("seq、方向、AAD 任何一样不对都解不开；seq 越界密封时抛", () => {
    const sealed = sealFrame(key, "hostToDevice", 5, aad, "x");
    assert.equal(openFrame(key, "hostToDevice", 4, aad, sealed), null);
    assert.equal(openFrame(key, "hostToDevice", 6, aad, sealed), null);
    assert.equal(openFrame(key, "deviceToHost", 5, aad, sealed), null);
    assert.equal(openFrame(key, "hostToDevice", 5, `${aad}x`, sealed), null);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => sealFrame(key, "deviceToHost", bad, aad, "x"), /sequence out of range/);
    }
    // 最大安全整数的 IV 与电脑侧同一个写法（8 字节大端）
    assert.doesNotThrow(() => sealFrame(key, "deviceToHost", Number.MAX_SAFE_INTEGER, aad, "x"));
  });

  test("低阶点 / 长度不对的公钥：不给共享秘密", () => {
    const mine = fromHex(VECTORS.devicePrivate);
    assert.equal(sharedSecret(mine, new Uint8Array(32)), null);
    assert.equal(sharedSecret(mine, new Uint8Array(31)), null);
    assert.equal(sharedSecret(new Uint8Array(33), fromHex(VECTORS.hostPublic)), null);
  });

  test("kdf 参数只认契约那一组；box 长度、IV 长度不对直接不解", () => {
    assert.equal(acceptKdf({ name: "scrypt", N: 131072, r: 8, p: 1 }), true);
    assert.equal(acceptKdf({ name: "scrypt", N: 1024, r: 8, p: 1 }), false);
    assert.equal(acceptKdf({ name: "scrypt", N: 131072, r: 1, p: 1 }), false);
    const keyPin = fromHex(VECTORS.keyPin);
    assert.equal(openPairingBox(fromHex(VECTORS.box).subarray(1), fromHex(VECTORS.iv), keyPin), null);
    assert.equal(openPairingBox(fromHex(VECTORS.box), fromHex(VECTORS.iv).subarray(1), keyPin), null);
  });

  test("自己生成的密钥对：每次不同、公钥由私钥推得", () => {
    const a = generateBoxKeyPair();
    const b = generateBoxKeyPair();
    assert.notEqual(toHex(a.privateRaw), toHex(b.privateRaw));
    assert.equal(toHex(boxPublicOf(a.privateRaw)), toHex(a.publicRaw));
  });
});
