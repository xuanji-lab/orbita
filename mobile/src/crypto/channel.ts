/**
 * 手机这一头的加密信道：`host.hello` → 手机的 `hello` → 电脑的握手应答 → 加密段。
 *
 * 和电脑侧 `src/main/mobile/channel.ts` 是镜像：
 * - 连上后电脑先发明文 `host.hello { nonce }`。手机现生成自己的新鲜数 `pn`（每条连接一个，不重用），
 *   用握手密钥 Kh（`HKDF(DH, 盐 = nonce)`）密封 `hello`（手机方向 seq = 1）。
 * - **等到电脑的握手应答**（Kh、电脑方向 seq = 1、`d` 是自己的设备 id）解得开，才算对面是那台电脑；
 *   在这之前不发任何数据帧。
 * - 之后用这条连接的 K（`HKDF(DH, 盐 = nonce ‖ pn ‖ deviceId)`），两个方向的 seq 各自从 1 起、
 *   **恰好加 1**：收到的不是上一个 +1、或解不开，`openInbound` 回 null，调用方断开重连。
 * - 取号与密封在同一个同步函数里（`sealOutbound`），拿到就发。
 *
 * 纯模块，`node --test` 直测。
 */
import type { HandshakeReplyFrame, HelloBody, HelloFrame, HelloResult, SealedFrame } from "../../../src/shared/mobile.ts";
import { MOBILE_CRYPTO, MOBILE_PROTOCOL_VERSION } from "../../../src/shared/mobile.ts";
import { fromBase64, toBase64 } from "./bytes.ts";
import { channelKey, helloKey, openFrame, sealFrame, secureRandom, sharedSecret } from "./primitives.ts";

/** 握手应答的明文：成功带 `result`，失败带 `error`（电脑认不出时其实直接断线，不回这个） */
export type HandshakeOutcome =
  | { ok: true; result: HelloResult }
  | { ok: false; code: string; message: string };

export class PhoneChannel {
  private readonly deviceId: string;
  private readonly shared: Uint8Array;
  private kh: Uint8Array | null = null;
  private nonce: Uint8Array | null = null;
  private pn: Uint8Array | null = null;
  private key: Uint8Array | null = null;
  private sendSeq = 0;
  private recvSeq = 0;

  /**
   * `shared` 由调用方先算好（`sharedSecret(设备私钥, 电脑公钥)`）：算不出（对面公钥是坏点）
   * 就不该建信道。`pn` 可注入只为定值向量测试；生产里每条连接现生成。
   */
  constructor(input: { deviceId: string; shared: Uint8Array }) {
    this.deviceId = input.deviceId;
    this.shared = input.shared;
  }

  /** 由设备私钥与电脑公钥建一条信道；公钥是坏点回 null */
  static create(input: { deviceId: string; devicePrivate: Uint8Array; hostPublic: Uint8Array }): PhoneChannel | null {
    const shared = sharedSecret(input.devicePrivate, input.hostPublic);
    return shared === null ? null : new PhoneChannel({ deviceId: input.deviceId, shared });
  }

  get isOpen(): boolean {
    return this.key !== null;
  }

  /**
   * 收到 `host.hello` 之后：铸 `pn`，密封 `hello`。nonce 写法不对（不是 32 字节的规范 base64）回 null。
   * 一条信道只能 hello 一次。
   */
  hello(input: { hostNonce: string; requestId: number; name?: string; pn?: Uint8Array }): HelloFrame | null {
    if (this.kh !== null) return null;
    const nonce = fromBase64(input.hostNonce);
    if (nonce === null || nonce.length !== MOBILE_CRYPTO.nonceBytes) return null;
    const pn = input.pn ?? secureRandom(MOBILE_CRYPTO.nonceBytes);
    if (pn.length !== MOBILE_CRYPTO.nonceBytes) return null;
    const body: HelloBody = input.name === undefined ? { pn: toBase64(pn) } : { pn: toBase64(pn), name: input.name };
    this.kh = helloKey(this.shared, nonce);
    this.nonce = nonce;
    this.pn = pn;
    const ct = sealFrame(this.kh, "deviceToHost", 1, this.deviceId, JSON.stringify(body));
    return { v: MOBILE_PROTOCOL_VERSION, type: "hello", id: input.requestId, d: this.deviceId, n: 1, ct: toBase64(ct) };
  }

  /**
   * 电脑的握手应答：`d` 必须是自己、`n` 必须是 1、Kh 解得开、明文形状对。成功才派生 K、打开信道。
   * 任何一样不对回 null（调用方断开）。
   */
  acceptHandshake(frame: HandshakeReplyFrame): HandshakeOutcome | null {
    if (this.kh === null || this.nonce === null || this.pn === null || this.key !== null) return null;
    if (frame.d !== this.deviceId || frame.n !== 1) return null;
    const ct = fromBase64(frame.ct);
    if (ct === null) return null;
    const plain = openFrame(this.kh, "hostToDevice", 1, this.deviceId, ct);
    if (plain === null) return null;
    const outcome = parseHandshakeBody(plain);
    if (outcome === null) return null;
    if (outcome.ok) this.key = channelKey(this.shared, this.nonce, this.pn, this.deviceId);
    return outcome;
  }

  /** 加密段：手机 → 电脑。同步取号 + 密封 */
  sealOutbound(plaintext: string): SealedFrame {
    if (this.key === null) throw new Error("seal before handshake");
    this.sendSeq += 1;
    const ct = sealFrame(this.key, "deviceToHost", this.sendSeq, this.deviceId, plaintext);
    return { v: MOBILE_PROTOCOL_VERSION, n: this.sendSeq, ct: toBase64(ct) };
  }

  /** 加密段：电脑 → 手机。seq 必须恰好是上一个 +1；解不开、跳号、重号回 null（调用方断开） */
  openInbound(frame: SealedFrame): string | null {
    if (this.key === null) return null;
    if (frame.n !== this.recvSeq + 1) return null;
    const ct = fromBase64(frame.ct);
    if (ct === null) return null;
    const plain = openFrame(this.key, "hostToDevice", frame.n, this.deviceId, ct);
    if (plain === null) return null;
    this.recvSeq = frame.n;
    return plain;
  }
}

/** 握手应答的明文 `{ id, ok, result | error }`（`v` 可有可无：电脑侧把 ClearReply 原样封进去） */
function parseHandshakeBody(plain: string): HandshakeOutcome | null {
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record["ok"] === false) {
    const error = record["error"];
    if (typeof error !== "object" || error === null) return null;
    const fields = error as Record<string, unknown>;
    const code = fields["code"];
    const message = fields["message"];
    return typeof code === "string" && typeof message === "string" ? { ok: false, code, message } : null;
  }
  if (record["ok"] !== true) return null;
  const result = record["result"];
  if (typeof result !== "object" || result === null) return null;
  const fields = result as Record<string, unknown>;
  const host = fields["host"];
  const protocol = fields["protocol"];
  if (typeof host !== "object" || host === null || typeof protocol !== "number") return null;
  const hostFields = host as Record<string, unknown>;
  const name = hostFields["name"];
  const hostProtocol = hostFields["protocol"];
  if (typeof name !== "string" || typeof hostProtocol !== "number") return null;
  return { ok: true, result: { host: { name, protocol: hostProtocol }, protocol } };
}
