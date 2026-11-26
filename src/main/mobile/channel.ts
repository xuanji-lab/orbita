/**
 * 一条连接的加密信道（安全审查第 3 条的落地）：`host.hello` → `hello` 握手 → 加密段。
 *
 * - 连上时电脑发 `host.hello`（明文，带这条连接的新鲜数 nonce）。手机握手之前并没有验证对面
 *   是电脑，所以**握手应答也是密的**（用 Kh）。
 * - `hello` 是手机方向的第一个加密帧（Kh、seq = 1），密文里有手机自己的新鲜数 pn；
 *   解开才算认出这台设备——不知道设备私钥的解不开，被撤销的设备（表里没了）直接不认。
 * - 之后两边用 K（每条连接一把：`HKDF(DH, 盐 = nonce ‖ pn ‖ deviceId)`）。两个方向各自的
 *   seq 从 1 起、**必须恰好加 1**：跳号、重号、解不开，都断开。
 * - Kh 与 K 是两个独立的 seq 空间（各从 1 起）：IV 重用只在同一把钥匙下才是问题。
 *
 * 取号与密封写在同一个同步函数里（`sealOutbound`）：先取号再 `await` 会把两个并发应答以
 * 2、1 的顺序发出去，手机按规矩直接断线（安全审查第 6 条）。
 *
 * 纯模块：不 import electron / ws，`node --test` 直测。
 */
import { randomBytes, type KeyObject } from "node:crypto";
import type {
  ClearReply,
  HandshakeReplyFrame,
  HelloBody,
  HelloFrame,
  HelloResult,
  HostHelloFrame,
  SealedFrame,
} from "../../shared/mobile.ts";
import { MOBILE_CRYPTO, MOBILE_PROTOCOL_VERSION } from "../../shared/mobile.ts";
import { parseHelloBody } from "../../shared/mobile-wire.ts";
import { channelKey, helloKey, openFrame, sealFrame, sharedSecret } from "./crypto.ts";

export class SecureChannel {
  private readonly hostPrivateKey: KeyObject;
  private readonly nonce: Buffer;
  private kh: Buffer | null = null;
  private key: Buffer | null = null;
  private aad: string | null = null;
  private sendSeq = 0;
  private recvSeq = 0;

  constructor(hostPrivateKey: KeyObject) {
    this.hostPrivateKey = hostPrivateKey;
    this.nonce = randomBytes(MOBILE_CRYPTO.nonceBytes);
  }

  /** 连上之后电脑发的第一帧（明文）：这条连接的新鲜数 */
  hostHello(): HostHelloFrame {
    return { v: MOBILE_PROTOCOL_VERSION, type: "host.hello", nonce: this.nonce.toString("base64") };
  }

  get isOpen(): boolean {
    return this.key !== null;
  }

  /**
   * 手机的 `hello` → 握手。设备不在表里（调用方传 null）、公钥不是合法点、密文解不开、
   * 明文形状不对，都回 null——调用方断开，不回任何明文应答（对面还没证明自己是手机，
   * 回明文等于告诉路径上的任何人「这台电脑在」）。
   */
  acceptHello(frame: HelloFrame, device: { id: string; boxPublic: Buffer } | null): HelloBody | null {
    if (this.isOpen || device === null || device.id !== frame.d) return null;
    let shared: Buffer;
    try {
      shared = sharedSecret(this.hostPrivateKey, device.boxPublic);
    } catch {
      return null;
    }
    const kh = helloKey(shared, this.nonce);
    const plaintext = openFrame(kh, "deviceToHost", 1, frame.d, Buffer.from(frame.ct, "base64"));
    if (plaintext === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(plaintext);
    } catch {
      return null;
    }
    const body = parseHelloBody(raw);
    if (!body.ok) return null;
    this.kh = kh;
    this.key = channelKey(shared, this.nonce, Buffer.from(body.value.pn, "base64"), frame.d);
    this.aad = frame.d;
    return body.value;
  }

  /** 握手应答（`{id, ok, result}` 或错误）：Kh、电脑方向 seq = 1，带 `d` 让手机确认认的是它 */
  sealHandshakeReply(reply: ClearReply<HelloResult>, deviceId: string): HandshakeReplyFrame {
    if (this.kh === null) throw new Error("handshake reply before hello");
    const sealed = sealFrame(this.kh, "hostToDevice", 1, deviceId, JSON.stringify(reply));
    return { v: MOBILE_PROTOCOL_VERSION, d: deviceId, n: 1, ct: sealed.ct };
  }

  /**
   * 加密段：手机 → 电脑。seq 必须恰好是上一个 +1（第一个数据帧是 1）；解不开、跳号、重号
   * 都回 null——调用方断开。成功才把序号推进去。
   */
  openInbound(frame: SealedFrame): string | null {
    if (this.key === null || this.aad === null) return null;
    if (frame.n !== this.recvSeq + 1) return null;
    const plaintext = openFrame(this.key, "deviceToHost", frame.n, this.aad, Buffer.from(frame.ct, "base64"));
    if (plaintext === null) return null;
    this.recvSeq = frame.n;
    return plaintext;
  }

  /** 加密段：电脑 → 手机。同步取号 + 密封，调用方拿到就发，中间没有 `await` 的余地 */
  sealOutbound(plaintext: string): SealedFrame {
    if (this.key === null || this.aad === null) throw new Error("seal before handshake");
    this.sendSeq += 1;
    const sealed = sealFrame(this.key, "hostToDevice", this.sendSeq, this.aad, plaintext);
    return { v: MOBILE_PROTOCOL_VERSION, n: sealed.n, ct: sealed.ct };
  }
}
