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
 * 配对与信道的形状按 2026-11-25 的安全审查改过（原规格的初稿在 git 历史里）：设备的长期私钥
 * 不再从配对码加密的种子里派生、配对要双向确认、每条连接一把信道密钥。理由见第五节。
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
  /** 监听的真实状态；与 enabled 分开，地址失效 / 私钥不可用时要能如实显示 */
  listening: boolean;
  /** 没能启用 / 没能监听时给人看的一句原因；正常是 null */
  message: string | null;
  /**
   * 主机私钥丢过的告示（换机 / 重装系统后从系统密钥库读不回）：设备已清空、钥匙已重铸，
   * 等用户重新配对，配上第一台后清掉。与 message 分开：那条说「监听怎么了」，这条说「设备怎么了」
   */
  hostKeyNotice: string | null;
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

/**
 * 单帧上限。先说清两个词（2026-11-25 审查 N8）：**线上字节**是整帧 JSON 的 UTF-8 字节数——加密帧里是
 * base64 之后的密文，比明文长 4/3；**明文字节**是密封之前那段 JSON 的 UTF-8 字节数。
 *
 * **手机 → 电脑**：电脑入站按**线上字节**卡 `MOBILE_FRAME_MAX_BYTES` = 64 KB（`ws` 的 `maxPayload` 与
 * `parseInboundFrame` 两道都按它；未认证的连接也发不了大帧）。折成明文约 48 KB。合法请求里最大的是一条
 * 4000 字的回复（`MOBILE_LIMITS.replyText`），每字 4 个字节写满，线上也才 21 KB 左右——手机端按 64 KB
 * 设发出上限就够，别硬凑更大的帧。
 *
 * **电脑 → 手机**：电脑保证**明文字节**不超过 `MOBILE_OUTBOUND_PLAINTEXT_MAX_BYTES` = 256 KB（超了那一帧
 * 就不发）。**线上字节**最多 `MOBILE_OUTBOUND_WIRE_MAX_BYTES` = 384 KB：明文加 16 字节 tag、按 base64
 * 膨胀 4/3、再加帧外壳，向上留了余量。**手机端的入站上限（WebSocket 客户端的单帧上限、自己的缓冲区）
 * 必须不小于这个数**；按 256 KB 设的话，电脑发得出、手机收不下。
 */
export const MOBILE_FRAME_MAX_BYTES = 64 * 1024;
export const MOBILE_OUTBOUND_PLAINTEXT_MAX_BYTES = 256 * 1024;
export const MOBILE_OUTBOUND_WIRE_MAX_BYTES = 384 * 1024;

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
  /** 提议的 id：32 个小写十六进制字符 */
  offerId: 32,
  /** 手机给一次「回一句」铸的 id，用来对 `reply.sent` / `reply.failed` */
  requestId: 64,
  /**
   * 回复的正文（字符）。四个字节一个的 emoji 写满也才 16 KB，加 base64 的膨胀与外壳远不到
   * 单帧上限。手机是回一句，不是写文章。
   */
  replyText: 4000,
  /** 记录 id（翻页的 `before` 锚点） */
  recordId: 128,
} as const;

/**
 * 一条会话在手机上的状态。与桌面 `sessionRunState`（renderer）同一个顺序：
 * 计划待确认 → 在跑 → 没看成 → 跑完没看 → 空闲。（工具审批已随「权限只留放行」删掉，
 * 「等你」只剩计划待确认一种。）
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
 * 一条连接分三段。
 *
 * **明文段（一）**：刚连上，电脑先发 `host.hello`。手机要配对就发 `pair.start` / `pair.prove`，
 * 这两帧必须在同一条连接上先后发出（不然旁听的第三方可以抢在手机前面把同一个证明再发一遍，
 * 电脑会登记一台谁也没有私钥的孤儿设备）。
 * 明文段只认 `pair.start`、`pair.prove`、`hello` 三种帧，别的一来就断开。电脑的应答是
 * `{ v, id, ok, result | error }`。
 *
 * **握手**：已配对的手机发 `hello`（它的第一个加密帧，seq = 1），用握手密钥 Kh 密封；电脑的
 * 应答也是密封帧（同一个 Kh，电脑方向 seq = 1）。握手之前手机并没有验证对面是电脑，所以电脑
 * 这头的应答不能明文发。
 *
 * **加密段**：之后每一帧都是 `{ v, n, ct }`，用信道密钥 K（每条连接一把）。里面是请求 / 应答 /
 * 通知。两个方向各自的 seq 从 1 起严格递增，**必须恰好加 1**——跳号、重号都断开。
 */
/** 连上之后电脑发的第一帧（明文）：这一条连接的新鲜数 */
export interface HostHelloFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "host.hello";
  /** base64：32 字节随机 */
  nonce: string;
}

/** 手机 → 电脑：要一份配对提议 */
export interface PairStartFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "pair.start";
  id: number;
  /** 没有参数（缺席或空对象） */
  params?: Record<string, never>;
}

/**
 * 手机 → 电脑：证明自己拿到了种子 S，并登记自己的加密公钥（手机用安全随机数自己生成的 X25519）。
 * 同一条连接上必须先发过 `pair.start`。
 */
export interface PairProveFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "pair.prove";
  id: number;
  params: {
    offerId: string;
    /** base64：手机的 X25519 公钥，32 字节 */
    deviceBoxPublic: string;
    deviceName: string;
    /** base64：`HMAC-SHA256(Kp, M)`，32 字节（见 MOBILE_CRYPTO.pairProof） */
    proof: string;
  };
}

/** 回来认设备：`d` 是设备 id，密文里有手机这一条连接的新鲜数。这是手机方向的第一个加密帧（n = 1） */
export interface HelloFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  type: "hello";
  id: number;
  /** 设备 id（32 个小写十六进制字符） */
  d: string;
  n: 1;
  /** base64：AES-256-GCM 的密文 ‖ 16 字节 tag */
  ct: string;
}

/** `hello` 的密文里的东西 */
export interface HelloBody {
  /** base64：手机这一条连接的新鲜数，32 字节随机，每条连接现生成、不重用 */
  pn: string;
  /** 手机此刻的名字（想改名才带） */
  name?: string;
}

/**
 * 握手应答（电脑 → 手机）：带 `d`，让手机确认电脑认出的正是自己这台设备。用 Kh、电脑方向 seq = 1。
 * 明文是 `{ id, ok: true, result: { host, protocol } }` 或 `{ id, ok: false, error }`。
 */
export interface HandshakeReplyFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
  d: string;
  n: 1;
  ct: string;
}

/** 加密段的一帧（两个方向同一个形状）。线路上不再带设备 id：一条连接在握手时已经绑定了设备 */
export interface SealedFrame {
  v: typeof MOBILE_PROTOCOL_VERSION;
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
  /** 32 个小写十六进制字符 */
  offerId: string;
  /** Unix 毫秒 */
  expiresAt: number;
  kdf: { name: "scrypt"; N: number; r: number; p: number };
  salt: string;
  iv: string;
  /** base64：被配对码包起来的一次性种子，32 字节密文 ‖ 16 字节 tag */
  box: string;
  /** base64：电脑的 X25519 公钥，32 字节 */
  hostBoxPublic: string;
}

export interface PairProveResult {
  /** 电脑铸的设备 id（32 个小写十六进制字符） */
  deviceId: string;
  /** base64：`HMAC-SHA256(Kc, M ‖ utf8(deviceId))`——手机验不过就丢掉刚生成的私钥（见 MOBILE_CRYPTO） */
  hostProof: string;
  host: HostInfo;
}

export interface HelloResult {
  host: HostInfo;
  protocol: number;
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

/**
 * 电脑 → 手机的通知（在密文里）。
 *
 * `reply.failed` 是一条回复的**终态**：它可能在 `reply.sent` **之后**到——话发出去了、agent 那头这一轮
 * 却没跑成。手机按到达顺序处理：sent 之后来的 failed 也要显示。sent 之前来的 failed 说明根本没发出去。
 * 手机断线期间错过的回执不补发（`reply` 的应答只说排没排上）。
 */
export interface MobileNotifications {
  /** 只带变过的会话；`removed` 是从列表里消失的 id */
  "sessions.changed": { sessions: SessionSummary[]; removed: string[] };
  /** 这条会话的转录变了，手机该重拉尾部 */
  "tail.changed": { sessionId: string; rev: number };
  /** 排队的回复发出去了 */
  "reply.sent": { requestId: string };
  /** 回复没发出去，或者 agent 那头这一轮没跑成 */
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

/**
 * 通用约定：字符串都是 UTF-8；`b64` 是标准 base64（带填充，RFC 4648 §4）；多字节整数是大端；
 * `x ‖ y` 是字节串拼接；「盐空」按 RFC 5869 的意思——空盐等于 HashLen 个零字节。
 *
 * 2026-11-25 的安全审查推翻了原规格的三处，这一版是改过之后的：
 *
 * 1. **设备的长期私钥不从种子派生。** 原设计让手机从 S 派生自己的两对密钥——于是抓到一次配对流量
 *    就得到一道可以永远慢慢验的题（GCM 的 tag 对上就是猜中了），猜中即永久冒充这台手机。现在手机用
 *    安全随机数自己生成 X25519 密钥对，S 只当「这一次配对的确认密钥」；提议过期 S 就作废，猜中也没用。
 *    Ed25519 的两对钥匙因此都不需要。
 * 2. **配对双向确认。** 原设计手机靠「电脑回的公钥和我自己算的一致」识破冒充者，第 1 条改完这个
 *    检查就没有了。现在电脑的成功应答带 `hostProof`，手机验不过就丢掉刚生成的私钥。
 * 3. **每条连接一把信道密钥。** 原设计的 K 永不变、seq 每条连接从 1 起——同一把钥匙反复配同一个 IV，
 *    录一次就能原样重放让 agent 再干一遍。现在电脑每条连接给一个新鲜数，K 由它派生；电脑的握手
 *    应答也是密的。
 *
 * **配对的流程**（电脑是权威，手机只存自己的私钥）：
 *
 * 1. 用户在电脑的设置页点「生成配对码」：电脑生成一次性种子 S（32 字节随机）、6 位配对码
 *    （`100000–999999`，`crypto.randomInt` 铸、不许用户自定）、盐（16）、IV（12）。S 用配对码派生的
 *    密钥 AES-256-GCM 包起来得到 `box`。提议 3 分钟过期，同一时刻只有一个，过期或用掉后立刻丢弃 S。
 * 2. 手机 `pair.start` 拿到提议，自己算 `keyPin`、解开 `box` 得到 S——解不开就是配对码不对，别往下发。
 * 3. 手机生成自己的 X25519 密钥对，对 M 算证明，`pair.prove`。
 * 4. 电脑用同一个 S 重算证明并 `timingSafeEqual` 比对；验过就登记设备、铸设备 id、回 `hostProof`。
 *    手机验 `hostProof`：验不过就丢掉刚生成的私钥，报「没连上你的电脑，地址可能被劫持」。
 * 5. 之后手机每次连上先走握手：电脑给新鲜数，手机回自己的新鲜数，两边各自派生这条连接的 K。
 *    **没有令牌**——电脑存的只有设备的公钥，忘掉设备就是删掉这条记录，之后它再也算不出 K。
 *
 * **手机侧要守的**：`kdf` 只接受 `N = 2^17, r = 8, p = 1`；每条连接的 `pn` 现生成、不重用；
 * `@noble/*` 精确锁版本；定值向量见 `src/main/mobile/crypto.test.ts`。
 */
export const MOBILE_CRYPTO = {
  /** 配对码：6 位十进制，取值 100000–999999（首位不为 0，免得看着像 5 位） */
  codeDigits: 6,
  /** 提议多久过期（毫秒）。原规格写 5 分钟；离线猜码堵住之后这是在线猜中的窗口，短一点好 */
  offerTtlMs: 3 * 60_000,
  /** 一次性种子 S 的字节数 */
  seedBytes: 32,
  /** `keyPin = scrypt(utf8(code), salt, N, r, p, 32 字节)` */
  kdf: { name: "scrypt", N: 131072, r: 8, p: 1 } as const,
  saltBytes: 16,
  ivBytes: 12,
  /** AES-256-GCM 的 tag 长度（只认 16） */
  tagBytes: 16,
  /** 新鲜数：`host.hello` 的 nonce 与手机的 pn，各 32 字节 */
  nonceBytes: 32,
  /** 公钥 / 私钥的长度（X25519 原始形） */
  keyBytes: 32,

  /** 提议 id：16 字节随机写成 32 个小写十六进制字符（定长，拼接才无歧义） */
  offerIdPattern: /^[0-9a-f]{32}$/,
  /** 设备 id：16 字节随机写成 32 个小写十六进制字符 */
  deviceIdPattern: /^[0-9a-f]{32}$/,

  /** 配对的证明：`proof = HMAC-SHA256(Kp, M)`，`Kp = HKDF-SHA256(ikm = S, 盐空, info = "orbita-pair-proof", 32)` */
  pairProofInfo: "orbita-pair-proof",
  /** 配对的确认：`hostProof = HMAC-SHA256(Kc, M ‖ utf8(deviceId))`，`Kc = HKDF-SHA256(S, 盐空, "orbita-pair-confirm", 32)` */
  pairConfirmInfo: "orbita-pair-confirm",
  /**
   * 配对时双方算的消息：`M = utf8("orbita-pair-v1") ‖ utf8(offerId) ‖ salt ‖ iv ‖ box ‖ hostBoxPublic
   * ‖ deviceBoxPublic ‖ utf8(deviceName)`。定长字段在前、名字在最后，拼接无歧义。
   */
  pairProofLabel: "orbita-pair-v1",

  /** 握手密钥：`Kh = HKDF-SHA256(ikm = DH, 盐 = nonce, info = "orbita-hello-v1", 32)` */
  helloInfo: "orbita-hello-v1",
  /**
   * 信道密钥：`K = HKDF-SHA256(ikm = DH, 盐 = nonce ‖ pn ‖ utf8(deviceId), info = "orbita-channel-v1", 32)`。
   * `DH = X25519(自己的加密私钥, 对方的加密公钥)`（原始输出，不再哈希）；`nonce` 是电脑给的新鲜数，
   * `pn` 是手机的，都是解码后的 32 字节。
   */
  channelInfo: "orbita-channel-v1",

  /** 加密帧的 IV = 方向前缀（4 字节 ASCII）‖ seq（8 字节大端）；AAD = utf8(deviceId) */
  ivDeviceToHost: "D2H>",
  ivHostToDevice: "H2D>",

  /**
   * 限速与上限（电脑侧执行）
   */
  maxProveAttemptsPerOffer: 5,
  pairStartPerMinutePerAddress: 10,
  maxOnlineDevices: 8,
  /** 还没认出设备的连接同时最多几条 */
  maxUnauthenticatedConnections: 8,
  /** 所有连接（含未认证的）同时最多几条 */
  maxConnections: 16,
  /** 连上之后多久没过握手就断（毫秒） */
  handshakeTimeoutMs: 10_000,
  /** 每条连接每秒最多收几帧 */
  maxFramesPerSecond: 20,
  /** 多久发一次心跳（WebSocket 协议级 ping 帧，手机端库会自动回 pong） */
  heartbeatMs: 30_000,
  /** 多久没收到任何帧（含 pong）就断开 */
  idleTimeoutMs: 90_000,
  /** 同一台设备重复发同一个 `reply` 的 `requestId`：这段时间内回上次的结果，不再发一轮 */
  replyDedupMs: 10 * 60_000,
  /** 每台设备各方法的重活限速：`[次数, 窗口毫秒]` */
  methodLimits: {
    "sessions.list": [1, 2_000],
    "tail.load": [2, 1_000],
    "tail.watch": [5, Number.POSITIVE_INFINITY],
    reply: [10, 60_000],
  } as const,
  /** 每台设备的出站上限（字节 / 秒），超出先攒着，超太久就断 */
  outboundBytesPerSecond: 512 * 1024,
} as const;

// ————————————————————————————————————————————————————————————————
// 六、给设置 IPC 的入参形状（主进程 handler 校验后的值）
// ————————————————————————————————————————————————————————————————

export interface MobileSetBindInput {
  address: string;
  port: number;
}
