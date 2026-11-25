/**
 * 和已配对电脑的常驻连接：连上 → 收 `host.hello` → 发 `hello` → **等握手应答** → 加密段收发 → 断了就重连。
 *
 * - 请求：`request(method, params)` 铸一个连接内递增的 id，等对应的应答（15 秒超时）。
 *   形状不对的请求电脑回 `id = 0`：没法对上是哪一个，记一笔、不动别的请求。
 * - 通知：原样交给 `onNotification`。
 * - 序号：`PhoneChannel.openInbound` 收到的不是恰好 +1、或解不开，**断开重连**（不尝试续上）。
 * - 重连：1、2、4、8、15 秒退避，连上一次就归零。每次连上（`onOpen`）调用方重新拉清单与尾部、
 *   重新订阅——电脑那头的订阅跟着连接走，断了就没了。
 * - 活性：每 25 秒发一次应用层 `ping`，10 秒没回就当连接已死、重连（手机换网络时 TCP 可能
 *   很久才报错）。
 * - `host.shutdown`：电脑要退出了。契约说「别再重连」；这里改成**慢慢地**试（10 秒一次），
 *   不狂敲：用户把电脑上的璇玑重开之后，手机得自己连回来（验收第 6 步）。
 * - 认不出：连上、发了 hello、电脑一声不吭就断（它对认不出的设备不回明文）连着 3 次，判成
 *   「这台手机被电脑忘掉了」，停止重连，交给界面让用户重新配对。
 */
import type { MobileError, MobileMethod, MobileMethodParams, MobileNotification } from "../../../src/shared/mobile.ts";
import { MOBILE_PATH } from "../../../src/shared/mobile.ts";
import { fromBase64 } from "../crypto/bytes.ts";
import { PhoneChannel } from "../crypto/channel.ts";
import type { Credentials } from "./pair.ts";
import { FrameSocket, hostUrl, type SocketFactory } from "./socket.ts";
import { parseHostFrame, parseSealedPayload } from "./wire.ts";

export type LinkStatus =
  /** 正在连（第一次，或断了之后） */
  | { kind: "connecting"; attempt: number; since: number | null }
  /** 已握手 */
  | { kind: "open"; hostName: string; since: number }
  /** 连不上 / 断了，等下一次重试 */
  | { kind: "waiting"; attempt: number; retryAt: number; since: number | null; shutdown: boolean }
  /** 电脑认不出这台手机了（被忘掉或换了主机钥匙），不再重连 */
  | { kind: "rejected" }
  | { kind: "stopped" };

export class RequestError extends Error {
  readonly error: MobileError;

  constructor(error: MobileError) {
    super(error.message);
    this.name = "RequestError";
    this.error = error;
  }
}

export interface LinkDeps {
  credentials: Credentials;
  socketFactory: SocketFactory;
  /** hello 里带的名字（想改名才带；null 不带） */
  deviceName: string | null;
  now(): number;
  onStatus(status: LinkStatus): void;
  onNotification(notification: MobileNotification): void;
  /** 每次握手成功后调一次：重新拉数据、重新订阅 */
  onOpen(): void;
  log?(line: string): void;
  /** 测试可调小 */
  timing?: Partial<typeof DEFAULT_TIMING>;
}

const DEFAULT_TIMING = {
  connectMs: 8_000,
  frameMs: 10_000,
  requestMs: 15_000,
  pingEveryMs: 25_000,
  pingTimeoutMs: 10_000,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 15_000] as readonly number[],
  shutdownRetryMs: 10_000,
  rejectAfter: 3,
};

interface Pending {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Live {
  socket: FrameSocket;
  channel: PhoneChannel;
  nextId: number;
  pending: Map<number, Pending>;
  pingTimer: ReturnType<typeof setInterval> | null;
}

export class HostLink {
  private readonly deps: LinkDeps;
  private readonly timing: typeof DEFAULT_TIMING;
  private readonly devicePrivate: Uint8Array;
  private readonly hostPublic: Uint8Array;
  private live: Live | null = null;
  private stopped = true;
  private attempt = 0;
  private silentRejects = 0;
  private shutdownSeen = false;
  /** 最后一次从电脑收到东西（握手应答或任何一帧）的时刻：断线时界面写「最后同步」 */
  private lastSeenAt: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private statusValue: LinkStatus = { kind: "stopped" };

  constructor(deps: LinkDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_TIMING, ...deps.timing };
    const devicePrivate = fromBase64(deps.credentials.devicePrivate);
    const hostPublic = fromBase64(deps.credentials.hostPublic);
    if (devicePrivate === null || hostPublic === null) throw new Error("credentials are not valid base64");
    this.devicePrivate = devicePrivate;
    this.hostPublic = hostPublic;
  }

  get status(): LinkStatus {
    return this.statusValue;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.silentRejects = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.drop(new Error("stopped"));
    this.setStatus({ kind: "stopped" });
  }

  /** 用户点了「重试」，或 app 回到前台：等待中的立刻再连一次 */
  retryNow(): void {
    if (this.stopped || this.live !== null) return;
    if (this.statusValue.kind === "connecting") return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  }

  request<M extends MobileMethod>(method: M, params: MobileMethodParams[M]): Promise<unknown> {
    const live = this.live;
    if (live === null || !live.channel.isOpen) return Promise.reject(new RequestError({ code: "unavailable", message: "还没连上电脑" }));
    const id = live.nextId;
    live.nextId += 1;
    const empty = typeof params === "object" && params !== null && Object.keys(params).length === 0;
    const body = JSON.stringify(empty ? { id, method } : { id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        live.pending.delete(id);
        reject(new RequestError({ code: "unavailable", message: "电脑没有应答" }));
      }, this.timing.requestMs);
      live.pending.set(id, { resolve, reject, timer });
      // 取号、密封、发送在同一个同步段里
      const sent = live.socket.send(JSON.stringify(live.channel.sealOutbound(body)));
      if (!sent) {
        clearTimeout(timer);
        live.pending.delete(id);
        reject(new RequestError({ code: "unavailable", message: "和电脑断开了" }));
      }
    });
  }

  // ———————————————————— 内部 ————————————————————

  private setStatus(status: LinkStatus): void {
    this.statusValue = status;
    this.deps.onStatus(status);
  }

  private async connect(): Promise<void> {
    const generation = (this.generation += 1);
    this.attempt += 1;
    this.setStatus({ kind: "connecting", attempt: this.attempt, since: this.lastSeenAt });
    const { credentials } = this.deps;
    const url = hostUrl(credentials.address, credentials.port, MOBILE_PATH);
    let socket: FrameSocket;
    try {
      socket = await FrameSocket.open(this.deps.socketFactory, url, this.timing.connectMs);
    } catch {
      if (generation === this.generation) this.scheduleRetry();
      return;
    }
    if (generation !== this.generation || this.stopped) {
      socket.close();
      return;
    }
    let helloSent = false;
    try {
      const channel = PhoneChannel.create({
        deviceId: credentials.deviceId,
        devicePrivate: this.devicePrivate,
        hostPublic: this.hostPublic,
      });
      if (channel === null) throw new Error("bad host key");
      const first = parseHostFrame(await socket.next(this.timing.frameMs));
      if (first === null || first.kind !== "hostHello") throw new Error("expected host.hello");
      const hello = channel.hello({
        hostNonce: first.nonce,
        requestId: 1,
        ...(this.deps.deviceName === null ? {} : { name: this.deps.deviceName }),
      });
      if (hello === null) throw new Error("bad host nonce");
      socket.send(JSON.stringify(hello));
      helloSent = true;
      // 必须等到握手应答，才发数据帧
      const reply = parseHostFrame(await socket.next(this.timing.frameMs));
      if (reply === null || reply.kind !== "handshake") throw new Error("expected handshake reply");
      const outcome = channel.acceptHandshake(reply);
      if (outcome === null || !outcome.ok) throw new Error("handshake rejected");
      if (generation !== this.generation || this.stopped) {
        socket.close();
        return;
      }
      this.attempt = 0;
      this.silentRejects = 0;
      this.shutdownSeen = false;
      const live: Live = { socket, channel, nextId: 2, pending: new Map(), pingTimer: null };
      this.live = live;
      this.lastSeenAt = this.deps.now();
      socket.onClose(() => {
        if (this.live !== live) return;
        this.drop(new Error("closed"));
        if (!this.stopped) this.scheduleRetry();
      });
      socket.listen((text) => this.onFrame(live, text));
      live.pingTimer = setInterval(() => this.ping(live), this.timing.pingEveryMs);
      this.setStatus({ kind: "open", hostName: outcome.result.host.name, since: this.lastSeenAt });
      this.deps.onOpen();
    } catch (cause) {
      socket.close();
      if (generation !== this.generation) return;
      // hello 发出去之后电脑一声不吭就断：它认不出这台设备
      const silent = helloSent && cause instanceof Error && (cause.message === "closed" || cause.message === "socket error");
      this.silentRejects = silent ? this.silentRejects + 1 : 0;
      this.deps.log?.(`[link] 握手没成：${cause instanceof Error ? cause.message : String(cause)}`);
      if (this.silentRejects >= this.timing.rejectAfter) {
        this.stopped = true;
        this.setStatus({ kind: "rejected" });
        return;
      }
      this.scheduleRetry();
    }
  }

  private onFrame(live: Live, text: string): void {
    const frame = parseHostFrame(text);
    if (frame === null || frame.kind !== "sealed") {
      this.breakLink(live, "unexpected frame");
      return;
    }
    const plain = live.channel.openInbound(frame);
    if (plain !== null) this.lastSeenAt = this.deps.now();
    if (plain === null) {
      // 解不开、跳号、重号：按协议断开重连
      this.breakLink(live, "bad sequence or ciphertext");
      return;
    }
    const payload = parseSealedPayload(plain);
    if (payload === null) {
      this.deps.log?.("[link] 认不出的一帧，丢掉");
      return;
    }
    if (payload.kind === "notification") {
      if (payload.notification.event === "host.shutdown") this.shutdownSeen = true;
      this.deps.onNotification(payload.notification);
      return;
    }
    const pending = live.pending.get(payload.id);
    if (pending === undefined) {
      this.deps.log?.(`[link] 应答对不上请求（id ${payload.id}）`);
      return;
    }
    live.pending.delete(payload.id);
    clearTimeout(pending.timer);
    if (payload.ok) pending.resolve(payload.result);
    else pending.reject(new RequestError(payload.error));
  }

  private ping(live: Live): void {
    if (this.live !== live) return;
    let answered = false;
    const timer = setTimeout(() => {
      if (!answered && this.live === live) this.breakLink(live, "ping timeout");
    }, this.timing.pingTimeoutMs);
    this.request("ping", {}).then(
      () => {
        answered = true;
        clearTimeout(timer);
      },
      () => {
        answered = true;
        clearTimeout(timer);
      },
    );
  }

  private breakLink(live: Live, reason: string): void {
    if (this.live !== live) return;
    this.deps.log?.(`[link] 断开：${reason}`);
    this.drop(new Error(reason));
    if (!this.stopped) this.scheduleRetry();
  }

  private drop(error: Error): void {
    const live = this.live;
    this.live = null;
    if (live === null) return;
    if (live.pingTimer !== null) clearInterval(live.pingTimer);
    for (const pending of live.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RequestError({ code: "unavailable", message: error.message === "stopped" ? "已停止" : "和电脑断开了" }));
    }
    live.pending.clear();
    live.socket.close();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const backoff = this.timing.backoffMs;
    const delay = this.shutdownSeen
      ? this.timing.shutdownRetryMs
      : (backoff[Math.min(this.attempt - 1, backoff.length - 1)] ?? backoff[backoff.length - 1] ?? 15_000);
    const retryAt = this.deps.now() + delay;
    this.setStatus({ kind: "waiting", attempt: this.attempt, retryAt, since: this.lastSeenAt, shutdown: this.shutdownSeen });
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}
