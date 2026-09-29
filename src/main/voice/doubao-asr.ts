/**
 * 豆包听写连接的生命周期（主进程）。帧格式在 doubao-protocol.ts；这里管：连上 → 转发音频 →
 * 把识别结果推给发起的窗口 → 收尾。socket 与「连不上时问一句为什么」都是注入的，
 * 生产用 undici（socket.ts），测试用替身——本模块不 import electron。
 *
 * 连接生命周期（开 / 转发 / 收尾 / 按窗口回收）本身与厂商无关，只有帧格式与请求头是豆包的。
 * 第二家听写厂商接入时，把帧的两头（首帧、音频帧、解析）抽成厂商接口，这个类就是共用的那部分——
 * 现在只有一家，不先抽（AGENTS.md：没有第二个消费者不建抽象层）。
 *
 * 为什么连不上要另问一句：WebSocket 握手被拒时（401 / 403），浏览器式 WebSocket 只给一个
 * 没有状态码的 error，分不清「凭证不对」和「网断了」。所以失败后再用同样的请求头发一次普通
 * HTTPS GET，服务端会回状态码与一句 JSON 原因（如 `load grant: requested grant not found`）。
 */
import { randomUUID } from "node:crypto";
import type { DictationEvent, VoiceFailure, VoiceResult } from "../../shared/voice.ts";
import { ASR_ENDPOINT, audioFrame, parseServerFrame, startFrame } from "./doubao-protocol.ts";

export interface DoubaoCredentials {
  appId: string;
  accessToken: string;
  resourceId: string;
}

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: Uint8Array): void;
  onClose(): void;
  onError(): void;
}

/** 一条 WebSocket 里我们用得上的部分 */
export interface AsrSocket {
  send(data: Uint8Array): void;
  close(): void;
}

export type OpenSocket = (url: string, headers: Record<string, string>, handlers: SocketHandlers) => AsrSocket;

/** 连不上之后问原因：同样的请求头发一次普通 GET，按状态码归类 */
export type Diagnose = (url: string, headers: Record<string, string>) => Promise<VoiceFailure>;

export interface DoubaoAsrDeps {
  openSocket: OpenSocket;
  diagnose: Diagnose;
  /** 连接超时（默认 10 秒） */
  connectTimeoutMs?: number;
  /** 发出最后一包后等服务端收尾的上限（默认 5 秒）；到点强关 */
  stopTimeoutMs?: number;
}

interface Session {
  owner: number;
  /** openSocket 回来之前是个空壳：握手前的回调也能安全地调 close */
  socket: AsrSocket;
  emit: (event: DictationEvent) => void;
  /** 已经结束（关了、出错、被取消）：之后的事件一律不再推 */
  done: boolean;
  /** 连接真正关掉时兑现；stop 等它 */
  closed: Promise<void>;
}

export function doubaoHeaders(credentials: DoubaoCredentials): Record<string, string> {
  return {
    "X-Api-App-Key": credentials.appId,
    "X-Api-Access-Key": credentials.accessToken,
    "X-Api-Resource-Id": credentials.resourceId,
    "X-Api-Connect-Id": randomUUID(),
  };
}

export class DoubaoAsr {
  private readonly deps: DoubaoAsrDeps;
  private readonly sessions = new Map<string, Session>();

  constructor(deps: DoubaoAsrDeps) {
    this.deps = deps;
  }

  /**
   * 开一条连接。连上（并发出第一帧）才回 ok；连不上回原因，不抛。
   * owner 是发起窗口的 webContents id：窗口没了，cancelOwner 收掉它的连接。
   */
  start(
    sessionId: string,
    owner: number,
    credentials: DoubaoCredentials,
    emit: (event: DictationEvent) => void,
  ): Promise<VoiceResult> {
    this.cancel(sessionId);
    const headers = doubaoHeaders(credentials);
    return new Promise<VoiceResult>((resolve) => {
      let opened = false;
      let settled = false;
      let diagnosing = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let markClosed: () => void = () => undefined;
      const session: Session = {
        owner,
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
          .diagnose(ASR_ENDPOINT, headers)
          .catch((): VoiceFailure => ({ reason: "network" }))
          .then(fail);
      };
      this.sessions.set(sessionId, session);
      timer = setTimeout(() => fail({ reason: "timeout" }), this.deps.connectTimeoutMs ?? 10_000);
      session.socket = this.deps.openSocket(ASR_ENDPOINT, headers, {
        onOpen: () => {
          if (settled) return;
          opened = true;
          settled = true;
          clearTimeout(timer);
          session.socket.send(startFrame("orbita"));
          resolve({ ok: true });
        },
        onMessage: (data) => {
          if (session.done) return;
          const message = parseServerFrame(data);
          if (message === null) return;
          if (message.kind === "result") {
            emit({ sessionId, kind: "transcript", text: message.text, final: message.final });
            return;
          }
          this.finish(sessionId, session);
          emit({ sessionId, kind: "error", reason: "server", detail: `${message.code} ${message.message}` });
          session.socket.close();
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
    session.socket.send(audioFrame(pcm, false));
  }

  /**
   * 说完了：发最后一包，等服务端给出最终结果并关掉连接（它会先推 final 结果再关）。
   * 服务端迟迟不关就到点强关——回来的时候，能推的结果都已经推过了。
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.done) return;
    session.socket.send(audioFrame(new Uint8Array(), true));
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
  async test(credentials: DoubaoCredentials): Promise<VoiceResult> {
    const sessionId = `test-${randomUUID()}`;
    const result = await this.start(sessionId, -1, credentials, () => undefined);
    this.cancel(sessionId);
    return result;
  }

  private finish(sessionId: string, session: Session): void {
    session.done = true;
    if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
  }
}
