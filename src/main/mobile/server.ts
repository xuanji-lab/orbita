/**
 * 手机的监听服务：WebSocket 服务器 + 每条连接的状态机 + 十个方法的分发。
 *
 * 安全边界（规格 + 2026-11-25 安全审查第 4 / 5 / 6 条）：
 * - 现有 IPC 通道没有调用方鉴权，其中一条能取回明文密钥——**手机不桥接它们**，只开契约里
 *   列出的十个方法，每个方法的入参都过 `mobile-wire.ts` 的手写校验。
 * - 单帧上限 64 KB（`maxPayload`，`ws` 默认是 100 MiB）、关压缩、带 `Origin` 的握手一律拒
 *   （浏览器网页能跨源连 WebSocket）；未认证的连接最多 8 条、10 秒内没过握手就断；总连接
 *   最多 16 条；一台设备只留一条连接（重连顶掉旧的）。
 * - 每个连接的回调整体 try/catch：主进程没有 uncaughtException 兜底，一处抛错整个应用退出。
 * - 撤销立刻断：先 terminate 连接，再清这台设备的待发回复，最后落盘；每个 `await` 之后、
 *   往连接写东西之前，都复查这条连接是不是还活着。
 * - `reply` 按设备去重：10 分钟内同一个 `requestId` 回上次的结果，不再发一轮（断线重连的
 *   手机会重发）。`tail.load` / `reply` / `stop` / `unread.clear` 只认 `sessions.list` 清单里
 *   的会话（安全审查第 7 条）。
 * - `stop` 只对「在跑或有待发的」会话调 `abort`——对空闲会话调 abort 会白白拉起 agent 进程
 *   （`abort` 先 `ensure()`）。
 *
 * 诊断：有手机连着时每 10 秒记一次主进程事件循环延迟的分位数（验收要拿这个数）。
 */
import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import {
  errorReply,
  mobileNotification,
  MOBILE_CRYPTO,
  MOBILE_FRAME_MAX_BYTES,
  MOBILE_OUTBOUND_FRAME_MAX_BYTES,
  MOBILE_PATH,
  MOBILE_PROTOCOL_VERSION,
  okReply,
  type ClearReply,
  type HelloFrame,
  type HelloResult,
  type MobileMethod,
  type MobileNotifications,
  type MobileReply,
  type MobileRequest,
  type MobileSettings,
  type PairProveFrame,
} from "../../shared/mobile.ts";
import { isSealedFrame, parseInboundFrame, parseRequest, type InboundFrame } from "../../shared/mobile-wire.ts";
import { SecureChannel } from "./channel.ts";
import { PairingBook } from "./pairing.ts";
import type { HostCrypto } from "./host-keys.ts";
import type { MobileCatalog } from "./summaries.ts";
import type { MobileTails } from "./tails.ts";
import type { MobileStore } from "./store.ts";
import { mobileSettingsOf, toMobileDevice } from "./store.ts";
import type { ReplyQueue, ReplySubmit } from "./replies.ts";

export interface MobileServerDeps {
  store: MobileStore;
  catalog: MobileCatalog;
  tails: MobileTails;
  replies: ReplyQueue;
  isRunning(sessionId: string): boolean;
  abort(sessionId: string): Promise<void>;
  setUnread(id: string, unread: null): Promise<void>;
  /** 会话 meta 变了（未读被手机清了）：广播给开着的桌面窗口 */
  metaChanged(id: string): void;
  hostName(): string;
  now(): number;
  log?(line: string): void;
  /** 配对码派生的注入：测试换轻量版（生产走 scrypt，一次 128 MiB） */
  derivePinKey?: (code: Buffer, salt: Buffer) => Promise<Buffer>;
}

interface Connection {
  socket: WebSocket;
  address: string;
  channel: SecureChannel;
  /** 已过握手：这是哪台设备 */
  deviceId: string | null;
  /** 这条连接上 `pair.start` 给过的提议 id（`pair.prove` 只认它——同一个证明不能换条连接重放） */
  offeredOfferId: string | null;
  /** 这条连接上配对成功的设备 id（接下来只收它的 hello） */
  provenDeviceId: string | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  /** 最近一次收到任何帧（含 pong）的时刻 */
  aliveAt: number;
  /** 入站帧率（最近一秒的时间戳） */
  frames: number[];
  /** 出站令牌桶：这一秒已经发了多少字节 */
  sentBytes: number;
  sentWindowStart: number;
  /** 看清单的退订 */
  unwatchCatalog: (() => void) | null;
  /** 看尾部的退订（按会话） */
  unwatchTails: Map<string, () => void>;
  /** 关了（或被顶掉 / 撤销）之后不再写 */
  closed: boolean;
}

/** 每条连接每秒最多收几帧（契约常量） */
const FRAME_LIMIT = MOBILE_CRYPTO.maxFramesPerSecond;

export class MobileServer {
  private readonly deps: MobileServerDeps;
  private server: WebSocketServer | null = null;
  private pairing: PairingBook | null = null;
  private hostCryptoValue: HostCrypto | null = null;
  private readonly connections = new Set<Connection>();
  private readonly byDevice = new Map<string, Connection>();
  /** `reply` 去重：每台设备最近 10 分钟的 requestId → 首次调用的 Promise（并发重发也只开一轮） */
  private readonly replyDedup = new Map<string, Map<string, { at: number; outcome: Promise<ReplySubmit> }>>();
  private listenError: string | null = null;
  private loopMonitor: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private loopTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(deps: MobileServerDeps) {
    this.deps = deps;
  }

  /** 配对提议簿（设置页「生成配对码」用它）；主机密钥 ensure 之后才有 */
  pairingBook(): PairingBook | null {
    return this.pairing;
  }

  /** 按设置起监听；起不来把原因记进 `listenError`（设置页如实显示），不静默换地址 */
  async start(hostCrypto: HostCrypto): Promise<void> {
    await this.stop();
    this.stopping = false;
    const state = await this.deps.store.read();
    if (!state.enabled || state.bind === null) return;
    this.pairing = new PairingBook({
      now: this.deps.now,
      hostBoxPublic: hostCrypto.publicRaw,
      derivePinKey: this.deps.derivePinKey,
    });
    this.hostCryptoValue = hostCrypto;
    this.listenError = null;

    const wss = new WebSocketServer({
      host: state.bind.address,
      port: state.bind.port,
      path: MOBILE_PATH,
      maxPayload: MOBILE_FRAME_MAX_BYTES,
      perMessageDeflate: false,
      verifyClient: (info, cb) => this.verifyClient(info, cb),
    });
    this.server = wss;
    wss.on("error", (cause: NodeJS.ErrnoException) => {
      if (this.server !== wss) return;
      // 地址不在本机（换了网络 / Tailscale 断了）、端口被占：如实记下，设置页显示
      // 设置页只显示用户的话：Node 的原文（listen EADDRINUSE: address already in use …）只进下面那行日志
      this.listenError =
        cause.code === "EADDRNOTAVAIL"
          ? "这个地址现在不在本机上"
          : cause.code === "EADDRINUSE"
            ? `端口 ${state.bind?.port} 被别的程序占着，换一个端口。`
            : "没能在这个地址和端口上接手机的连接，换一个端口或地址再试。详细原因在电脑的日志里。";
      this.deps.log?.(`[mobile] 监听失败（${state.bind?.address}:${state.bind?.port}）：${cause.message}`);
    });
    wss.on("listening", () => {
      if (this.server !== wss) return;
      this.listenError = null;
      this.deps.log?.(`[mobile] 手机服务监听中：${state.bind?.address}:${state.bind?.port}${MOBILE_PATH}`);
    });
    wss.on("connection", (socket, request) => {
      try {
        this.onConnection(socket, request);
      } catch (cause) {
        console.error("[mobile] 新连接的处理出错", cause);
        socket.terminate();
      }
    });
    // start 返回时设置页看到的就是真状态：要么已经 listening，要么 error 已记下
    await new Promise<void>((resolve) => {
      wss.once("listening", () => resolve());
      wss.once("error", () => resolve());
    });
  }

  /** 启动 / 启用失败（例如系统密钥库不可用）：设置页仍能拿到原因 */
  reportError(message: string): void {
    this.listenError = message;
  }

  /** 停监听：给每台在线手机发 `host.shutdown`，关服务器。设置里的开关不动 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.listenError = null;
    this.stopLoopMonitor();
    const server = this.server;
    this.server = null;
    this.pairing?.cancel();
    this.pairing = null;
    this.hostCryptoValue = null;
    for (const conn of [...this.connections]) {
      if (conn.deviceId !== null) this.sendNotification(conn, "host.shutdown", {});
      this.terminate(conn);
    }
    this.byDevice.clear();
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 没有连接时 close 立刻回；有连接时被 terminate 完也会回
        setTimeout(resolve, 1_000).unref?.();
      });
    }
  }

  /** 设置页用：此刻的 MobileSettings（合并落盘状态、现算的候选、监听的真实状态） */
  async settings(candidates: MobileSettings["candidates"]): Promise<MobileSettings> {
    const state = await this.deps.store.read();
    return mobileSettingsOf(state, candidates, this.server !== null && this.listenError === null, this.listenError);
  }

  /** 在线状态（设备列表用） */
  isConnected(deviceId: string): boolean {
    return this.byDevice.has(deviceId);
  }

  /**
   * 撤销一台设备（安全审查第 5 条的顺序）：先断连接（terminate，不等关闭握手），
   * 再清它排着的回复，最后落盘删记录——之后的 hello 解不开，因为表里没它了。
   */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.deps.store.removeDevice(deviceId, async () => {
      // store 已先删内存：从这里开始，新 hello 与异步应答都查不到这台设备
      const conn = this.byDevice.get(deviceId);
      if (conn !== undefined) this.terminate(conn);
      this.byDevice.delete(deviceId);
      await this.deps.replies.cancelForSource(deviceId, { code: "unauthorized", message: "这台设备已被电脑忘掉" });
    });
  }

  /** 回执出口（ReplyQueue 的观察者调）：发给发起它的那台设备；不在线就丢（断线不补发） */
  notifyReply(event: "reply.sent" | "reply.failed", deviceId: string, params: MobileNotifications["reply.sent"] | MobileNotifications["reply.failed"]): void {
    const conn = this.byDevice.get(deviceId);
    if (conn === undefined) return;
    this.sendNotification(conn, event, params);
  }

  // ———————————————————— 连接生命周期 ————————————————————

  /** 握手时的门槛（安全审查第 4 条）：路径、Origin、连接数上限 */
  private verifyClient(info: { origin: string; req: IncomingMessage }, cb: (result: boolean, code?: number, message?: string) => void): void {
    // 浏览器网页能跨源连 WebSocket：带 Origin 的一律拒（手机端是原生 app，不带）
    if (info.origin !== undefined && info.origin !== "") {
      cb(false, 403, "Forbidden");
      return;
    }
    if (this.connections.size >= MOBILE_CRYPTO.maxConnections) {
      cb(false, 503, "Too Many Connections");
      return;
    }
    const unauthenticated = [...this.connections].filter((conn) => conn.deviceId === null).length;
    if (unauthenticated >= MOBILE_CRYPTO.maxUnauthenticatedConnections) {
      cb(false, 503, "Too Many Connections");
      return;
    }
    cb(true);
  }

  private onConnection(socket: WebSocket, request: IncomingMessage): void {
    const crypto = this.hostCryptoValue;
    if (crypto === null || this.stopping) {
      socket.terminate();
      return;
    }
    const conn: Connection = {
      socket,
      address: request.socket.remoteAddress ?? "",
      channel: new SecureChannel(crypto.privateKey),
      deviceId: null,
      offeredOfferId: null,
      provenDeviceId: null,
      handshakeTimer: null,
      pingTimer: null,
      aliveAt: this.deps.now(),
      frames: [],
      sentBytes: 0,
      sentWindowStart: this.deps.now(),
      unwatchCatalog: null,
      unwatchTails: new Map(),
      closed: false,
    };
    this.connections.add(conn);
    // 10 秒内没过握手就断
    conn.handshakeTimer = setTimeout(() => {
      if (conn.deviceId === null) this.terminate(conn);
    }, MOBILE_CRYPTO.handshakeTimeoutMs);

    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      try {
        // 线上只认 UTF-8 JSON 文本帧；二进制没有协议含义
        if (isBinary) {
          this.terminate(conn);
          return;
        }
        this.onMessage(conn, data);
      } catch (cause) {
        // 主进程没有 uncaughtException 兜底：一处抛错整个应用退出，必须在这里接住
        console.error("[mobile] 处理一帧时出错", cause);
        this.terminate(conn);
      }
    });
    socket.on("pong", () => {
      conn.aliveAt = this.deps.now();
    });
    socket.on("close", () => this.cleanup(conn));
    socket.on("error", (cause) => {
      console.error("[mobile] 连接出错", cause);
      this.terminate(conn);
    });

    this.sendPlain(conn, conn.channel.hostHello());
  }

  private cleanup(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    if (conn.handshakeTimer !== null) clearTimeout(conn.handshakeTimer);
    if (conn.pingTimer !== null) clearInterval(conn.pingTimer);
    conn.unwatchCatalog?.();
    for (const unwatch of conn.unwatchTails.values()) unwatch();
    conn.unwatchTails.clear();
    this.connections.delete(conn);
    if (conn.deviceId !== null && this.byDevice.get(conn.deviceId) === conn) {
      this.byDevice.delete(conn.deviceId);
    }
    if (this.byDevice.size === 0) this.stopLoopMonitor();
  }

  private terminate(conn: Connection): void {
    this.cleanup(conn);
    conn.socket.terminate();
  }

  // ———————————————————— 帧处理 ————————————————————

  private onMessage(conn: Connection, data: Buffer | ArrayBuffer | Buffer[]): void {
    conn.aliveAt = this.deps.now();
    const now = this.deps.now();
    conn.frames = conn.frames.filter((at) => now - at < 1_000);
    conn.frames.push(now);
    if (conn.frames.length > FRAME_LIMIT) {
      this.terminate(conn);
      return;
    }
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const parsed = parseInboundFrame(buf.toString("utf8"));
    if (!parsed.ok) {
      // 明文段给一句带错误码的应答再断（手机联调时好看）；加密段的错帧直接断
      if (conn.deviceId === null) this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: 0, ok: false, error: parsed.error });
      this.terminate(conn);
      return;
    }
    const frame = parsed.value;
    if (conn.deviceId === null) {
      void this.onClearFrame(conn, frame).catch((cause: unknown) => {
        console.error("[mobile] 明文帧的处理出错", cause);
        this.terminate(conn);
      });
      return;
    }
    if (isSealedFrame(frame)) {
      const plaintext = conn.channel.openInbound(frame);
      if (plaintext === null) {
        // 解不开 / 跳号 / 重号：按协议断开
        this.terminate(conn);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(plaintext);
      } catch {
        this.sendSealed(conn, errorReply(0, "bad_request", "frame is not JSON"));
        return;
      }
      const request = parseRequest(raw);
      if (!request.ok) {
        this.sendSealed(conn, errorReply(0, request.error.code, request.error.message));
        return;
      }
      void this.dispatch(conn, request.value).catch((cause: unknown) => {
        console.error("[mobile] 方法执行出错", cause);
        this.sendSealed(conn, errorReply(request.value.id, "internal", "电脑这边出了点错"));
      });
      return;
    }
    // 已认出设备之后再来明文帧：协议不允许，断
    this.terminate(conn);
  }

  /** 明文段的三种帧：pair.start / pair.prove / hello */
  private async onClearFrame(conn: Connection, frame: InboundFrame): Promise<void> {
    if (isSealedFrame(frame)) {
      this.terminate(conn);
      return;
    }
    if (frame.type === "pair.start") {
      if (this.pairing === null || !this.pairing.admitStart(conn.address)) {
        this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: frame.id, ok: false, error: { code: "busy", message: "配对请求太频繁了，等一分钟再来" } });
        return;
      }
      const offer = this.pairing.currentOfferWire();
      if (offer === null) {
        this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: frame.id, ok: false, error: { code: "unavailable", message: "配对码还没生成——在电脑的设置里点「生成配对码」" } });
        return;
      }
      conn.offeredOfferId = offer.offerId;
      this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: frame.id, ok: true, result: offer });
      return;
    }
    if (frame.type === "pair.prove") {
      await this.onPairProve(conn, frame);
      return;
    }
    // hello
    await this.onHello(conn, frame);
  }

  private async onPairProve(conn: Connection, frame: PairProveFrame): Promise<void> {
    const book = this.pairing;
    // 必须先发过 pair.start（同一条连接）：旁听的第三方不能拿录下的证明换条连接登记孤儿设备
    if (book === null || conn.offeredOfferId === null || conn.offeredOfferId !== frame.params.offerId) {
      this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: frame.id, ok: false, error: { code: "unauthorized", message: "先在这条连接上要配对提议" } });
      this.terminate(conn);
      return;
    }
    const deviceId = randomBytes(16).toString("hex");
    const verdict = book.prove(frame, deviceId);
    if (!verdict.ok) {
      this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: frame.id, ok: false, error: verdict.error });
      return;
    }
    await this.deps.store.addDevice({
      id: deviceId,
      name: frame.params.deviceName,
      boxPublic: verdict.deviceBoxPublic.toString("base64"),
      pairedAt: this.deps.now(),
      lastSeenAt: null,
    });
    if (conn.closed) return;
    conn.provenDeviceId = deviceId;
    const result = { deviceId, hostProof: verdict.hostProof.toString("base64"), host: { name: this.deps.hostName(), protocol: MOBILE_PROTOCOL_VERSION } };
    this.sendPlain(conn, { v: MOBILE_PROTOCOL_VERSION, id: frame.id, ok: true, result });
  }

  private async onHello(conn: Connection, frame: HelloFrame): Promise<void> {
    // 这条连接刚配过对：只收那台设备的 hello
    if (conn.provenDeviceId !== null && conn.provenDeviceId !== frame.d) {
      this.terminate(conn);
      return;
    }
    const device = await this.deps.store.device(frame.d);
    if (conn.closed) return;
    const body = conn.channel.acceptHello(
      frame,
      device === null ? null : { id: device.id, boxPublic: Buffer.from(device.boxPublic, "base64") },
    );
    if (body === null) {
      this.terminate(conn);
      return;
    }
    const previous = this.byDevice.get(frame.d);
    if (previous === undefined && this.byDevice.size >= MOBILE_CRYPTO.maxOnlineDevices) {
      this.terminate(conn);
      return;
    }
    conn.deviceId = frame.d;
    if (conn.handshakeTimer !== null) clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = null;
    // 一台设备只留一条连接：重连顶掉旧的（手机换了网络，旧连接多半已经半死）
    if (previous !== undefined && previous !== conn) this.terminate(previous);
    this.byDevice.set(frame.d, conn);
    void this.deps.store.touchDevice(frame.d, this.deps.now()).catch(() => undefined);
    if (body.name !== undefined) void this.deps.store.renameDevice(frame.d, body.name).catch(() => undefined);
    const reply: ClearReply<HelloResult> = {
      v: MOBILE_PROTOCOL_VERSION,
      id: frame.id,
      ok: true,
      result: { host: { name: this.deps.hostName(), protocol: MOBILE_PROTOCOL_VERSION }, protocol: MOBILE_PROTOCOL_VERSION },
    };
    this.sendPlain(conn, conn.channel.sealHandshakeReply(reply, frame.d));
    conn.pingTimer = setInterval(() => {
      if (this.deps.now() - conn.aliveAt > MOBILE_CRYPTO.idleTimeoutMs) {
        this.terminate(conn);
        return;
      }
      conn.socket.ping();
    }, MOBILE_CRYPTO.heartbeatMs);
    this.startLoopMonitor();
  }

  // ———————————————————— 十个方法 ————————————————————

  private async dispatch(conn: Connection, request: MobileRequest): Promise<void> {
    const deviceId = conn.deviceId;
    if (deviceId === null) return;
    const reply = await this.runMethod(conn, deviceId, request);
    this.sendSealed(conn, reply);
  }

  private async runMethod(conn: Connection, deviceId: string, request: MobileRequest): Promise<MobileReply> {
    const id = request.id;
    switch (request.method) {
      case "ping":
        return okReply(id, { now: this.deps.now() });
      case "sessions.list": {
        if (!this.admit(deviceId, "sessions.list")) return errorReply(id, "busy", "清单刷得太勤了，两秒一次");
        const result = await this.deps.catalog.list();
        return okReply(id, result);
      }
      case "sessions.watch": {
        conn.unwatchCatalog ??= this.deps.catalog.subscribe((changed, removed) => {
          this.sendNotification(conn, "sessions.changed", { sessions: changed, removed });
        });
        return okReply(id, null);
      }
      case "sessions.unwatch": {
        conn.unwatchCatalog?.();
        conn.unwatchCatalog = null;
        return okReply(id, null);
      }
      case "tail.load": {
        if (!this.admit(deviceId, "tail.load")) return errorReply(id, "busy", "翻得太勤了");
        if (!this.deps.catalog.snapshotIds().has(request.params.sessionId)) {
          return errorReply(id, "not_found", "这条任务不在你的清单里");
        }
        const page = await this.deps.tails.load(request.params.sessionId, request.params.before);
        if (page === null) return errorReply(id, "not_found", "没找到这个位置，重新拉一次尾部");
        // 手机已经打开这条会话：本次运行的「刚跑完」不再继续算没看过（meta 未读另有 unread.clear）
        this.deps.catalog.clearSettled(request.params.sessionId);
        return okReply(id, page);
      }
      case "tail.watch": {
        const sessionId = request.params.sessionId;
        if (!this.deps.catalog.snapshotIds().has(sessionId)) return errorReply(id, "not_found", "这条任务不在你的清单里");
        if (!conn.unwatchTails.has(sessionId)) {
          if (conn.unwatchTails.size >= MOBILE_CRYPTO.methodLimits["tail.watch"][0]) {
            return errorReply(id, "busy", "同时看的任务太多了");
          }
          conn.unwatchTails.set(
            sessionId,
            this.deps.tails.watch(sessionId, (watchedId, rev) => {
              this.sendNotification(conn, "tail.changed", { sessionId: watchedId, rev });
            }),
          );
        }
        this.deps.catalog.clearSettled(sessionId);
        return okReply(id, null);
      }
      case "tail.unwatch": {
        const unwatch = conn.unwatchTails.get(request.params.sessionId);
        if (unwatch !== undefined) {
          unwatch();
          conn.unwatchTails.delete(request.params.sessionId);
        }
        return okReply(id, null);
      }
      case "reply": {
        const { sessionId, text, requestId } = request.params;
        // 去重（安全审查第 7 条）：断线重连的手机会重发同一条；10 分钟内回上次的结果
        const seen = this.dedup(deviceId).get(requestId);
        if (seen !== undefined && this.deps.now() - seen.at < MOBILE_CRYPTO.replyDedupMs) {
          const previous = await seen.outcome;
          return "error" in previous
            ? errorReply(id, previous.error.code, previous.error.message)
            : okReply(id, { queued: previous.queued, position: previous.position });
        }
        if (!this.deps.catalog.snapshotIds().has(sessionId)) return errorReply(id, "not_found", "这条任务不在你的清单里");
        if (!this.admit(deviceId, "reply")) return errorReply(id, "busy", "回得太勤了，歇一分钟");
        // Promise 在第一次调用时就进表：两帧背靠背到达也不会各自开一轮
        const pending = this.deps.replies.submit(sessionId, { requestId, text, source: deviceId });
        this.dedup(deviceId).set(requestId, { at: this.deps.now(), outcome: pending });
        let outcome: ReplySubmit;
        try {
          outcome = await pending;
        } catch (cause) {
          this.dedup(deviceId).delete(requestId);
          throw cause;
        }
        return "error" in outcome
          ? errorReply(id, outcome.error.code, outcome.error.message)
          : okReply(id, { queued: outcome.queued, position: outcome.position });
      }
      case "stop": {
        const sessionId = request.params.sessionId;
        if (!this.deps.catalog.snapshotIds().has(sessionId)) return errorReply(id, "not_found", "这条任务不在你的清单里");
        // 停止 = 停当前这一轮 + 清掉手机里排的队。只对「在跑或有待发」的调 abort——
        // 对空闲会话调它会白白拉起 agent 进程（abort 先 ensure()）
        await this.deps.replies.cancel(sessionId, { code: "unavailable", message: "你按了停止，这句话没有发出去" });
        if (this.deps.isRunning(sessionId) || this.deps.replies.pendingCount(sessionId) > 0) {
          await this.deps.abort(sessionId);
        }
        return okReply(id, null);
      }
      case "unread.clear": {
        const sessionId = request.params.sessionId;
        if (!this.deps.catalog.snapshotIds().has(sessionId)) return errorReply(id, "not_found", "这条任务不在你的清单里");
        await this.deps.setUnread(sessionId, null);
        this.deps.catalog.clearSettled(sessionId);
        // 桌面窗口要是开着，让它也知道 meta 变了
        this.deps.metaChanged(sessionId);
        return okReply(id, null);
      }
    }
  }

  /** 每台设备各方法的重活限速（契约的 methodLimits） */
  private readonly methodHits = new Map<string, number[]>();

  private admit(deviceId: string, method: MobileMethod): boolean {
    const limit = MOBILE_CRYPTO.methodLimits[method as keyof typeof MOBILE_CRYPTO.methodLimits] as readonly [number, number] | undefined;
    if (limit === undefined) return true;
    const [count, windowMs] = limit;
    if (!Number.isFinite(windowMs)) return true; // tail.watch 的并发上限在 dispatch 里管
    const key = `${deviceId}${method}`;
    const now = this.deps.now();
    const hits = (this.methodHits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (hits.length >= count) {
      this.methodHits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.methodHits.set(key, hits);
    return true;
  }

  /** `reply` 的去重表（每台设备一张，顺手清过期的）。存的是 Promise：两帧背靠背到达也只会开一轮 */
  private dedup(deviceId: string): Map<string, { at: number; outcome: Promise<ReplySubmit> }> {
    let table = this.replyDedup.get(deviceId);
    if (table === undefined) {
      table = new Map();
      this.replyDedup.set(deviceId, table);
    }
    const now = this.deps.now();
    for (const [key, entry] of table) {
      if (now - entry.at >= MOBILE_CRYPTO.replyDedupMs) table.delete(key);
    }
    return table;
  }

  // ———————————————————— 出站 ————————————————————

  private sendPlain(conn: Connection, frame: unknown): void {
    if (conn.closed || conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify(frame));
  }

  /** 加密段的出站：取号与密封在同一个同步函数里（`sealOutbound`），拿到就发 */
  private sendSealed(conn: Connection, payload: unknown): void {
    if (conn.closed || conn.deviceId === null) return;
    const plaintext = JSON.stringify(payload);
    const bytes = Buffer.byteLength(plaintext, "utf8");
    if (bytes > MOBILE_OUTBOUND_FRAME_MAX_BYTES) {
      console.error(`[mobile] 一帧出站超了 ${MOBILE_OUTBOUND_FRAME_MAX_BYTES} 字节（${bytes}），没发`);
      return;
    }
    // 出站预算：超太多就断（安全审查第 6 条：不攒到天上去）
    const now = this.deps.now();
    if (now - conn.sentWindowStart >= 1_000) {
      conn.sentWindowStart = now;
      conn.sentBytes = 0;
    }
    conn.sentBytes += bytes;
    if (conn.sentBytes > MOBILE_CRYPTO.outboundBytesPerSecond * 2) {
      console.error("[mobile] 出站超预算，断开");
      this.terminate(conn);
      return;
    }
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    conn.socket.send(JSON.stringify(conn.channel.sealOutbound(plaintext)));
  }

  private sendNotification<E extends keyof MobileNotifications>(
    conn: Connection,
    event: E,
    params: MobileNotifications[E],
  ): void {
    this.sendSealed(conn, mobileNotification(event, params));
  }

  // ———————————————————— 事件循环延迟诊断 ————————————————————

  /** 有手机连着时每 10 秒记一次主进程事件循环延迟的分位数（验收要拿这个数） */
  private startLoopMonitor(): void {
    if (this.loopTimer !== null) return;
    this.loopMonitor = monitorEventLoopDelay({ resolution: 1 });
    this.loopMonitor.enable();
    this.loopTimer = setInterval(() => {
      const histogram = this.loopMonitor;
      if (histogram === null) return;
      const toMs = (ns: number): string => (ns / 1e6).toFixed(1);
      this.deps.log?.(
        `[mobile] 主进程事件循环延迟（手机连着 ${this.byDevice.size} 台）：p50=${toMs(histogram.percentile(50))}ms p99=${toMs(histogram.percentile(99))}ms max=${toMs(histogram.max)}ms`,
      );
      histogram.reset();
    }, 10_000);
    this.loopTimer.unref?.();
  }

  private stopLoopMonitor(): void {
    if (this.loopTimer !== null) clearInterval(this.loopTimer);
    this.loopTimer = null;
    this.loopMonitor?.disable();
    this.loopMonitor = null;
  }
}
