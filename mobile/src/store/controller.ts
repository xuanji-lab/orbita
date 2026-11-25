/**
 * app 的全部状态与动作（不依赖 React，屏幕用 `useSyncExternalStore` 订阅）。
 *
 * 一台手机只配一台电脑（第一刀）。三段：boot（读凭据）→ pair（配对页）→ main（清单 / 对话）。
 * main 里一条常驻连接（`Transport`，生产是 `HostLink`），每次连上：
 *   1. `sessions.list`（电脑的准入集合是这份清单——`tail.load` / `reply` / `stop` 都要先有它）；
 *   2. `sessions.watch`；
 *   3. 开着的那条对话：`tail.load` + `tail.watch`。
 * 断线期间清单与对话照旧显示（断线前的），状态饼退灰，输入框里的字留着、发送键不可用。
 */
import type {
  MobileMethod,
  MobileMethodParams,
  MobileNotification,
  MobileSessionState,
  SessionSummary,
} from "../../../src/shared/mobile.ts";
import { MOBILE_DEFAULT_PORT, MOBILE_LIMITS } from "../../../src/shared/mobile.ts";
import { toHex } from "../crypto/bytes.ts";
import { secureRandom } from "../crypto/primitives.ts";
import { applyReplyEvent, mergeLatest, mergeOlder, type PendingReply, type ReplyEvent, type TailState } from "../model/chat.ts";
import { applySessionsChanged } from "../model/list.ts";
import type { LinkStatus } from "../protocol/link.ts";
import { RequestError } from "../protocol/link.ts";
import type { Credentials, PairFailure, PairInput, PairOutcome } from "../protocol/pair.ts";
import { resultOf } from "../protocol/wire.ts";

/** 常驻连接的那一小块接口（生产是 HostLink，截图用的样例数据是 FixtureTransport） */
export interface Transport {
  start(): void;
  stop(): void;
  retryNow(): void;
  request<M extends MobileMethod>(method: M, params: MobileMethodParams[M]): Promise<unknown>;
}

export interface TransportCallbacks {
  onStatus(status: LinkStatus): void;
  onNotification(notification: MobileNotification): void;
  onOpen(): void;
}

export interface ControllerDeps {
  loadCredentials(): Promise<Credentials | null>;
  saveCredentials(credentials: Credentials): Promise<void>;
  clearCredentials(): Promise<void>;
  makeTransport(credentials: Credentials, callbacks: TransportCallbacks): Transport;
  pair(input: Omit<PairInput, "socketFactory">): Promise<PairOutcome>;
  deviceName: string;
  now(): number;
  log?(line: string): void;
}

export interface ChatSlot {
  tail: TailState | null;
  loading: boolean;
  loadingOlder: boolean;
  failed: boolean;
}

export type PairProblem = PairFailure | "badAddress";

export interface AppState {
  phase: "boot" | "pair" | "main";
  credentials: Credentials | null;
  pairing: { busy: boolean; progress: number | null; problem: PairProblem | null; address: string };
  link: LinkStatus;
  hostName: string;
  sessions: ReadonlyMap<string, SessionSummary>;
  listState: "loading" | "ready" | "failed";
  truncated: boolean;
  viewed: ReadonlySet<string>;
  openId: string | null;
  /** 打开那一刻的状态：未读清掉后电脑会把它推成 idle，顶栏仍写「跑完了」（只是不画饼） */
  openedState: MobileSessionState | null;
  chats: ReadonlyMap<string, ChatSlot>;
  replies: readonly PendingReply[];
  stopFailed: boolean;
}

const INITIAL: AppState = {
  phase: "boot",
  credentials: null,
  pairing: { busy: false, progress: null, problem: null, address: "" },
  link: { kind: "stopped" },
  hostName: "",
  sessions: new Map(),
  listState: "loading",
  truncated: false,
  viewed: new Set(),
  openId: null,
  openedState: null,
  chats: new Map(),
  replies: [],
  stopFailed: false,
};

/** 两次 `sessions.list` 至少隔多久（电脑的限速是 2 秒一次） */
const LIST_GAP_MS = 2_100;
/** `tail.changed` 攒多久再拉（电脑的 tail.load 限速 1 秒 2 次） */
const TAIL_DEBOUNCE_MS = 500;

/** 「地址」框里的写法：`主机` 或 `主机:端口`（IPv6 写成 `[::1]:47620`） */
export function parseAddress(text: string): { address: string; port: number } | null {
  const value = text.trim();
  if (value === "") return null;
  const bracket = /^\[([0-9a-fA-F:.]+)\](?::(\d{1,5}))?$/.exec(value);
  if (bracket !== null && bracket[1] !== undefined) return withPort(bracket[1], bracket[2]);
  const plain = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(value);
  if (plain === null || plain[1] === undefined) return null;
  if (plain[1].startsWith("-") || plain[1].startsWith(".")) return null;
  return withPort(plain[1], plain[2]);
}

function withPort(address: string, port: string | undefined): { address: string; port: number } | null {
  if (port === undefined) return { address, port: MOBILE_DEFAULT_PORT };
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? { address, port: n } : null;
}

export class AppController {
  private readonly deps: ControllerDeps;
  private stateValue: AppState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private transport: Transport | null = null;
  private lastListAt = 0;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private tailTimer: ReturnType<typeof setTimeout> | null = null;
  private watchedTail: string | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
  }

  // ———————————————————— 订阅 ————————————————————

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getState = (): AppState => this.stateValue;

  private set(patch: Partial<AppState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ———————————————————— 启动与配对 ————————————————————

  async boot(): Promise<void> {
    const credentials = await this.deps.loadCredentials();
    if (credentials === null) {
      this.set({ phase: "pair" });
      return;
    }
    this.enterMain(credentials);
  }

  async pair(addressText: string, code: string): Promise<void> {
    if (this.stateValue.pairing.busy) return;
    const target = parseAddress(addressText);
    const pairing = { busy: false, progress: null, problem: null, address: addressText.trim() };
    if (target === null) {
      this.set({ pairing: { ...pairing, problem: "badAddress" } });
      return;
    }
    this.set({ pairing: { ...pairing, busy: true } });
    const outcome = await this.deps.pair({
      address: target.address,
      port: target.port,
      code: code.replace(/\s+/g, ""),
      deviceName: this.deps.deviceName,
      now: this.deps.now,
      onProgress: (fraction) => {
        const percent = Math.floor(fraction * 100);
        if (percent !== this.stateValue.pairing.progress) this.set({ pairing: { ...this.stateValue.pairing, progress: percent } });
      },
    });
    if (!outcome.ok) {
      this.set({ pairing: { ...pairing, problem: outcome.reason } });
      return;
    }
    await this.deps.saveCredentials(outcome.credentials);
    this.set({ pairing: pairing });
    this.enterMain(outcome.credentials);
  }

  /** 电脑认不出这台手机了：丢掉凭据，回配对页 */
  async rePair(): Promise<void> {
    this.transport?.stop();
    this.transport = null;
    await this.deps.clearCredentials();
    this.stateValue = { ...INITIAL, phase: "pair", pairing: { ...INITIAL.pairing, address: this.stateValue.credentials?.address ?? "" } };
    for (const listener of this.listeners) listener();
  }

  private enterMain(credentials: Credentials): void {
    this.set({ phase: "main", credentials, hostName: credentials.hostName, listState: "loading" });
    const transport = this.deps.makeTransport(credentials, {
      onStatus: (status) => this.set({ link: status, ...(status.kind === "open" ? { hostName: status.hostName } : {}) }),
      onNotification: (notification) => this.onNotification(notification),
      onOpen: () => void this.onOpen(),
    });
    this.transport = transport;
    transport.start();
  }

  retry(): void {
    this.transport?.retryNow();
  }

  /** app 退到后台很久又回来：等待中的立刻再连 */
  resume(): void {
    this.transport?.retryNow();
  }

  // ———————————————————— 连上之后 ————————————————————

  private async onOpen(): Promise<void> {
    this.watchedTail = null;
    const listed = await this.refreshList();
    if (!listed) return;
    await this.call("sessions.watch", {});
    const openId = this.stateValue.openId;
    if (openId !== null) {
      await this.loadTail(openId);
      await this.watchTail(openId);
    }
  }

  private async refreshList(): Promise<boolean> {
    const wait = this.lastListAt + LIST_GAP_MS - this.deps.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.lastListAt = this.deps.now();
    try {
      const result = resultOf["sessions.list"](await this.request("sessions.list", {}));
      if (result === null) throw new Error("bad sessions.list result");
      this.set({ sessions: new Map(result.sessions.map((session) => [session.id, session])), truncated: result.truncated, listState: "ready" });
      return true;
    } catch (cause) {
      this.deps.log?.(`[app] 清单没读到：${String(cause)}`);
      if (this.stateValue.sessions.size === 0) this.set({ listState: "failed" });
      if (cause instanceof RequestError && cause.error.code === "busy") {
        if (this.listTimer !== null) clearTimeout(this.listTimer);
        this.listTimer = setTimeout(() => void this.refreshList(), LIST_GAP_MS);
      }
      return false;
    }
  }

  private onNotification(notification: MobileNotification): void {
    switch (notification.event) {
      case "sessions.changed": {
        const { sessions, removed } = notification.params;
        this.set({ sessions: applySessionsChanged(this.stateValue.sessions, sessions, removed) });
        return;
      }
      case "tail.changed":
        if (notification.params.sessionId === this.stateValue.openId) this.scheduleTailReload(notification.params.sessionId);
        return;
      case "reply.sent":
        this.replyEvent({ kind: "sent", requestId: notification.params.requestId });
        return;
      case "reply.failed":
        this.replyEvent({ kind: "failed", requestId: notification.params.requestId, error: notification.params.error });
        return;
      case "host.shutdown":
        // 连接层自己放慢重连；这里不用做什么
        return;
    }
  }

  // ———————————————————— 对话 ————————————————————

  openSession(id: string): void {
    const session = this.stateValue.sessions.get(id);
    if (session === undefined) return;
    const unread = session.state === "done" || session.state === "failed";
    const viewed = unread ? new Set([...this.stateValue.viewed, id]) : this.stateValue.viewed;
    this.set({ openId: id, openedState: session.state, viewed, stopFailed: false });
    if (unread) void this.call("unread.clear", { sessionId: id });
    void this.loadTail(id).then(() => this.watchTail(id));
  }

  closeSession(): void {
    const id = this.stateValue.openId;
    if (id === null) return;
    if (this.tailTimer !== null) clearTimeout(this.tailTimer);
    this.tailTimer = null;
    if (this.watchedTail === id) {
      this.watchedTail = null;
      void this.call("tail.unwatch", { sessionId: id });
    }
    this.set({ openId: null, openedState: null });
  }

  private slot(id: string): ChatSlot {
    return this.stateValue.chats.get(id) ?? { tail: null, loading: false, loadingOlder: false, failed: false };
  }

  private setSlot(id: string, patch: Partial<ChatSlot>): void {
    const chats = new Map(this.stateValue.chats);
    chats.set(id, { ...this.slot(id), ...patch });
    this.set({ chats });
  }

  private async loadTail(id: string): Promise<void> {
    this.setSlot(id, { loading: this.slot(id).tail === null, failed: false });
    try {
      const page = resultOf["tail.load"](await this.request("tail.load", { sessionId: id }));
      if (page === null) throw new Error("bad tail.load result");
      this.setSlot(id, { tail: mergeLatest(this.slot(id).tail, page), loading: false, failed: false });
    } catch (cause) {
      this.deps.log?.(`[app] 尾部没读到：${String(cause)}`);
      this.setSlot(id, { loading: false, failed: this.slot(id).tail === null });
    }
  }

  private async watchTail(id: string): Promise<void> {
    if (this.stateValue.openId !== id || this.watchedTail === id) return;
    if (await this.call("tail.watch", { sessionId: id })) this.watchedTail = id;
  }

  private scheduleTailReload(id: string): void {
    if (this.tailTimer !== null) return;
    this.tailTimer = setTimeout(() => {
      this.tailTimer = null;
      if (this.stateValue.openId === id) void this.loadTail(id);
    }, TAIL_DEBOUNCE_MS);
  }

  async loadEarlier(): Promise<void> {
    const id = this.stateValue.openId;
    if (id === null) return;
    const slot = this.slot(id);
    const first = slot.tail?.entries[0];
    if (slot.tail === null || first === undefined || slot.loadingOlder) return;
    this.setSlot(id, { loadingOlder: true });
    try {
      const page = resultOf["tail.load"](await this.request("tail.load", { sessionId: id, before: first.id }));
      if (page === null) throw new Error("bad tail.load result");
      const current = this.slot(id).tail;
      this.setSlot(id, { tail: current === null ? page : mergeOlder(current, page), loadingOlder: false });
    } catch {
      this.setSlot(id, { loadingOlder: false });
    }
  }

  /** 回一句：铸 requestId，先在排队条里放一条「正在发」，电脑回了再改 */
  async sendReply(text: string): Promise<boolean> {
    const id = this.stateValue.openId;
    const body = [...text.trim()].slice(0, MOBILE_LIMITS.replyText).join("");
    if (id === null || body === "" || this.stateValue.link.kind !== "open") return false;
    const requestId = toHex(secureRandom(16));
    const pending: PendingReply = { requestId, sessionId: id, text: body, at: this.deps.now(), status: "sending" };
    this.set({ replies: [...this.stateValue.replies, pending] });
    try {
      const result = resultOf.reply(await this.request("reply", { sessionId: id, text: body, requestId }));
      if (result === null) throw new RequestError({ code: "internal", message: "电脑的应答看不懂" });
      this.replyEvent({ kind: "accepted", requestId, queued: result.queued });
    } catch (cause) {
      const error = cause instanceof RequestError ? cause.error : { code: "internal" as const, message: String(cause) };
      this.replyEvent({ kind: "rejected", requestId, error });
    }
    return true;
  }

  dismissReply(requestId: string): void {
    this.replyEvent({ kind: "dismiss", requestId });
  }

  private replyEvent(event: ReplyEvent): void {
    this.set({ replies: applyReplyEvent(this.stateValue.replies, event, this.deps.now()) });
  }

  async stop(): Promise<void> {
    const id = this.stateValue.openId;
    if (id === null) return;
    this.set({ stopFailed: false });
    const ok = await this.call("stop", { sessionId: id });
    if (!ok) this.set({ stopFailed: true });
  }

  // ———————————————————— 小工具 ————————————————————

  private request<M extends MobileMethod>(method: M, params: MobileMethodParams[M]): Promise<unknown> {
    if (this.transport === null) return Promise.reject(new RequestError({ code: "unavailable", message: "还没连上电脑" }));
    return this.transport.request(method, params);
  }

  /** 不关心结果、只关心成没成的调用 */
  private async call<M extends MobileMethod>(method: M, params: MobileMethodParams[M]): Promise<boolean> {
    try {
      await this.request(method, params);
      return true;
    } catch (cause) {
      this.deps.log?.(`[app] ${method} 没成：${String(cause)}`);
      return false;
    }
  }
}
