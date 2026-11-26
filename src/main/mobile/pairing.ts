/**
 * 配对的提议簿——电脑这一头「同一时刻只有一个有效提议」的全部状态：
 * 生成与作废、过期、连错作废、`pair.start` 的来源限速、验手机发来的证明。
 *
 * 规矩（规格第 3 节 + 2026-11-25 安全审查）：
 * - 提议 3 分钟过期；过期、用掉、被用户取消、或用户又生成了新的，**种子立刻丢弃**。种子过期即废，
 *   所以录下配对流量离线猜配对码没有用——猜中时提议早就没了。
 * - 一个提议最多验 5 次 `pair.prove`，都不中就作废。诚实的手机解不开 `box` 就不会发证明，
 *   发来的失败证明只会来自攻击者。
 * - `pair.start` 每个来源地址每分钟最多 10 次（IPv6 下地址可以随便换，所以表有上限，满了新地址一律拒）。
 * - 验过之后这台设备的加密公钥要先确认是个合法的 X25519 点——低阶点的公钥会让之后的握手
 *   永远算不出密钥，不如现在就拒。
 *
 * 纯核 + 依赖注入：`now` 可换假时钟，密钥派生可换轻量版，`node --test` 直接测。
 */
import type { MobileError, PairProveFrame } from "../../shared/mobile.ts";
import { MOBILE_CRYPTO } from "../../shared/mobile.ts";
import type { KeyObject } from "node:crypto";
import {
  boxPrivateKeyFromRaw,
  createPairingOffer,
  generateBoxKeyPair,
  hostProofOf,
  InvalidPeerKeyError,
  pairMessageOf,
  sharedSecret,
  verifyPairProof,
  type PairingOffer,
} from "./crypto.ts";

export interface PairingBookDeps {
  now(): number;
  /** 电脑的 X25519 公钥（原始 32 字节） */
  hostBoxPublic: Buffer;
  /** 测试换轻量派生；生产走 scrypt */
  derivePinKey?: (code: Buffer, salt: Buffer) => Promise<Buffer>;
  /**
   * `pair.start` 的来源地址表最多记多少个地址；满了之后**新**地址一律拒（记过的照常按窗口放行）
   */
  maxTrackedAddresses?: number;
}

export type ProveVerdict =
  | { ok: true; hostProof: Buffer; deviceBoxPublic: Buffer }
  | { ok: false; error: MobileError };

/** `pair.start` 限速的窗口（毫秒） */
const START_WINDOW_MS = 60_000;
const DEFAULT_MAX_TRACKED = 1024;

const GONE: MobileError = { code: "unauthorized", message: "配对码已过期或不对，请在电脑上重新生成" };

export class PairingBook {
  private readonly deps: PairingBookDeps;
  private offer: PairingOffer | null = null;
  private inflight: Promise<PairingOffer> | null = null;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  /** 正在生成的时候用户点了取消：生成完的那份也不要 */
  private cancelledDuringCreate = false;
  /** 这个提议已经验过几次 `pair.prove` */
  private attempts = 0;
  /** 每个来源地址最近一分钟里的 `pair.start` 时刻 */
  private readonly starts = new Map<string, number[]>();

  constructor(deps: PairingBookDeps) {
    this.deps = deps;
  }

  /**
   * 生成一份新提议（用户点了「生成配对码」）。正在生成时再点，拿到的是同一份。
   * 新提议一生成，旧的立刻作废。scrypt 要几百毫秒，所以是异步的。
   */
  create(): Promise<PairingOffer> {
    if (this.inflight !== null) {
      // 取消后立刻再点「生成」：等旧的那次派生结束再生成新的，不并发吃两份 scrypt 内存
      return this.cancelledDuringCreate ? this.inflight.then(() => this.create(), () => this.create()) : this.inflight;
    }
    this.cancelledDuringCreate = false;
    this.dropOffer();
    const created = createPairingOffer(this.deps.hostBoxPublic, { now: this.deps.now, derivePinKey: this.deps.derivePinKey });
    this.inflight = created;
    void created.then(
      (offer) => {
        this.inflight = null;
        // 生成期间用户点了取消：这份也不要，种子照样清掉
        if (this.cancelledDuringCreate) {
          this.cancelledDuringCreate = false;
          offer.seed.fill(0);
          return;
        }
        this.offer = offer;
        this.attempts = 0;
        this.offerTimer = setTimeout(() => this.dropOffer(), MOBILE_CRYPTO.offerTtlMs);
        // 提议过期不该成为让进程一直活着的理由；主进程本身常驻，测试进程则能正常退出
        this.offerTimer.unref();
      },
      () => {
        this.inflight = null;
        this.cancelledDuringCreate = false;
      },
    );
    return created;
  }

  /** 用户点了取消：当前提议作废；正在生成的作废 */
  cancel(): void {
    this.cancelledDuringCreate = this.inflight !== null;
    this.dropOffer();
  }

  /** 此刻有效的提议（没过期）；给设置页显示配对码用。过期了的顺手丢掉 */
  current(): { offerId: string; code: string; expiresAt: number } | null {
    const offer = this.liveOffer();
    if (offer === null) return null;
    return { offerId: offer.offerId, code: offer.code, expiresAt: offer.expiresAt };
  }

  /** 此刻有效提议发给手机的那一半（`pair.start` 的应答）；没有有效提议回 null */
  currentOfferWire(): PairingOffer["wire"] | null {
    return this.liveOffer()?.wire ?? null;
  }

  /** `pair.start` 要发给手机的那一半；不把种子交出去 */
  wire(): PairingOffer["wire"] | null {
    return this.liveOffer()?.wire ?? null;
  }

  /** `pair.start` 的来源限速：这个地址这一分钟里还能不能再要一次 */
  admitStart(address: string): boolean {
    const now = this.deps.now();
    const recent = (this.starts.get(address) ?? []).filter((at) => now - at < START_WINDOW_MS);
    if (recent.length >= MOBILE_CRYPTO.pairStartPerMinutePerAddress) {
      this.starts.set(address, recent);
      return false;
    }
    if (recent.length === 0 && !this.starts.has(address)) {
      // 新地址：先扫一遍过期的；还满着就不认新地址了
      if (this.starts.size >= (this.deps.maxTrackedAddresses ?? DEFAULT_MAX_TRACKED)) this.sweep(now);
      if (this.starts.size >= (this.deps.maxTrackedAddresses ?? DEFAULT_MAX_TRACKED)) return false;
    }
    recent.push(now);
    this.starts.set(address, recent);
    return true;
  }

  /**
   * 验手机发来的 `pair.prove`。`deviceId` 由调用方铸好传进来（验过才登记设备）。
   * 任何一步不中都是同一句 `unauthorized`：不告诉对端是「码不对」还是「过期了」。
   */
  prove(frame: PairProveFrame, deviceId: string): ProveVerdict {
    const offer = this.liveOffer();
    if (offer === null || offer.offerId !== frame.params.offerId) return { ok: false, error: GONE };
    const { message, deviceBoxPublic } = pairMessageOf(frame.params, offer);
    this.attempts += 1;
    const seed = offer.seed;
    const matched = verifyPairProof(Buffer.from(frame.params.proof, "base64"), seed, message) && this.isUsableKey(deviceBoxPublic);
    if (!matched) {
      // 连错就作废：给不了对方无限次的在线猜码
      if (this.attempts >= MOBILE_CRYPTO.maxProveAttemptsPerOffer) this.dropOffer();
      return { ok: false, error: GONE };
    }
    // 先算确认，再清种子：dropOffer 会把 seed 原地清零
    const hostProof = hostProofOf(seed, message, deviceId);
    // 用掉了：种子立刻丢弃，同一个证明不能再用来登记第二台设备
    this.dropOffer();
    return { ok: true, hostProof, deviceBoxPublic };
  }

  // ———————————————————— 内部 ————————————————————

  /** 没过期的当前提议；过期了就地丢弃 */
  private liveOffer(): PairingOffer | null {
    if (this.offer !== null && this.deps.now() >= this.offer.expiresAt) this.dropOffer();
    return this.offer;
  }

  private dropOffer(): void {
    if (this.offerTimer !== null) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    if (this.offer !== null) this.offer.seed.fill(0);
    this.offer = null;
    this.attempts = 0;
  }

  /** 公钥得是个合法的 X25519 点：拿一把留着不用的私钥跟它协商一次，抛错就不是 */
  private isUsableKey(publicRaw: Buffer): boolean {
    checkKey ??= boxPrivateKeyFromRaw(generateBoxKeyPair().privateRaw);
    try {
      sharedSecret(checkKey, publicRaw);
      return true;
    } catch (cause) {
      if (cause instanceof InvalidPeerKeyError) return false;
      throw cause;
    }
  }

  private sweep(now: number): void {
    for (const [address, ats] of this.starts) {
      const recent = ats.filter((at) => now - at < START_WINDOW_MS);
      if (recent.length === 0) this.starts.delete(address);
      else this.starts.set(address, recent);
    }
  }
}

/** 试公钥合法性用的私钥：进程里只生成一次，不跟任何真实密钥混用 */
let checkKey: KeyObject | null = null;
