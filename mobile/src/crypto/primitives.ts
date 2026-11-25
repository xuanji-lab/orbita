/**
 * 手机侧的配对与信道原语——`@noble/*`（2.4.0，纯 JS）实现 `MOBILE_CRYPTO` 那一套：
 * X25519、HKDF-SHA256、HMAC-SHA256、scrypt、AES-256-GCM。
 *
 * 对拍对象是电脑侧的 `src/main/mobile/crypto.ts`（`node:crypto`）；`primitives.test.ts` 逐字节复现
 * 电脑侧 `crypto.test.ts` 里的定值向量。两端的硬规矩照抄：
 * - GCM 的 tag 只认 16 字节、IV 只认 12 字节；长度在解密之前自己判。
 * - 认证没过就没有原文：noble 的 `decrypt` 在 tag 不对时抛错、不吐半截明文；接住、回 null。
 * - 对端公钥是低阶点 / 共享秘密全零：当成「认不出」（回 null），不给出共享秘密。
 * - 比对证明用常数时间。
 * - 取号与密封同步完成（`sealFrame` 是同步函数），调用方拿到就发，中间不 await。
 *
 * 纯模块：不 import react-native，`node --test` 直接加载。
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import type { PairStartResult } from "../../../src/shared/mobile.ts";
import { MOBILE_CRYPTO } from "../../../src/shared/mobile.ts";
import { concatBytes, fromBase64, fromUtf8, secretEqual, utf8 } from "./bytes.ts";

const EMPTY = new Uint8Array(0);

// ————————————————————————————————————————————————————————————————
// X25519
// ————————————————————————————————————————————————————————————————

export interface BoxKeyPair {
  /** 32 字节 */
  privateRaw: Uint8Array;
  /** 32 字节 */
  publicRaw: Uint8Array;
}

/** 手机配对时自己生成的长期密钥对（安全随机数；不从配对种子派生） */
export function generateBoxKeyPair(): BoxKeyPair {
  const privateRaw = x25519.utils.randomSecretKey();
  return { privateRaw, publicRaw: x25519.getPublicKey(privateRaw) };
}

export function boxPublicOf(privateRaw: Uint8Array): Uint8Array {
  if (privateRaw.length !== MOBILE_CRYPTO.keyBytes) throw new Error("X25519 private key must be 32 bytes");
  return x25519.getPublicKey(privateRaw);
}

/**
 * X25519 共享秘密（原始 32 字节，直接进 HKDF）。对端公钥长度不对、是低阶点、算出全零：回 null。
 * noble 对全零输出本身会抛；这里接住统一成 null，调用方当成「认不出」。
 */
export function sharedSecret(privateRaw: Uint8Array, peerPublicRaw: Uint8Array): Uint8Array | null {
  if (privateRaw.length !== MOBILE_CRYPTO.keyBytes || peerPublicRaw.length !== MOBILE_CRYPTO.keyBytes) return null;
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateRaw, peerPublicRaw);
  } catch {
    return null;
  }
  if (shared.length !== MOBILE_CRYPTO.keyBytes || shared.every((byte) => byte === 0)) return null;
  return shared;
}

// ————————————————————————————————————————————————————————————————
// HKDF / HMAC / 随机数
// ————————————————————————————————————————————————————————————————

/** HKDF-SHA256。「盐空」传长度为 0 的数组——HMAC 把空钥与 32 个零字节都补成同一块，等同 RFC 5869 的空盐 */
export function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = 32): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

export function hmacSha256(key: Uint8Array, ...parts: readonly Uint8Array[]): Uint8Array {
  const mac = hmac.create(sha256, key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

export function secureRandom(length: number): Uint8Array {
  return randomBytes(length);
}

// ————————————————————————————————————————————————————————————————
// AES-256-GCM 帧
// ————————————————————————————————————————————————————————————————

export type Direction = "deviceToHost" | "hostToDevice";

const DIRECTION_PREFIX: Readonly<Record<Direction, Uint8Array>> = {
  deviceToHost: utf8(MOBILE_CRYPTO.ivDeviceToHost),
  hostToDevice: utf8(MOBILE_CRYPTO.ivHostToDevice),
};

/** 加密帧的 IV：4 字节方向前缀 ‖ 8 字节大端 seq（seq 是 1 起的安全整数） */
export function frameIv(direction: Direction, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`frame sequence out of range: ${String(seq)}`);
  const seqBytes = new Uint8Array(8);
  let rest = seq;
  for (let i = 7; i >= 0; i -= 1) {
    seqBytes[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return concatBytes(DIRECTION_PREFIX[direction], seqBytes);
}

/** 密封一帧：AES-256-GCM(K, IV = 方向 ‖ seq, AAD = utf8(deviceId))，回 密文 ‖ 16 字节 tag */
export function sealFrame(key: Uint8Array, direction: Direction, seq: number, aad: string, plaintext: string): Uint8Array {
  return gcm(key, frameIv(direction, seq), utf8(aad)).encrypt(utf8(plaintext));
}

/**
 * 开启一帧：密文比一个 tag 还短、认证没过、解出来不是合法 UTF-8，一律回 null。
 * 正好一个 tag 是合法的空明文。
 */
export function openFrame(key: Uint8Array, direction: Direction, seq: number, aad: string, ct: Uint8Array): string | null {
  if (ct.length < MOBILE_CRYPTO.tagBytes) return null;
  let plain: Uint8Array;
  try {
    plain = gcm(key, frameIv(direction, seq), utf8(aad)).decrypt(ct);
  } catch {
    return null;
  }
  return fromUtf8(plain);
}

// ————————————————————————————————————————————————————————————————
// 配对
// ————————————————————————————————————————————————————————————————

/** scrypt 的内存上限：`128 · N · r · p` = 128 MiB，留一点余量 */
const SCRYPT_MAXMEM = 129 * 1024 * 1024;

/**
 * `keyPin = scrypt(utf8(code), salt, N, r, p, 32 字节)`。异步分片跑（`asyncTick`），不把界面卡死；
 * `onProgress` 给 0–1 的进度。参数只接受契约写死的 `N = 2^17, r = 8, p = 1`——电脑说别的就不算
 * （调用方先用 `acceptKdf` 判）。
 */
export function derivePinKey(code: string, salt: Uint8Array, onProgress?: (fraction: number) => void): Promise<Uint8Array> {
  const kdf = MOBILE_CRYPTO.kdf;
  return scryptAsync(utf8(code), salt, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    dkLen: 32,
    maxmem: SCRYPT_MAXMEM,
    asyncTick: 16,
    ...(onProgress === undefined ? {} : { onProgress }),
  });
}

/** 电脑发来的 kdf 参数是不是契约那一组（别的一律不认：参数由对面定就等于让对面降低猜码成本） */
export function acceptKdf(kdf: PairStartResult["kdf"]): boolean {
  const want = MOBILE_CRYPTO.kdf;
  return kdf.name === want.name && kdf.N === want.N && kdf.r === want.r && kdf.p === want.p;
}

/** 用 keyPin 解开 `box` 得到种子 S；配对码不对（认证过不了）回 null——此时不要发 `pair.prove` */
export function openPairingBox(box: Uint8Array, iv: Uint8Array, keyPin: Uint8Array): Uint8Array | null {
  if (iv.length !== MOBILE_CRYPTO.ivBytes) return null;
  if (box.length !== MOBILE_CRYPTO.seedBytes + MOBILE_CRYPTO.tagBytes) return null;
  try {
    return gcm(keyPin, iv).decrypt(box);
  } catch {
    return null;
  }
}

/** 配对时双方算的消息 M（定长字段在前、名字在最后） */
export function pairMessage(input: {
  offerId: string;
  salt: Uint8Array;
  iv: Uint8Array;
  box: Uint8Array;
  hostBoxPublic: Uint8Array;
  deviceBoxPublic: Uint8Array;
  deviceName: string;
}): Uint8Array {
  return concatBytes(
    utf8(MOBILE_CRYPTO.pairProofLabel),
    utf8(input.offerId),
    input.salt,
    input.iv,
    input.box,
    input.hostBoxPublic,
    input.deviceBoxPublic,
    utf8(input.deviceName),
  );
}

/** 手机的证明：`HMAC-SHA256(Kp, M)`，`Kp = HKDF(S, 盐空, "orbita-pair-proof")` */
export function pairProofOf(seed: Uint8Array, message: Uint8Array): Uint8Array {
  return hmacSha256(hkdfSha256(seed, EMPTY, utf8(MOBILE_CRYPTO.pairProofInfo)), message);
}

/** 电脑的确认：`HMAC-SHA256(Kc, M ‖ utf8(deviceId))`，`Kc = HKDF(S, 盐空, "orbita-pair-confirm")` */
export function hostProofOf(seed: Uint8Array, message: Uint8Array, deviceId: string): Uint8Array {
  return hmacSha256(hkdfSha256(seed, EMPTY, utf8(MOBILE_CRYPTO.pairConfirmInfo)), message, utf8(deviceId));
}

/** 验电脑回的 hostProof（常数时间）。验不过 = 对面不是拿着同一个种子的那台电脑 */
export function verifyHostProof(hostProofB64: string, seed: Uint8Array, message: Uint8Array, deviceId: string): boolean {
  const got = fromBase64(hostProofB64);
  if (got === null || got.length !== 32) return false;
  return secretEqual(got, hostProofOf(seed, message, deviceId));
}

// ————————————————————————————————————————————————————————————————
// 握手与信道
// ————————————————————————————————————————————————————————————————

/** 握手密钥 `Kh = HKDF-SHA256(ikm = DH, 盐 = nonce, info = "orbita-hello-v1", 32)` */
export function helloKey(shared: Uint8Array, nonce: Uint8Array): Uint8Array {
  return hkdfSha256(shared, nonce, utf8(MOBILE_CRYPTO.helloInfo));
}

/** 信道密钥 `K = HKDF-SHA256(ikm = DH, 盐 = nonce ‖ pn ‖ utf8(deviceId), info = "orbita-channel-v1", 32)` */
export function channelKey(shared: Uint8Array, nonce: Uint8Array, pn: Uint8Array, deviceId: string): Uint8Array {
  return hkdfSha256(shared, concatBytes(nonce, pn, utf8(deviceId)), utf8(MOBILE_CRYPTO.channelInfo));
}
