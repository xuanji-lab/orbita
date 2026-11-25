/**
 * 配对（手机这一头）：地址 + 6 位配对码 → 一份长期凭据（设备 id、设备私钥、电脑公钥）。
 *
 * 分两条连接走，理由是**电脑对未认证的连接 10 秒就断**（`MOBILE_CRYPTO.handshakeTimeoutMs`），
 * 而 scrypt（N=2^17, r=8）在手机的 JS 引擎上要好几秒——在同一条连接里先 `pair.start`、再算 scrypt、
 * 再 `pair.prove`，慢一点的手机会被电脑当成拖延而断开。提议在 3 分钟内是同一份（同一个
 * offerId、盐、IV、box），所以：
 *
 * 1. 第一条连接：`pair.start` 拿到提议，关掉。
 * 2. 离线算 `keyPin = scrypt(码, 盐)`、解开 `box` 得到种子 S。解不开就是配对码不对，**不发证明**。
 * 3. 第二条连接：再 `pair.start` 一次（契约要求证明与 start 在同一条连接上），核对拿到的还是
 *    同一份提议，自己生成 X25519 密钥对、算证明、`pair.prove`；验电脑的 `hostProof`，验不过就丢掉
 *    刚生成的私钥，报「地址可能被劫持」。
 *
 * 成功后不在这条连接上 hello：交给常驻连接（`link.ts`）照常握手，少一条分支。
 */
import type { PairStartResult } from "../../../src/shared/mobile.ts";
import { MOBILE_CRYPTO, MOBILE_LIMITS, MOBILE_PATH, MOBILE_PROTOCOL_VERSION } from "../../../src/shared/mobile.ts";
import { fromBase64, toBase64 } from "../crypto/bytes.ts";
import {
  acceptKdf,
  derivePinKey,
  generateBoxKeyPair,
  openPairingBox,
  pairMessage,
  pairProofOf,
  verifyHostProof,
} from "../crypto/primitives.ts";
import { FrameSocket, hostUrl, type SocketFactory } from "./socket.ts";
import { pairProveOf, pairStartOf, parseHostFrame } from "./wire.ts";

/** 配对成功后手机要长期留着的东西（私钥进系统密钥库） */
export interface Credentials {
  address: string;
  port: number;
  deviceId: string;
  /** base64：手机自己的 X25519 私钥 */
  devicePrivate: string;
  /** base64：电脑的 X25519 公钥（配对时看到的那把，原样） */
  hostPublic: string;
  hostName: string;
  pairedAt: number;
}

export type PairFailure =
  /** 连不上：地址不对、电脑睡着了、不在同一个网络 */
  | "offline"
  /** 配对码不对（box 解不开） */
  | "wrongCode"
  /** 电脑上没有有效的配对码：过期了、用掉了、还没生成、被换掉了 */
  | "expired"
  /** 电脑的确认对不上：对面不是拿着这个配对码的那台电脑 */
  | "hijacked"
  /** 太频繁 */
  | "busy"
  /** 对面说的不是这套协议 */
  | "protocol";

export type PairOutcome = { ok: true; credentials: Credentials } | { ok: false; reason: PairFailure };

export interface PairInput {
  address: string;
  port: number;
  code: string;
  deviceName: string;
  socketFactory: SocketFactory;
  now(): number;
  /** scrypt 的进度 0–1 */
  onProgress?(fraction: number): void;
}

const CONNECT_TIMEOUT_MS = 8_000;
const FRAME_TIMEOUT_MS = 8_000;

class PairError extends Error {
  readonly reason: PairFailure;

  constructor(reason: PairFailure) {
    super(reason);
    this.reason = reason;
  }
}

export async function pairWithHost(input: PairInput): Promise<PairOutcome> {
  try {
    return { ok: true, credentials: await runPairing(input) };
  } catch (cause) {
    if (cause instanceof PairError) return { ok: false, reason: cause.reason };
    return { ok: false, reason: "offline" };
  }
}

async function runPairing(input: PairInput): Promise<Credentials> {
  const url = hostUrl(input.address, input.port, MOBILE_PATH);
  // 1. 拿提议
  const first = await openClear(input.socketFactory, url);
  let offer: PairStartResult;
  try {
    offer = await pairStart(first, 1);
  } finally {
    first.close();
  }
  if (!acceptKdf(offer.kdf)) throw new PairError("protocol");
  const salt = fromBase64(offer.salt);
  const iv = fromBase64(offer.iv);
  const box = fromBase64(offer.box);
  const hostPublic = fromBase64(offer.hostBoxPublic);
  if (salt === null || iv === null || box === null || hostPublic === null || hostPublic.length !== MOBILE_CRYPTO.keyBytes) {
    throw new PairError("protocol");
  }
  // 2. 离线算 scrypt、解种子
  const keyPin = await derivePinKey(input.code, salt, input.onProgress);
  const seed = openPairingBox(box, iv, keyPin);
  keyPin.fill(0);
  if (seed === null) throw new PairError("wrongCode");
  if (input.now() >= offer.expiresAt) {
    seed.fill(0);
    throw new PairError("expired");
  }
  // 3. 新连接上再 start 一次，核对是同一份提议，然后证明
  const second = await openClear(input.socketFactory, url);
  try {
    const again = await pairStart(second, 2);
    if (again.offerId !== offer.offerId || again.salt !== offer.salt || again.iv !== offer.iv || again.box !== offer.box) {
      // 电脑上换了一组码：手里这个码已经作废
      throw new PairError("expired");
    }
    if (again.hostBoxPublic !== offer.hostBoxPublic) throw new PairError("hijacked");
    const device = generateBoxKeyPair();
    const deviceName = [...input.deviceName.trim()].slice(0, MOBILE_LIMITS.deviceName).join("") || "安卓手机";
    const message = pairMessage({
      offerId: offer.offerId,
      salt,
      iv,
      box,
      hostBoxPublic: hostPublic,
      deviceBoxPublic: device.publicRaw,
      deviceName,
    });
    const proof = pairProofOf(seed, message);
    second.send(
      JSON.stringify({
        v: MOBILE_PROTOCOL_VERSION,
        type: "pair.prove",
        id: 3,
        params: { offerId: offer.offerId, deviceBoxPublic: toBase64(device.publicRaw), deviceName, proof: toBase64(proof) },
      }),
    );
    const reply = await clearReply(second, 3);
    if (!reply.ok) {
      device.privateRaw.fill(0);
      throw new PairError(reply.code === "busy" ? "busy" : "expired");
    }
    const result = pairProveOf(reply.result);
    if (result === null) {
      device.privateRaw.fill(0);
      throw new PairError("protocol");
    }
    // 双向确认：电脑拿同一个种子算出的 hostProof 对不上，就不是那台电脑
    if (!verifyHostProof(result.hostProof, seed, message, result.deviceId)) {
      device.privateRaw.fill(0);
      throw new PairError("hijacked");
    }
    return {
      address: input.address,
      port: input.port,
      deviceId: result.deviceId,
      devicePrivate: toBase64(device.privateRaw),
      hostPublic: offer.hostBoxPublic,
      hostName: result.host.name,
      pairedAt: input.now(),
    };
  } finally {
    seed.fill(0);
    second.close();
  }
}

/** 连上并收下电脑的第一帧 `host.hello`（配对用不上 nonce，但要确认对面说的是这套协议） */
async function openClear(factory: SocketFactory, url: string): Promise<FrameSocket> {
  let socket: FrameSocket;
  try {
    socket = await FrameSocket.open(factory, url, CONNECT_TIMEOUT_MS);
  } catch {
    throw new PairError("offline");
  }
  try {
    const frame = parseHostFrame(await socket.next(FRAME_TIMEOUT_MS));
    if (frame === null || frame.kind !== "hostHello") throw new PairError("protocol");
  } catch (cause) {
    socket.close();
    throw cause instanceof PairError ? cause : new PairError("offline");
  }
  return socket;
}

async function pairStart(socket: FrameSocket, id: number): Promise<PairStartResult> {
  socket.send(JSON.stringify({ v: MOBILE_PROTOCOL_VERSION, type: "pair.start", id }));
  const reply = await clearReply(socket, id);
  if (!reply.ok) throw new PairError(reply.code === "busy" ? "busy" : "expired");
  const offer = pairStartOf(reply.result);
  if (offer === null) throw new PairError("protocol");
  return offer;
}

type ClearOutcome = { ok: true; result: unknown } | { ok: false; code: string };

async function clearReply(socket: FrameSocket, id: number): Promise<ClearOutcome> {
  let text: string;
  try {
    text = await socket.next(FRAME_TIMEOUT_MS);
  } catch {
    throw new PairError("offline");
  }
  const frame = parseHostFrame(text);
  if (frame === null || frame.kind !== "clearReply") throw new PairError("protocol");
  // 形状不对的请求电脑会回 id = 0
  if (frame.id !== id && frame.id !== 0) throw new PairError("protocol");
  return frame.ok ? { ok: true, result: frame.result } : { ok: false, code: frame.error.code };
}
