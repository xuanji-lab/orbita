/**
 * 听写连接的生命周期（主进程），与厂商无关：连上 → 发厂商的开场帧 → 转发音频 → 把识别
 * 结果推给发起的窗口 → 收尾。厂商差异全部收在 `DictationProtocol`（一条连接一个实例）里——
 * 豆包是二进制帧（doubao-protocol.ts）、阶跃星辰是 JSON 文本（stepfun-protocol.ts），这里的
 * 生命周期只认 `OutboundFrame` 与 `ProtocolEvent`。socket 与「连不上时问一句为什么」都是注入
 * 的，生产用 undici（socket.ts），测试用替身——本模块不 import electron。
 *
 * 为什么连不上要另问一句：WebSocket 握手被拒时（401 / 403），浏览器式 WebSocket 只给一个
 * 没有状态码的 error，分不清「凭证不对」和「网断了」。所以失败后再用同样的请求头发一次普通
 * HTTPS GET，服务端会回状态码与一句 JSON 原因（豆包 `load grant: requested grant not found`、
 * 阶跃 `Incorrect API key provided`——两家都吃这一套，2026-10 实测）。
 */
import { randomUUID } from "node:crypto";
import type { DictationEvent, VoiceFailure, VoiceResult } from "../../shared/voice.ts";

/** 一条出站消息：豆包是二进制帧，阶跃是 JSON 文本 */
export type OutboundFrame = { kind: "bytes"; data: Uint8Array } | { kind: "text"; data: string };

/**
 * 线协议对一条入站消息的判定，按发生顺序给（可以一条消息带两个：阶跃收尾时最后一句定稿
 * 的 completed 既是最终文字又是「可以关连接了」）。空数组 = 不认识，丢掉。
 */
export type ProtocolEvent =
  /** 这条连接到目前为止的全量文字（final = 服务端说这是定稿） */
  | { kind: "transcript"; text: string; final: boolean }
  /** 厂商侧这条连接到此为止（阶跃的空闲超时、收尾完成）：按正常结束收尾，renderer 会重连 */
  | { kind: "ended" }
  | { kind: "error"; failure: VoiceFailure };

/**
 * 厂商线协议：**一条听写连接一个实例**（阶跃要跨消息按 item 拼句，是有状态的；豆包恰好
 * 无状态也走同一个形状）。生命周期模块在 start 时收一个、存在 session 上。
 */
export interface DictationProtocol {
  /** WebSocket 地址 */
  readonly url: string;
  /** 握手请求头（鉴权在这里） */
  readonly headers: Record<string, string>;
  /** 连上后立刻发的一条（豆包的完整请求首帧 / 阶跃的 session.update） */
  openFrame(): OutboundFrame;
  /** 一段 PCM（16 kHz / 16 bit / 单声道）转成厂商的帧 */
  audioFrame(pcm: Uint8Array): OutboundFrame;
  /** 说完了：最后一条（豆包的空尾包 / 阶跃的 commit）。发出即进入收尾，协议可据此改变判定 */
  stopFrame(): OutboundFrame;
  /** 服务端一条消息（豆包二进制 / 阶跃文本）→ 判定列表 */
  inbound(data: Uint8Array | string): ProtocolEvent[];
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array | string): void;
  onClose(): void;
  onError(): void;
}

/** 一条 WebSocket 里我们用得上的部分 */
export interface AsrSocket {
  send(frame: OutboundFrame): void;
  close(): void;
}

export type OpenSocket = (url: string, headers: Record<string, string>, handlers: SocketHandlers) => AsrSocket;

/** 连不上之后问原因：同样的请求头发一次普通 GET，按状态码归类 */
export type Diagnose = (url: string, headers: Record<string, string>) => Promise<VoiceFailure>;

export interface DictationDeps {
  openSocket: OpenSocket;
  diagnose: Diagnose;
  /** 连接超时（默认 10 秒） */
  connectTimeoutMs?: number;
  /** 发出收尾帧后等服务端收尾的上限（默认 5 秒）；到点强关 */
  stopTimeoutMs?: number;
}

interface Session {
  owner: number;
  protocol: DictationProtocol;
  /** openSocket 回来之前是个空壳：握手前的回调也能安全地调 close */
  socket: AsrSocket;
  emit: (event: DictationEvent) => void;
  /** 已经结束（关了、出错、被取消）：之后的事件一律不再推 */
  done: boolean;
  /** 连接真正关掉时兑现；stop 等它 */
  closed: Promise<void>;
}

export class DictationSessions {
  private readonly deps: DictationDeps;
  private readonly sessions = new Map<string, Session>();

  constructor(deps: DictationDeps) {
    this.deps = deps;
  }

  /**
   * 开一条连接。连上（并发出开场帧）才回 ok；连不上回原因，不抛。
   * owner 是发起窗口的 webContents id：窗口没了，cancelOwner 收掉它的连接。
   */
  start(
    sessionId: string,
    owner: number,
    protocol: DictationProtocol,
    emit: (event: DictationEvent) => void,
  ): Promise<VoiceResult> {
    this.cancel(sessionId);
    return new Promise<VoiceResult>((resolve) => {
      let opened = false;
      let settled = false;
      let diagnosing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let markClosed: () => void = () => undefined;
      const session: Session = {
        owner,
        protocol,
        socket: { send: () => undefined, close: () => undefined },
        emit,
        done: false,
        closed: new Promise<void>((done) => {
          markClosed = done;
        }),
      };
      const fail = (failure: VoiceFailure): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.finish(sessionId, session);
        session.socket.close();
        resolve({ ok: false, ...failure });
      };
      // 握手前的 error 与 close 往往前后脚都来：只问一次原因
      const failWithDiagnosis = (): void => {
        if (settled || diagnosing) return;
        diagnosing = true;
        void this.deps
          .diagnose(protocol.url, protocol.headers)
          .catch((): VoiceFailure => ({ reason: "network" }))
          .then(fail);
      };
      this.sessions.set(sessionId, session);
      timer = setTimeout(() => fail({ reason: "timeout" }), this.deps.connectTimeoutMs ?? 10_000);
      session.socket = this.deps.openSocket(protocol.url, protocol.headers, {
        onOpen: () => {
          if (settled) return;
          opened = true;
          settled = true;
          clearTimeout(timer);
          session.socket.send(protocol.openFrame());
          resolve({ ok: true });
        },
        onMessage: (data) => {
          if (session.done) return;
          for (const event of protocol.inbound(data)) {
            if (session.done) return;
            if (event.kind === "transcript") {
              emit({ sessionId, kind: "transcript", text: event.text, final: event.final });
              continue;
            }
            if (event.kind === "ended") {
              this.finish(sessionId, session);
              session.socket.close();
              emit({ sessionId, kind: "ended" });
              continue;
            }
            this.finish(sessionId, session);
            emit({ sessionId, kind: "error", ...event.failure });
            session.socket.close();
          }
        },
        onError: () => {
          if (!opened) {
            failWithDiagnosis();
            return;
          }
          if (session.done) return;
          this.finish(sessionId, session);
          emit({ sessionId, kind: "error", reason: "network" });
        },
        onClose: () => {
          markClosed();
          if (!opened) {
            failWithDiagnosis();
            return;
          }
          if (session.done) return;
          this.finish(sessionId, session);
          emit({ sessionId, kind: "ended" });
        },
      });
    });
  }

  /** 一段 PCM。连接不在了（刚结束、被取消）静默丢弃：renderer 那边可能还有几段在路上 */
  audio(sessionId: string, pcm: Uint8Array): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.done || pcm.byteLength === 0) return;
    session.socket.send(session.protocol.audioFrame(pcm));
  }

  /**
   * 说完了：发收尾帧，等服务端给出最终结果并关掉连接（豆包会先推 final 结果再关；阶跃的
   * 协议在收尾完成时给 `ended` 判定，这里收到就关）。服务端迟迟不收尾就到点强关——回来的
   * 时候，能推的结果都已经推过了。
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.done) return;
    session.socket.send(session.protocol.stopFrame());
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.closed,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.stopTimeoutMs ?? 5_000);
      }),
    ]);
    clearTimeout(timer);
    if (!session.done) {
      // 服务端没按时收尾：这条连接到此为止，按正常结束通知一次
      this.finish(sessionId, session);
      session.socket.close();
      session.emit({ sessionId, kind: "ended" });
    }
  }

  /** 放弃：立刻断开，不再推任何事件。幂等 */
  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.finish(sessionId, session);
    session.socket.close();
  }

  /** 发起的窗口没了：它的连接全部收掉 */
  cancelOwner(owner: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.owner === owner) this.cancel(sessionId);
    }
  }

  /** 设置页「测试连接」：连上就关，不发音频 */
  async test(protocol: DictationProtocol): Promise<VoiceResult> {
    const sessionId = `test-${randomUUID()}`;
    const result = await this.start(sessionId, -1, protocol, () => undefined);
    this.cancel(sessionId);
    return result;
  }

  private finish(sessionId: string, session: Session): void {
    session.done = true;
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
  }
}
