/**
 * 一条 WebSocket 连接的薄封装：文本帧进出、按到达顺序取帧、超时、关闭只发生一次。
 *
 * 不直接 new WebSocket：生产里用 React Native 自带的（见 `rn-socket.ts`：要把 Origin 头写成空），
 * Node 测试里用 Node 自带的全局 WebSocket，连真的电脑侧服务对拍。
 */

/** React Native 与 Node 的 WebSocket 共有的那一小块 */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

/** WebSocket 的 OPEN 常量（两边都是 1） */
const OPEN = 1;

export class FrameSocket {
  private readonly socket: SocketLike;
  private readonly queue: string[] = [];
  private waiter: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  private closedError: Error | null = null;
  private readonly closeListeners: ((error: Error) => void)[] = [];
  private messageListener: ((text: string) => void) | null = null;

  private constructor(socket: SocketLike) {
    this.socket = socket;
    socket.onmessage = (event) => {
      // 线上只有文本帧；别的类型当成协议错误
      if (typeof event.data !== "string") {
        this.fail(new Error("binary frame"));
        return;
      }
      if (this.messageListener !== null) {
        this.messageListener(event.data);
        return;
      }
      const waiter = this.waiter;
      if (waiter !== null) {
        this.waiter = null;
        waiter.resolve(event.data);
      } else {
        this.queue.push(event.data);
      }
    };
    socket.onclose = () => this.fail(new Error("closed"));
    socket.onerror = () => this.fail(new Error("socket error"));
  }

  /** 连上（或在 `timeoutMs` 内连不上就失败） */
  static open(factory: SocketFactory, url: string, timeoutMs: number): Promise<FrameSocket> {
    return new Promise((resolve, reject) => {
      let socket: SocketLike;
      try {
        socket = factory(url);
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
        return;
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.onopen = socket.onclose = socket.onerror = null;
        try {
          socket.close();
        } catch {
          // 关不掉也不要紧：本来就没连上
        }
        reject(new Error("connect timeout"));
      }, timeoutMs);
      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new FrameSocket(socket));
      };
      const failed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("connect failed"));
      };
      socket.onerror = failed;
      socket.onclose = failed;
    });
  }

  get isOpen(): boolean {
    return this.closedError === null && this.socket.readyState === OPEN;
  }

  /** 下一帧；`timeoutMs` 内没来就失败（连接照样留着，由调用方决定关不关） */
  next(timeoutMs: number): Promise<string> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closedError !== null) return Promise.reject(this.closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === done) this.waiter = null;
        reject(new Error("frame timeout"));
      }, timeoutMs);
      const done = (text: string) => {
        clearTimeout(timer);
        resolve(text);
      };
      this.waiter = {
        resolve: done,
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  /** 从此改成推送：每来一帧调一次（排着的先吐出来）。握手完、进加密段之后用 */
  listen(listener: (text: string) => void): void {
    this.messageListener = listener;
    for (const text of this.queue.splice(0)) listener(text);
  }

  onClose(listener: (error: Error) => void): void {
    if (this.closedError !== null) listener(this.closedError);
    else this.closeListeners.push(listener);
  }

  send(text: string): boolean {
    if (!this.isOpen) return false;
    this.socket.send(text);
    return true;
  }

  close(): void {
    this.fail(new Error("closed by phone"));
  }

  private fail(error: Error): void {
    if (this.closedError !== null) return;
    this.closedError = error;
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    try {
      this.socket.close();
    } catch {
      // 已经断了
    }
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
    for (const listener of this.closeListeners.splice(0)) listener(error);
  }
}

/** `ws://地址:端口/orbita`；IPv6 字面量加方括号 */
export function hostUrl(address: string, port: number, path: string): string {
  const host = address.includes(":") ? `[${address}]` : address;
  return `ws://${host}:${port}${path}`;
}
