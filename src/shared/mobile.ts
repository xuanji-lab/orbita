/**
 * 手机端的契约 —— 手机「看与回」的第一刀（2026-11-25）。
 *
 * 两件事放在这里，都是 IPC 四层契约的第 1 层：
 *
 * 1. **设置**（主进程 ↔ renderer）：设置里「手机」页的类型与通道名。
 * 2. **线上协议**（手机 ↔ 电脑）：WebSocket 上跑的帧、请求、应答、通知的形状，以及电脑这头
 *    配对与加密信道的**约定**。安卓端（下一条 PR）照这一份实现，所以凡是两端要对上的常量、
 *    字节序、拼接顺序都写死在这里，不在别处另立一份。
 *
 * 为什么线上类型要自己持有：手机的协议是 Orbita 的对外契约，不该跟着 agent 内核走。内核迁移
 * 之后命令与事件的形状不变、只是类型来源换掉；主进程从会话记录映射成这里的类型，手机永远
 * 只见 `SessionSummary` / `TailEntry` 这些，不见内核的类型。
 *
 * **安全边界**：现有 IPC 通道没有调用方鉴权，其中一条能取回明文密钥——手机的连接不桥接它们，
 * 只开下面列出的十个方法。所有从网络进来的对象都要过 `mobile-wire.ts` 的手写校验。
 *
 * 纯模块：不 import electron / node，preload 与 renderer 也能引。
 */

// ————————————————————————————————————————————————————————————————
// 一、设置（主进程 ↔ renderer）
// ————————————————————————————————————————————————————————————————

/** 监听的默认端口 */
export const MOBILE_DEFAULT_PORT = 47620;

/** WebSocket 的路径；别的路径不握手 */
export const MOBILE_PATH = "/orbita";

/**
 * 设置页「手机」的七条通道。`offerCreate` 是用户点「生成配对码」；`devices` 列已配对设备；
 * `revoke` 忘掉一台设备（之后它再也算不出信道密钥）。每条都回最新的设置 / 列表，页面不必重拉。
 */
export const mobileChannels = {
  get: "mobile:get",
  setEnabled: "mobile:set-enabled",
  setBind: "mobile:set-bind",
  offerCreate: "mobile:offer-create",
  offerCancel: "mobile:offer-cancel",
  devices: "mobile:devices",
  revoke: "mobile:revoke",
} as const;

/**
 * 可绑地址的类别。Tailscale 的排最前，其后是私网地址，最后是回环（只用于开发）。
 * 公网地址不列、也不许设：这个服务只给用户自己的手机用，不该暴露在公网上。
 */
export type MobileBindKind = "tailscale" | "private" | "loopback";

export interface MobileBindCandidate {
  /** IPv4 地址 */
  address: string;
  kind: MobileBindKind;
  /** 这张网卡叫什么（`en0`、`utun5`…），设置页并排显示两列时好认 */
  interfaceName: string;
}

export interface MobileSettings {
  /** 开关。关着时不监听，已配对的设备也连不上 */
  enabled: boolean;
  /** 绑在哪；null = 还没选（第一次启用前） */
  bind: { address: string; port: number } | null;
  /** 此刻本机上可绑的地址（主进程现算），按 kind 排好序 */
  candidates: MobileBindCandidate[];
}

/** 「生成配对码」的结果。code 是 6 位数字；expiresAt 是 Unix 毫秒 */
export interface MobileOffer {
  code: string;
  expiresAt: number;
  address: string;
  port: number;
}

export interface MobileDevice {
  id: string;
  name: string;
  /** Unix 毫秒 */
  pairedAt: number;
  /** 从没连上过是 null */
  lastSeenAt: number | null;
  /** 此刻在线 */
  connected: boolean;
}

/**
 * 一个 IPv4 地址属于哪一类可绑地址；不可绑（公网、链路本地、组播、写法不对）返回 null。
 *
 * - Tailscale：`100.64.0.0/10`（运营商级 NAT 段，Tailscale 的地址从这里分）；
 * - 私网：`10/8`、`172.16/12`、`192.168/16`；
 * - 回环：`127/8`。
 *
 * 只认 IPv4：IPv6 的链路本地地址要带网卡序号才连得上、唯一本地地址各家前缀不一，第一版不列。
 * `::ffff:a.b.c.d`（有些系统把 IPv4 写成 IPv4 映射的 IPv6）按里面的 IPv4 判。
 */
export function classifyBindAddress(address: string): MobileBindKind | null {
  const octets = ipv4Octets(address) ?? ipv4Octets(address.replace(/^::ffff:/i, ""));
  if (octets === null) return null;
  const [a = -1, b = -1] = octets;
  if (a === 100 && b >= 64 && b <= 127) return "tailscale";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 127) return "loopback";
  return null;
}

function ipv4Octets(address: string): number[] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (match === null) return null;
  const octets = match.slice(1).map((part) => Number(part));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

const BIND_KIND_ORDER: Readonly<Record<MobileBindKind, number>> = { tailscale: 0, private: 1, loopback: 2 };

/** 可绑地址的排序：Tailscale → 私网 → 回环；同一类里保持网卡给出的顺序 */
export function sortBindCandidates<T extends MobileBindCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort((x, y) => BIND_KIND_ORDER[x.kind] - BIND_KIND_ORDER[y.kind]);
}

/** 一个 IPv4 地址此刻能不能绑（与 candidates 同一口径） */
export function isBindableAddress(address: string): boolean {
  return classifyBindAddress(address) !== null;
}

/** 端口合法：1–65535 的整数 */
export function isMobilePort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

// ————————————————————————————————————————————————————————————————
// 二、数据形状（手机见到的）
// ————————————————————————————————————————————————————————————————

/**
 * 一条会话在手机上的状态。顺序（前者压过后者）：等你 → 在跑 → 没看成 → 跑完没看 → 空闲。
 * 与桌面侧栏的状态饼同一套词，推导在 `deriveMobileSessionState`。
 */
export type MobileSessionState = "waiting" | "running" | "done" | "failed" | "idle";

export interface SessionSummary {
  id: string;
  title: string;
  /** null = 不属于任何工作区（桌面侧栏的「任务」组） */
  workspaceId: string | null;
  /** 工作区此刻的名字；工作区没了或没有工作区是 null */
  workspaceName: string | null;
  state: MobileSessionState;
  /** agent 最近一句的首行，最多 120 个字符；还没说过是 null */
  lastLine: string | null;
  /** Unix 毫秒 */
  updatedAt: number;
  /** 派出去的子会话里有几个还在跑 */
  childrenRunning: number;
}

/** 「agent 最近一句」的首行上限（字符） */
export const MOBILE_LAST_LINE_MAX = 120;

/** 尾部的一条：一条用户消息、一段 agent 说的话，或一轮里连着的一串工具调用 */
export interface TailEntry {
  id: string;
  /** Unix 毫秒 */
  at: number;
  kind: "user" | "assistant" | "process";
  /** user / assistant 的文字 */
  text?: string;
  /** user：这条带了几张图（第一版不传图，只告诉有几张） */
  images?: number;
  /** process：这一串做了几步 */
  steps?: number;
  /** process：其中几步没成 */
  failed?: number;
}

export interface HostInfo {
  /** 电脑的名字 */
  name: string;
  protocol: number;
}

/** 协议版本。两边对不上就握手失败——形状变了抬这个数，不在线上兼容旧形状 */
export const MOBILE_PROTOCOL_VERSION = 1;

/** 单帧上限（按 UTF-8 字节算，明文帧与加密帧都算） */
export const MOBILE_FRAME_MAX_BYTES = 256 * 1024;

/** 一页尾部最多给几条 */
export const MOBILE_TAIL_PAGE = 60;
/** 一页尾部的 JSON 不超过多少字节 */
export const MOBILE_TAIL_PAGE_MAX_BYTES = 128 * 1024;

export type MobileErrorCode =
  /** 帧或参数的形状不对（未知字段、类型错） */
  | "bad_request"
  /** 没认出设备：配对码不对、设备被忘掉、还没握手就想调方法 */
  | "unauthorized"
  /** 会话不存在，或翻页的锚点找不到 */
  | "not_found"
  /** 这条会话的待发队列排满了 */
  | "busy"
  /** 太长：帧超了上限，或某个字符串超了上限 */
  | "too_large"
  /** 这会儿做不了：服务关着、会话续不了、回复被停止清掉 */
  | "unavailable"
  /** 电脑这边出错 */
  | "internal";

export interface MobileError {
  code: MobileErrorCode;
  message: string;
}

/** 线上各处的长度上限。超了一律拒（`too_large`）——手机不该发这么长，发了也是客户端的 bug */
export const MOBILE_LIMITS = {
  /** 配对时手机自报的名字 */
  deviceName: 80,
  /** 提议的 id */
  offerId: 64,
  /** 手机给一次「回一句」铸的 id，用来对 `reply.sent` / `reply.failed` */
  requestId: 64,
  /** 回复的正文（字符） */
  replyText: 8000,
  /** 记录 id（翻页的 `before` 锚点） */
  recordId: 128,
} as const;

/**
 * 一条会话在手机上的状态。与桌面 `sessionRunState`（renderer）同一个顺序，差别只有一处：
 * 桌面的「等你」还包含挂着的工具审批——审批状态只活在 renderer，主进程这里只认计划待确认。
 * 第一版手机不做审批，挂着审批的会话在手机上显示「在跑」。
 *
 * - `planAwaiting`：停在「计划等你确认」上（`planAwaitingIn`，读转录尾部）；
 * - `phase`：这条会话（或它的直接子会话）在主进程运行态表里的档；没记录 / `idle` = 空闲；
 * - `unread`：meta 上的未读标记，`failed` 说明那一轮以失败收尾；
 * - `settledRecently`：这次运行里刚从在跑变成空闲、还没人在手机上打开过——renderer 把未读标上盘
 *   要晚几拍，这几拍里靠它把刚跑完的会话显示成「跑完没看」而不是「空闲」。
 */
export function deriveMobileSessionState(input: {
  phase: string | undefined;
  planAwaiting: boolean;
  unread: { failed: boolean } | null;
  settledRecently: boolean;
}): MobileSessionState {
  if (input.planAwaiting) return "waiting";
  if (input.phase !== undefined && input.phase !== "idle") return "running";
  if (input.unread !== null && input.unread.failed) return "failed";
  if (input.unread !== null || input.settledRecently) return "done";
  return "idle";
}

// ————————————————————————————————————————————————————————————————
// 三、线上协议：帧
// ————————————————————————————————————————————————————————————————

/**
 * 连接分两段。
 *
 * **明文段**（还没认出设备）：只认 `pair.start`、`pair.prove`、`hello` 三种帧，别的一来就断开。
 * 电脑的应答是 `{ v, id, ok, result | error }`。
 *
 * **加密段**：之后每一帧都是 `SealedFrame`，里面是请求 / 应答 / 通知。电脑给手机的应答与通知
 * 也包在 SealedFrame 里（同一把信道密钥，电脑自己方向的 seq）。
 */
export interface PairStartFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "pair.start";
  id: number;
  params: { deviceName: string };
}

export interface PairProveFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "pair.prove";
  id: number;
  params: { offerId: string; sig: string };
}

/** 回来认设备：`d` 是设备 id，`ct` 里是 `{ name }`（手机此刻的名字）。这是手机方向的第一个加密帧（n = 1） */
export interface HelloFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "hello";
  id: number;
  d: string;
  n: number;
  ct: string;
}

export interface SealedFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  /** 设备 id（32 个小写十六进制字符） */
  d: string;
  /** 这个方向的序号，从 1 起严格递增 */
  n: number;
  /** base64：AES-256-GCM 的密文 ‖ 16 字节 tag */
  ct: string;
}

/** 明文段电脑 → 手机的应答 */
export type ClearReply<T> =
  | { v: typeof MOBILE_PROTOCOL_VERSION; id: number; ok: true; result: T }
  | { v: typeof MOBILE_PROTOCOL_VERSION; id: number; ok: false; error: MobileError };

export interface PairStartResult {
  offerId: string;
  /** Unix 毫秒 */
  expiresAt: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number };
  salt: string;
  iv: string;
  box: string;
  hostBoxPublic: string;
  hostSignPublic: string;
}

export interface PairProveResult {
  deviceId: string;
  /** 电脑用同一个种子算出的手机加密公钥；手机拿它和自己算的核对 */
  deviceBoxPublic: string;
  host: HostInfo;
}

// ————————————————————————————————————————————————————————————————
// 四、线上协议：加密段里的请求 / 应答 / 通知
// ————————————————————————————————————————————————————————————————

export interface TailLoadParams {
  sessionId: string;
  /** 上一页第一条的 id；不给 = 从尾部开始 */
  before?: string;
}

/** 每个方法的参数。无参的方法 params 缺席或空对象 */
export interface MobileMethodParams {
  "sessions.list": Record<string, never>;
  "sessions.watch": Record<string, never>;
  "sessions.unwatch": Record<string, never>;
  "tail.load": TailLoadParams;
  "tail.watch": { sessionId: string };
  "tail.unwatch": { sessionId: string };
  "reply": { sessionId: string; text: string; requestId: string };
  "stop": { sessionId: string };
  "unread.clear": { sessionId: string };
  "ping": Record<string, never>;
}

/** 每个方法的结果。`null` = 没有结果（应答里写 `"result": null`） */
export interface MobileMethodResults {
  "sessions.list": { sessions: SessionSummary[]; truncated: boolean };
  "sessions.watch": null;
  "sessions.unwatch": null;
  "tail.load": { entries: TailEntry[]; hasMore: boolean; rev: number };
  "tail.watch": null;
  "tail.unwatch": null;
  "reply": { queued: boolean; position: number };
  "stop": null;
  "unread.clear": null;
  "ping": { now: number };
}

/** 手机能调的方法——只有这些。列出来是为了校验与分发共用同一份名单 */
export const MOBILE_METHODS = [
  "sessions.list",
  "sessions.watch",
  "sessions.unwatch",
  "tail.load",
  "tail.watch",
  "tail.unwatch",
  "reply",
  "stop",
  "unread.clear",
  "ping",
] as const;

export type MobileMethod = keyof MobileMethodParams & (typeof MOBILE_METHODS)[number];

export type MobileRequest = {
  [M in MobileMethod]: { id: number; method: M; params: MobileMethodParams[M] };
}[MobileMethod];

/** 电脑 → 手机的应答（在密文里）；`result` 的形状按方法见 `MobileMethodResults` */
export type MobileReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: MobileError };

/** 电脑 → 手机的通知（在密文里） */
export interface MobileNotifications {
  /** 只带变过的会话；`removed` 是从列表里消失的 id */
  "sessions.changed": { sessions: SessionSummary[]; removed: string[] };
  /** 这条会话的转录变了，手机该重拉尾部 */
  "tail.changed": { sessionId: string; rev: number };
  /** 排队的回复发出去了 */
  "reply.sent": { requestId: string };
  /** 回复没发出去，或 agent 那头这一轮没跑成 */
  "reply.failed": { requestId: string; error: MobileError };
  /** 电脑要退出了，别再重连 */
  "host.shutdown": Record<string, never>;
}

export type MobileNotification = {
  [E in keyof MobileNotifications]: { event: E; params: MobileNotifications[E] };
}[keyof MobileNotifications];

export function okReply(id: number, result: unknown): MobileReply {
  return { id, ok: true, result };
}

export function errorReply(id: number, code: MobileErrorCode, message: string): MobileReply {
  return { id, ok: false, error: { code, message } };
}

export function mobileNotification<E extends keyof MobileNotifications>(
  event: E,
  params: MobileNotifications[E],
): MobileNotification {
  return { event, params } as MobileNotification;
}

// ————————————————————————————————————————————————————————————————
// 五、配对与信道的约定（两端照此算；全部用标准原语，不自家发明）
// ————————————————————————————————————————————————————————————————

/** 字符串都是 UTF-8；`b64` 是标准 base64（带填充，RFC 4648 §4）；多字节整数是大端 */
export const MOBILE_CRYPTO = {
  /** 配对码：6 位十进制，取值 100000–999999（首位不为 0，免得看着像 5 位） */
  codeDigits: 6,
  /** 提议多久过期（毫秒） */
  offerTtlMs: 5 * 60_000,
  /** 一次性种子 S 的字节数 */
  seedBytes: 32,
  /** scrypt：`keyPin = scrypt(utf8(code), salt, N, r, p, 32 字节)` */
  kdf: { name: "scrypt", N: 131072, r: 8, p: 1 } as const,
  saltBytes: 16,
  ivBytes: 12,
  /** AES-256-GCM 的 tag 长度 */
  tagBytes: 16,
  /** 手机加密私钥的种子：`HKDF-SHA256(ikm = S, salt = 空, info = "orbita-mobile-box", 32 字节)` */
  boxSeedInfo: "orbita-mobile-box",
  /** 配对时的挑战：`SHA-256(utf8("orbita-pair-v1") ‖ utf8(offerId) ‖ salt ‖ iv ‖ box ‖ hostBoxPublic)` */
  pairChallengeLabel: "orbita-pair-v1",
  /** 信道密钥：`HKDF-SHA256(ikm = X25519(自己的加密私钥, 对方的加密公钥), salt = utf8(label) ‖ utf8(deviceId), info = "channel", 32 字节)` */
  channelSaltLabel: "orbita-mobile-v1",
  channelInfo: "channel",
  /** 加密帧的 IV = 方向前缀（4 字节）‖ seq（8 字节大端）；AAD = utf8(deviceId) */
  ivDeviceToHost: "D2H>",
  ivHostToDevice: "H2D>",
  /** 设备 id：16 字节随机，写成 32 个小写十六进制字符 */
  deviceIdBytes: 16,
  /**
   * 限速与上限
   */
  maxProveAttemptsPerOffer: 5,
  pairStartPerMinutePerAddress: 10,
  maxOnlineDevices: 8,
  /** 每条连接每秒最多收几帧 */
  maxFramesPerSecond: 20,
  /** 多久发一次心跳（WebSocket 协议级 ping 帧，手机端库会自动回 pong） */
  heartbeatMs: 30_000,
  /** 多久没收到任何帧（含 pong）就断开 */
  idleTimeoutMs: 90_000,
} as const;

/**
 * 配对的流程（电脑是权威，手机只存配对凭据）：
 *
 * 1. 用户在电脑的设置页点「生成配对码」：电脑生成一次性种子 S、6 位配对码、盐、IV，把 S 用
 *    `keyPin`（配对码经 scrypt 派生）AES-256-GCM 包起来得到 `box`。提议 5 分钟过期，同一时刻只有
 *    一个有效提议，过期或用掉后立刻丢弃 S。
 * 2. 手机 `pair.start` 拿到提议，自己算 `keyPin`、解开 `box` 得到 S——解不开就是配对码不对。
 * 3. 手机从 S 派生自己的两对密钥：**签名** Ed25519（种子 = S）；**加密** X25519（种子 = 上面的
 *    HKDF）。电脑拿同一个 S 能算出同样的公钥，所以手机不用自报公钥、电脑也不用信它自报的。
 * 4. 手机对挑战签名，`pair.prove`。电脑用从 S 派生的签名公钥验签：验过就登记设备、铸设备 id、
 *    回 `deviceBoxPublic`（手机拿它核对自己算的）。
 * 5. 之后手机每次连上先发 `hello`：电脑按设备 id 找到设备、算出信道密钥 K、解得开就算认出。
 *    **没有令牌**——电脑存的只有设备的公钥，忘掉设备就是删掉这条记录，之后它再也算不出 K。
 */

// ————————————————————————————————————————————————————————————————
// 六、给设置 IPC 的入参形状（主进程 handler 校验后的值）
// ————————————————————————————————————————————————————————————————

export interface MobileSetBindInput {
  address: string;
  port: number;
}
