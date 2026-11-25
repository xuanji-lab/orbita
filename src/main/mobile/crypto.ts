/**
 * 手机配对与加密信道的原语——只用 Node 自带的 `node:crypto`（X25519、HKDF-SHA256、HMAC-SHA256、
 * scrypt、AES-256-GCM），电脑侧不新增加密依赖。约定在 `src/shared/mobile.ts` 的 `MOBILE_CRYPTO`，
 * 安卓端用 `@noble/*` 实现同一套；`crypto.test.ts` 里有定值向量，两端各写一遍也对得上。
 *
 * 2026-11-25 安全审查立下的硬规矩（每一条都踩过）：
 * - GCM 的 tag 只认 16 字节：Node 对 12 字节的 tag 也放行（只打一条弃用警告）；IV 只认 12 字节，
 *   13、16 字节它也收。长度在解密之前自己判。
 * - **`final()` 没成功之前不碰 `update()` 的输出**：tag 不对时 `update()` 照样把原文吐出来，
 *   认了它就等于没有认证。「解得开」的定义是 `final()` 没抛。
 * - `diffieHellman` 遇到低阶点或非规范值的公钥会抛（好事），要接住并当成「认不出」。
 * - 比对证明用 `timingSafeEqual`；长度不同它直接抛，先判长度。
 * - scrypt 只在「用户点生成配对码」时由电脑算一次，用异步版并给 `maxmem`（默认的 32 MiB 直接抛错）；
 *   **永远不要在收到网络帧时算**。`r` 不能改成 1（Electron 自带的 Node 上任何 N 配 r=1 都抛）。
 * - 取号与发送写在同一个同步函数里：`sealFrame` 同步返回完整的一帧，调用方拿到就发，
 *   中间不许 `await`（两个并发请求会以 2、1 的顺序发出，手机按规矩直接断线）。
 *
 * 纯模块：不 import electron，可被 `node --test` 直接加载。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";
import type { PairProveFrame, PairStartResult } from "../../shared/mobile.ts";
import { MOBILE_CRYPTO } from "../../shared/mobile.ts";

/** X25519 私钥的 PKCS#8 DER 前缀：后面接 32 字节种子就是一份合法的私钥，公钥由它推出来 */
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

/** scrypt 的内存上限：`128 · N · r · p` = 128 MiB，给到 256 MiB（恰好给 128 MiB 它也抛） */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** 密钥协商失败：对端给的公钥不是合法的 X25519 点。调用方当成「认不出这台设备」 */
export class InvalidPeerKeyError extends Error {
  readonly cause: unknown;

  constructor(cause: unknown) {
    super("the peer public key is not a valid X25519 point");
    this.name = "InvalidPeerKeyError";
    this.cause = cause;
  }
}

// ————————————————————————————————————————————————————————————————
// X25519
// ————————————————————————————————————————————————————————————————

export interface BoxKeyPair {
  /** 32 字节 */
  privateRaw: Buffer;
  /** 32 字节 */
  publicRaw: Buffer;
}

/** 生成一对 X25519（主机启用时生成一次；手机配对时自己生成，不由电脑代劳） */
export function generateBoxKeyPair(): BoxKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return { privateRaw: rawPrivateOf(privateKey), publicRaw: rawPublicOf(publicKey) };
}

/** 原始 32 字节私钥 → KeyObject。电脑把主机私钥以这 32 字节的 base64 存进系统密钥库 */
export function boxPrivateKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== MOBILE_CRYPTO.keyBytes) throw new Error(`X25519 private key must be ${MOBILE_CRYPTO.keyBytes} bytes`);
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** 原始 32 字节私钥 → 一对 KeyObject 与原始公钥（主机启用时从密钥库读回私钥后用） */
export function boxKeyPairFromRaw(privateRaw: Buffer): { privateKey: KeyObject; publicRaw: Buffer } {
  const privateKey = boxPrivateKeyFromRaw(privateRaw);
  return { privateKey, publicRaw: rawPublicOf(createPublicKey(privateKey)) };
}

/** 原始 32 字节公钥 → KeyObject（设备的公钥以 base64 存在 mobile.json 里） */
export function boxPublicKeyFromRaw(raw: Buffer): KeyObject {
  if (raw.length !== MOBILE_CRYPTO.keyBytes) throw new Error(`X25519 public key must be ${MOBILE_CRYPTO.keyBytes} bytes`);
  return createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
}

/** SPKI 导出的最后 32 字节就是原始公钥（前面 12 字节是固定前缀） */
export function rawPublicOf(publicKey: KeyObject): Buffer {
  return Buffer.from(publicKey.export({ type: "spki", format: "der" }).subarray(-MOBILE_CRYPTO.keyBytes));
}

/** PKCS#8 导出的最后 32 字节就是种子 */
export function rawPrivateOf(privateKey: KeyObject): Buffer {
  return Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }).subarray(-MOBILE_CRYPTO.keyBytes));
}

/**
 * X25519 共享秘密（原始 32 字节，直接进 HKDF）。对端是低阶点或非规范值时抛 `InvalidPeerKeyError`——
 * Node 24（Electron 自带）上的错误码是 `ERR_OSSL_EVP_INVALID_PEER_KEY`，别的 Node 版本可能不同，
 * 所以**派生只要抛错就当成认不出**，不靠匹配错误码。
 */
export function sharedSecret(privateKey: KeyObject, peerPublicRaw: Buffer): Buffer {
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey: boxPublicKeyFromRaw(peerPublicRaw) });
  } catch (cause) {
    throw new InvalidPeerKeyError(cause);
  }
  if (shared.length !== MOBILE_CRYPTO.keyBytes) {
    throw new InvalidPeerKeyError(new Error(`unexpected shared secret length ${shared.length}`));
  }
  return shared;
}

// ————————————————————————————————————————————————————————————————
// HKDF / HMAC / AES-256-GCM
// ————————————————————————————————————————————————————————————————

/** HKDF-SHA256。「盐空」传一个长度为 0 的 Buffer（Node 不接受 undefined） */
export function hkdfSha256(ikm: Buffer, salt: Buffer, info: Buffer, length = 32): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/** HMAC-SHA256，32 字节 */
export function hmacSha256(key: Buffer, ...parts: readonly Buffer[]): Buffer {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
}

/** 常数时间比对：长度不同直接算不等（timingSafeEqual 对长度不同是抛错） */
export function secretEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Direction = "deviceToHost" | "hostToDevice";

const DIRECTION_PREFIX: Readonly<Record<Direction, Buffer>> = {
  deviceToHost: Buffer.from(MOBILE_CRYPTO.ivDeviceToHost, "utf8"),
  hostToDevice: Buffer.from(MOBILE_CRYPTO.ivHostToDevice, "utf8"),
};

/** 加密帧的 IV：4 字节方向前缀 ‖ 8 字节大端 seq。线上的 seq 是安全整数，最多 Number.MAX_SAFE_INTEGER */
function frameIv(direction: Direction, seq: number): Buffer {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error(`frame sequence out of range: ${String(seq)}`);
  const seqBytes = Buffer.alloc(8);
  seqBytes.writeBigUInt64BE(BigInt(seq));
  return Buffer.concat([DIRECTION_PREFIX[direction], seqBytes]);
}

export interface SealedMessage {
  n: number;
  /** base64：密文 ‖ 16 字节 tag */
  ct: string;
}

/**
 * 密封一帧：AES-256-GCM(K, IV = 方向 ‖ seq, AAD = utf8(deviceId))，输出 base64(密文 ‖ tag)。
 * **同步**：取号、密封、交给调用方一气呵成，中间没有 `await` 的余地。
 */
export function sealFrame(key: Buffer, direction: Direction, seq: number, aad: string, plaintext: string): SealedMessage {
  const iv = frameIv(direction, seq);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: MOBILE_CRYPTO.tagBytes });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  // 先攒密文，final() 成功后才把它们合起来——和解密那边保持同一个姿势
  const body = cipher.update(plaintext, "utf8");
  const tail = cipher.final();
  return { n: seq, ct: Buffer.concat([body, tail, cipher.getAuthTag()]).toString("base64") };
}

/**
 * 开启一帧。tag 不是 16 字节、密文比一个 tag 还短、认证没过，一律返回 null——
 * **`final()` 抛之前 `update()` 已经把原文吐出来了，那份东西不认**。
 */
export function openFrame(key: Buffer, direction: Direction, seq: number, aad: string, ct: Buffer): string | null {
  // 正好一个 tag 是合法的空明文；少于它才不可能是一帧
  if (ct.length < MOBILE_CRYPTO.tagBytes) return null;
  const body = ct.subarray(0, ct.length - MOBILE_CRYPTO.tagBytes);
  const tag = ct.subarray(ct.length - MOBILE_CRYPTO.tagBytes);
  let plaintext: string | null = null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, frameIv(direction, seq), { authTagLength: MOBILE_CRYPTO.tagBytes });
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    const head = decipher.update(body);
    const tail = decipher.final();
    plaintext = Buffer.concat([head, tail]).toString("utf8");
  } catch {
    return null;
  }
  return plaintext;
}

// ————————————————————————————————————————————————————————————————
// 配对提议（电脑侧）
// ————————————————————————————————————————————————————————————————

/** 电脑自己留着的那一半：种子不能发给任何人 */
export interface PairingOffer {
  offerId: string;
  /** 6 位数字 */
  code: string;
  /** Unix 毫秒 */
  expiresAt: number;
  /** 一次性种子 S */
  seed: Buffer;
  /** 发给手机的那一半（`pair.start` 的应答） */
  wire: PairStartResult;
}

export interface OfferDeps {
  now(): number;
  /**
   * 配对码 → `keyPin` 的派生。生产用 scrypt（`derivePinKey`）；测试可以换轻量版——
   * 真参数一次要 128 MiB、几百毫秒，用不着每个用例都付
   */
  derivePinKey?: (code: Buffer, salt: Buffer) => Promise<Buffer>;
}

/**
 * 生成一份配对提议：种子 S、6 位配对码（`crypto.randomInt` 铸，首位不为 0——不许用户自定，
 * 常见码会被优先猜）、盐、IV；S 用配对码派生的密钥 AES-256-GCM 包起来。
 * scrypt 要 128 MiB、几百毫秒，所以是异步的——调用方别在事件回调用同步等它。
 */
export function createPairingOffer(hostBoxPublic: Buffer, deps: OfferDeps): Promise<PairingOffer> {
  const kdf = MOBILE_CRYPTO.kdf;
  const seed = randomBytes(MOBILE_CRYPTO.seedBytes);
  const salt = randomBytes(MOBILE_CRYPTO.saltBytes);
  const iv = randomBytes(MOBILE_CRYPTO.ivBytes);
  const code = pairingCode();
  const offerId = randomBytes(16).toString("hex");
  const expiresAt = deps.now() + MOBILE_CRYPTO.offerTtlMs;
  return (deps.derivePinKey ?? derivePinKey)(Buffer.from(code, "utf8"), salt).then((keyPin) => {
    const box = sealBox(keyPin, iv, seed);
    return {
      offerId,
      code,
      expiresAt,
      seed,
      wire: {
        offerId,
        expiresAt,
        kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p },
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        box: box.toString("base64"),
        hostBoxPublic: hostBoxPublic.toString("base64"),
      },
    };
  });
}

/** 6 位配对码，取值 100000–999999 */
export function pairingCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

/** `keyPin = scrypt(utf8(code), salt, N, r, p, 32 字节)`——异步版，给足 `maxmem` */
export function derivePinKey(code: Buffer, salt: Buffer): Promise<Buffer> {
  const kdf = MOBILE_CRYPTO.kdf;
  return new Promise((resolve, reject) => {
    scrypt(code, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function sealBox(key: Buffer, iv: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: MOBILE_CRYPTO.tagBytes });
  const body = cipher.update(plaintext);
  const tail = cipher.final();
  return Buffer.concat([body, tail, cipher.getAuthTag()]);
}

/**
 * 手机侧的那一步（这里只为测试与安卓端对拍而写）：用配对码派生密钥、解开 `box`。
 * 配对码不对时 GCM 的认证过不了，返回 null——手机此时**不要**再发 `pair.prove`。
 * `derive` 与 `OfferDeps.derivePinKey` 同一个口子：测试换轻量版。
 */
export async function openPairingBox(
  box: Buffer,
  salt: Buffer,
  iv: Buffer,
  code: string,
  derive: (code: Buffer, salt: Buffer) => Promise<Buffer> = derivePinKey,
): Promise<Buffer | null> {
  const keyPin = await derive(Buffer.from(code, "utf8"), salt);
  if (box.length < MOBILE_CRYPTO.seedBytes + MOBILE_CRYPTO.tagBytes) return null;
  const body = box.subarray(0, box.length - MOBILE_CRYPTO.tagBytes);
  const tag = box.subarray(box.length - MOBILE_CRYPTO.tagBytes);
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyPin, iv, { authTagLength: MOBILE_CRYPTO.tagBytes });
    decipher.setAuthTag(tag);
    const head = decipher.update(body);
    const tail = decipher.final();
    return Buffer.concat([head, tail]);
  } catch {
    return null;
  }
}

/** 配对时双方算的消息 M（见 `MOBILE_CRYPTO.pairProofLabel` 上方的说明） */
export function pairMessage(input: {
  offerId: string;
  salt: Buffer;
  iv: Buffer;
  box: Buffer;
  /** 手机看到的电脑公钥（原样，不重新派生） */
  hostBoxPublic: Buffer;
  deviceBoxPublic: Buffer;
  deviceName: string;
}): Buffer {
  return Buffer.concat([
    Buffer.from(MOBILE_CRYPTO.pairProofLabel, "utf8"),
    Buffer.from(input.offerId, "utf8"),
    input.salt,
    input.iv,
    input.box,
    input.hostBoxPublic,
    input.deviceBoxPublic,
    Buffer.from(input.deviceName, "utf8"),
  ]);
}

/** 手机的证明：`HMAC-SHA256(Kp, M)`，`Kp = HKDF(S, 盐空, "orbita-pair-proof")` */
export function pairProofOf(seed: Buffer, message: Buffer): Buffer {
  const proofKey = hkdfSha256(seed, Buffer.alloc(0), Buffer.from(MOBILE_CRYPTO.pairProofInfo, "utf8"));
  return hmacSha256(proofKey, message);
}

/** 电脑的确认：`HMAC-SHA256(Kc, M ‖ utf8(deviceId))`，`Kc = HKDF(S, 盐空, "orbita-pair-confirm")` */
export function hostProofOf(seed: Buffer, message: Buffer, deviceId: string): Buffer {
  const confirmKey = hkdfSha256(seed, Buffer.alloc(0), Buffer.from(MOBILE_CRYPTO.pairConfirmInfo, "utf8"));
  return hmacSha256(confirmKey, message, Buffer.from(deviceId, "utf8"));
}

/** 验手机发来的证明：常数时间比对。公钥长度不对直接算不过 */
export function verifyPairProof(proof: Buffer, seed: Buffer, message: Buffer): boolean {
  if (proof.length !== 32) return false;
  return secretEqual(proof, pairProofOf(seed, message));
}

// ————————————————————————————————————————————————————————————————
// 握手与信道
// ————————————————————————————————————————————————————————————————

/** 握手密钥 `Kh = HKDF-SHA256(ikm = DH, 盐 = nonce, info = "orbita-hello-v1", 32)` */
export function helloKey(shared: Buffer, nonce: Buffer): Buffer {
  return hkdfSha256(shared, nonce, Buffer.from(MOBILE_CRYPTO.helloInfo, "utf8"));
}

/** 信道密钥 `K = HKDF-SHA256(ikm = DH, 盐 = nonce ‖ pn ‖ utf8(deviceId), info = "orbita-channel-v1", 32)` */
export function channelKey(shared: Buffer, nonce: Buffer, pn: Buffer, deviceId: string): Buffer {
  return hkdfSha256(
    shared,
    Buffer.concat([nonce, pn, Buffer.from(deviceId, "utf8")]),
    Buffer.from(MOBILE_CRYPTO.channelInfo, "utf8"),
  );
}

/** 把 `pair.prove` 的参数配上提议里手机看到的那几样，拼成 M */
export function pairMessageOf(
  params: PairProveFrame["params"],
  offer: Pick<PairingOffer, "wire">,
): { message: Buffer; deviceBoxPublic: Buffer } {
  const deviceBoxPublic = Buffer.from(params.deviceBoxPublic, "base64");
  const message = pairMessage({
    offerId: offer.wire.offerId,
    salt: Buffer.from(offer.wire.salt, "base64"),
    iv: Buffer.from(offer.wire.iv, "base64"),
    box: Buffer.from(offer.wire.box, "base64"),
    hostBoxPublic: Buffer.from(offer.wire.hostBoxPublic, "base64"),
    deviceBoxPublic,
    deviceName: params.deviceName,
  });
  return { message, deviceBoxPublic };
}
