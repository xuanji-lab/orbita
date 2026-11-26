/**
 * 手机端的**入站校验**（电脑 → 手机）：最小的那一份。
 *
 * 电脑侧的 `mobile-wire.ts` 管的是反方向（手机 → 电脑），而且会拖进电脑侧的一串模块，手机只
 * `import type`。这里只做手机要依赖的形状：帧的四种外壳、密文里的应答 / 通知、各方法的结果。
 * 规矩：
 * - 帧按**线上字节**卡上限：契约的 `MOBILE_OUTBOUND_WIRE_MAX_BYTES` = 384 KB（电脑出站明文上限 256 KB，
 *   加 16 字节 tag、base64 膨胀 4/3、再加帧外壳，向上留余量）。
 * - 缺字段、类型不对：这一帧不认（调用方断开或丢弃）。多出来的字段不拒——电脑比手机新时
 *   加字段是加法，手机照旧能用；形状变了电脑会抬协议版本，那时握手就对不上。
 * - 清单里单条会话坏了只丢那一条，不让一条坏数据挡住整张清单。
 *
 * 纯模块：`node --test` 直测。
 */
import type {
  HandshakeReplyFrame,
  HostHelloFrame,
  MobileError,
  MobileErrorCode,
  MobileMethodResults,
  MobileNotification,
  MobileSessionState,
  PairProveResult,
  PairStartResult,
  SealedFrame,
  SessionSummary,
  TailEntry,
} from "../../../src/shared/mobile.ts";
import { MOBILE_OUTBOUND_WIRE_MAX_BYTES, MOBILE_PROTOCOL_VERSION } from "../../../src/shared/mobile.ts";

/**
 * 线上一帧的字节上限，直接取契约的 `MOBILE_OUTBOUND_WIRE_MAX_BYTES`（384 KB）。
 *
 * 两层的关系：电脑保证**明文**不超过 256 KB，**线上** = base64(明文 + 16 字节 tag) + 帧外壳，契约按
 * 384 KB 给手机卡。这里必须直接用契约的线上数，不能从 256 KB 明文自己折算——折算出来的数比契约小，
 * 会把落在余量里的合法大帧（比如线上 300 KB 出头）误拒。
 */
export const INBOUND_WIRE_MAX_BYTES = MOBILE_OUTBOUND_WIRE_MAX_BYTES;

const encoder = new TextEncoder();

type Obj = Record<string, unknown>;

function objectOf(value: unknown): Obj | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : null;
}

const isString = (value: unknown): value is string => typeof value === "string";
const isInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const isNonNegInt = (value: unknown): value is number => isInt(value) && value >= 0;

const ERROR_CODES: readonly MobileErrorCode[] = [
  "bad_request",
  "unauthorized",
  "not_found",
  "busy",
  "too_large",
  "unavailable",
  "internal",
];

function errorOf(value: unknown): MobileError | null {
  const fields = objectOf(value);
  if (fields === null) return null;
  const code = fields["code"];
  const message = fields["message"];
  if (!isString(code) || !isString(message)) return null;
  // 不认识的错误码按 internal 处理：电脑比手机新时可能多出一种
  return { code: (ERROR_CODES as readonly string[]).includes(code) ? (code as MobileErrorCode) : "internal", message };
}

// ————————————————————————————————————————————————————————————————
// 帧的外壳
// ————————————————————————————————————————————————————————————————

export type ClearReplyFrame =
  | { kind: "clearReply"; id: number; ok: true; result: unknown }
  | { kind: "clearReply"; id: number; ok: false; error: MobileError };

export type HostFrame =
  | ({ kind: "hostHello" } & HostHelloFrame)
  | ClearReplyFrame
  | ({ kind: "handshake" } & HandshakeReplyFrame)
  | ({ kind: "sealed" } & SealedFrame);

/** 一行文本 → 一帧。超长、不是 JSON、版本不对、认不出形状：回 null（调用方断开） */
export function parseHostFrame(text: string): HostFrame | null {
  if (encoder.encode(text).length > INBOUND_WIRE_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const fields = objectOf(raw);
  if (fields === null || fields["v"] !== MOBILE_PROTOCOL_VERSION) return null;
  if (fields["type"] === "host.hello") {
    return isString(fields["nonce"]) ? { kind: "hostHello", v: MOBILE_PROTOCOL_VERSION, type: "host.hello", nonce: fields["nonce"] } : null;
  }
  if (fields["type"] !== undefined) return null;
  if ("ok" in fields) {
    const id = fields["id"];
    if (!isNonNegInt(id)) return null;
    if (fields["ok"] === true) return { kind: "clearReply", id, ok: true, result: fields["result"] };
    if (fields["ok"] === false) {
      const error = errorOf(fields["error"]);
      return error === null ? null : { kind: "clearReply", id, ok: false, error };
    }
    return null;
  }
  const n = fields["n"];
  const ct = fields["ct"];
  if (!isInt(n) || n < 1 || !isString(ct)) return null;
  if (fields["d"] !== undefined) {
    const d = fields["d"];
    return isString(d) && n === 1 ? { kind: "handshake", v: MOBILE_PROTOCOL_VERSION, d, n: 1, ct } : null;
  }
  return { kind: "sealed", v: MOBILE_PROTOCOL_VERSION, n, ct };
}

// ————————————————————————————————————————————————————————————————
// 密文里的应答与通知
// ————————————————————————————————————————————————————————————————

export type SealedPayload =
  | { kind: "reply"; id: number; ok: true; result: unknown }
  | { kind: "reply"; id: number; ok: false; error: MobileError }
  | { kind: "notification"; notification: MobileNotification };

export function parseSealedPayload(plain: string): SealedPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    return null;
  }
  const fields = objectOf(raw);
  if (fields === null) return null;
  if ("event" in fields) {
    const notification = notificationOf(fields["event"], fields["params"]);
    return notification === null ? null : { kind: "notification", notification };
  }
  const id = fields["id"];
  if (!isNonNegInt(id)) return null;
  if (fields["ok"] === true) return { kind: "reply", id, ok: true, result: fields["result"] };
  if (fields["ok"] === false) {
    const error = errorOf(fields["error"]);
    return error === null ? null : { kind: "reply", id, ok: false, error };
  }
  return null;
}

function notificationOf(event: unknown, params: unknown): MobileNotification | null {
  const fields = objectOf(params);
  if (fields === null) return null;
  switch (event) {
    case "sessions.changed": {
      const sessions = fields["sessions"];
      const removed = fields["removed"];
      if (!Array.isArray(sessions) || !Array.isArray(removed)) return null;
      return {
        event,
        params: { sessions: sessionsOf(sessions), removed: removed.filter(isString) },
      };
    }
    case "tail.changed": {
      const sessionId = fields["sessionId"];
      const rev = fields["rev"];
      return isString(sessionId) && isNonNegInt(rev) ? { event, params: { sessionId, rev } } : null;
    }
    case "reply.sent": {
      const requestId = fields["requestId"];
      return isString(requestId) ? { event, params: { requestId } } : null;
    }
    case "reply.failed": {
      const requestId = fields["requestId"];
      const error = errorOf(fields["error"]);
      return isString(requestId) && error !== null ? { event, params: { requestId, error } } : null;
    }
    case "host.shutdown":
      return { event, params: {} };
    default:
      return null;
  }
}

// ————————————————————————————————————————————————————————————————
// 数据形状
// ————————————————————————————————————————————————————————————————

const STATES: readonly MobileSessionState[] = ["waiting", "running", "done", "failed", "idle"];

/** 一条会话摘要；形状不对回 null */
export function sessionOf(value: unknown): SessionSummary | null {
  const fields = objectOf(value);
  if (fields === null) return null;
  const { id, title, workspaceId, workspaceName, state, lastLine, updatedAt, childrenRunning } = fields;
  if (!isString(id) || id === "" || !isString(title)) return null;
  if (workspaceId !== null && !isString(workspaceId)) return null;
  if (workspaceName !== null && !isString(workspaceName)) return null;
  if (!isString(state) || !(STATES as readonly string[]).includes(state)) return null;
  if (lastLine !== null && !isString(lastLine)) return null;
  if (!isNonNegInt(updatedAt) || !isNonNegInt(childrenRunning)) return null;
  return {
    id,
    title,
    workspaceId,
    workspaceName,
    state: state as MobileSessionState,
    lastLine,
    updatedAt,
    childrenRunning,
  };
}

/** 清单里坏的那几条丢掉，好的照收 */
export function sessionsOf(values: readonly unknown[]): SessionSummary[] {
  const out: SessionSummary[] = [];
  for (const value of values) {
    const session = sessionOf(value);
    if (session !== null) out.push(session);
  }
  return out;
}

export function tailEntryOf(value: unknown): TailEntry | null {
  const fields = objectOf(value);
  if (fields === null) return null;
  const { id, at, kind, text, images, steps, failed } = fields;
  if (!isString(id) || !isNonNegInt(at)) return null;
  if (kind !== "user" && kind !== "assistant" && kind !== "process") return null;
  if (text !== undefined && !isString(text)) return null;
  for (const count of [images, steps, failed]) {
    if (count !== undefined && !isNonNegInt(count)) return null;
  }
  const entry: TailEntry = { id, at, kind };
  if (isString(text)) entry.text = text;
  if (isNonNegInt(images)) entry.images = images;
  if (isNonNegInt(steps)) entry.steps = steps;
  if (isNonNegInt(failed)) entry.failed = failed;
  return entry;
}

/** 各方法的结果：形状不对回 null（调用方当成电脑出错） */
export const resultOf = {
  "sessions.list"(value: unknown): MobileMethodResults["sessions.list"] | null {
    const fields = objectOf(value);
    if (fields === null || !Array.isArray(fields["sessions"]) || typeof fields["truncated"] !== "boolean") return null;
    return { sessions: sessionsOf(fields["sessions"]), truncated: fields["truncated"] };
  },
  "tail.load"(value: unknown): MobileMethodResults["tail.load"] | null {
    const fields = objectOf(value);
    if (fields === null || !Array.isArray(fields["entries"]) || typeof fields["hasMore"] !== "boolean" || !isNonNegInt(fields["rev"])) {
      return null;
    }
    const entries: TailEntry[] = [];
    for (const raw of fields["entries"]) {
      const entry = tailEntryOf(raw);
      if (entry === null) return null;
      entries.push(entry);
    }
    return { entries, hasMore: fields["hasMore"], rev: fields["rev"] };
  },
  reply(value: unknown): MobileMethodResults["reply"] | null {
    const fields = objectOf(value);
    if (fields === null || typeof fields["queued"] !== "boolean" || !isNonNegInt(fields["position"])) return null;
    return { queued: fields["queued"], position: fields["position"] };
  },
  ping(value: unknown): MobileMethodResults["ping"] | null {
    const fields = objectOf(value);
    return fields !== null && isNonNegInt(fields["now"]) ? { now: fields["now"] } : null;
  },
};

/** `pair.start` 的结果（明文段） */
export function pairStartOf(value: unknown): PairStartResult | null {
  const fields = objectOf(value);
  if (fields === null) return null;
  const { offerId, expiresAt, kdf, salt, iv, box, hostBoxPublic } = fields;
  const kdfFields = objectOf(kdf);
  if (kdfFields === null) return null;
  const { name, N, r, p } = kdfFields;
  if (!isString(offerId) || !/^[0-9a-f]{32}$/.test(offerId) || !isNonNegInt(expiresAt)) return null;
  if (name !== "scrypt" || !isInt(N) || !isInt(r) || !isInt(p)) return null;
  if (!isString(salt) || !isString(iv) || !isString(box) || !isString(hostBoxPublic)) return null;
  return { offerId, expiresAt, kdf: { name, N, r, p }, salt, iv, box, hostBoxPublic };
}

/** `pair.prove` 的结果（明文段） */
export function pairProveOf(value: unknown): PairProveResult | null {
  const fields = objectOf(value);
  if (fields === null) return null;
  const { deviceId, hostProof, host } = fields;
  const hostFields = objectOf(host);
  if (!isString(deviceId) || !/^[0-9a-f]{32}$/.test(deviceId) || !isString(hostProof) || hostFields === null) return null;
  const { name, protocol } = hostFields;
  if (!isString(name) || !isInt(protocol)) return null;
  return { deviceId, hostProof, host: { name, protocol } };
}
