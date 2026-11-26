/**
 * 手机线上协议的**入站校验**——所有从网络进来的对象都从这里过（`src/shared/mobile.ts` 是契约）。
 *
 * 规矩：手写、逐字段、不认 schema 库。**未知字段、错的类型、缺字段一律拒**（`bad_request`），
 * **超长的字符串 / 超大的帧一律拒**（`too_large`）。不「尽力解析」——这台电脑上有一条通道能取回
 * 明文密钥，手机这头能碰到的每一个字节都得先证明自己长得对。校验过的是**另建的新对象**，
 * 对端发来的原对象不往下传。
 *
 * 纯模块：不 import electron / node。base64 用全局的 `atob` / `btoa` 解，再要求重新编码后一字不差
 * （规范形：带填充、末位不含冗余位、没有空白）——同一个密文只有一种写法，省得两端各算各的。
 */
import type {
  HelloBody,
  HelloFrame,
  MobileError,
  MobileMethod,
  MobileRequest,
  PairProveFrame,
  PairStartFrame,
  SealedFrame,
} from "./mobile.ts";
import {
  MOBILE_CRYPTO,
  MOBILE_FRAME_MAX_BYTES,
  MOBILE_LIMITS,
  MOBILE_METHODS,
  MOBILE_PROTOCOL_VERSION,
  isBindableAddress,
  isMobilePort,
} from "./mobile.ts";
import { SESSION_ID_PATTERN } from "./session.ts";

/** 校验的结果：成功带值，失败带一个给手机的错误 */
export type Wire<T> = { ok: true; value: T } | { ok: false; error: MobileError };

/** 手机 → 电脑的一帧：明文段的三种，或加密帧 */
export type InboundFrame = PairStartFrame | PairProveFrame | HelloFrame | SealedFrame;

/** 已认出设备之前允许出现的帧 */
export type ClearFrame = PairStartFrame | PairProveFrame | HelloFrame;

export function isClearFrame(frame: InboundFrame): frame is ClearFrame {
  return "type" in frame;
}

export function isSealedFrame(frame: InboundFrame): frame is SealedFrame {
  return !("type" in frame);
}

/** 明文段手机能发的三种帧类型 */
const CLEAR_TYPES = ["pair.start", "pair.prove", "hello"] as const;

// ————————————————————————————————————————————————————————————————
// 小工具
// ————————————————————————————————————————————————————————————————

const bad = (message: string): Wire<never> => ({ ok: false, error: { code: "bad_request", message } });
const tooLarge = (message: string): Wire<never> => ({ ok: false, error: { code: "too_large", message } });

/** 错误消息里回显的片段要短、要干净：不把对端发来的长串 / 控制字符原样吐回去 */
function echo(text: string): string {
  const clean = [...text.replace(/[\u0000-\u001f\u007f]/g, "?")].slice(0, 32).join("");
  return clean === "" ? "(empty)" : clean;
}

/** 多行文本（回复正文）之外，任何控制字符都拒 */
const CONTROL = /[\u0000-\u001f\u007f]/u;
/** 多行文本里仍然拒的：换行、回车、制表之外的控制字符 */
const CONTROL_MULTILINE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
/** 孤立的代理项（JSON.parse 会放它进来，编码成 UTF-8 时变成乱码） */
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u;

function countChars(text: string): number {
  return [...text].length;
}

type Checked<T> = { ok: true; value: T } | { ok: false; error: MobileError };

/** 对象的键必须恰好是 required ∪（optional 的子集）：多一个、少一个都不行 */
function fieldsOf(raw: unknown, required: readonly string[], optional: readonly string[] = []): Checked<Record<string, unknown>> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("expected an object");
  for (const key of Object.keys(raw)) {
    if (!required.includes(key) && !optional.includes(key)) return bad(`unknown field "${echo(key)}"`);
  }
  for (const key of required) {
    if (!(key in raw)) return bad(`missing "${key}"`);
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

function stringOf(
  value: unknown,
  name: string,
  limits: { max: number; min?: number; trim?: boolean; pattern?: RegExp; multiline?: boolean },
): Checked<string> {
  if (typeof value !== "string") return bad(`"${name}" must be a string`);
  const control = limits.multiline === true ? CONTROL_MULTILINE : CONTROL;
  if (control.test(value)) return bad(`"${name}" contains control characters`);
  if (UNPAIRED_SURROGATE.test(value)) return bad(`"${name}" contains unpaired surrogates`);
  const text = limits.trim === true ? value.trim() : value;
  const length = countChars(text);
  if (length > limits.max) return tooLarge(`"${name}" is longer than ${limits.max} characters`);
  if (limits.min !== undefined && length < limits.min) return bad(`"${name}" is too short`);
  if (limits.pattern !== undefined && !limits.pattern.test(text)) return bad(`"${name}" has an unexpected format`);
  return { ok: true, value: text };
}

function intOf(value: unknown, name: string, min: number, max: number): Checked<number> {
  if (typeof value !== "number" || !Number.isInteger(value)) return bad(`"${name}" must be an integer`);
  if (value < min || value > max) return bad(`"${name}" is out of range`);
  return { ok: true, value };
}

/**
 * 标准 base64 且是规范形。`exactly` 按解码后的字节数算；`min` 同。
 * 多给一个 `max` 时超限回 `too_large`——定长的东西长度不对是形状错，不是「太长」。
 */
function b64Of(value: unknown, name: string, size: { exactly?: number; min?: number; max?: number }): Checked<string> {
  if (typeof value !== "string") return bad(`"${name}" must be a base64 string`);
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return bad(`"${name}" is not valid base64`);
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return bad(`"${name}" is not valid base64`);
  }
  if (btoa(binary) !== value) return bad(`"${name}" is not canonical base64`);
  const bytes = binary.length;
  if (size.exactly !== undefined && bytes !== size.exactly) return bad(`"${name}" must decode to ${size.exactly} bytes`);
  if (size.min !== undefined && bytes < size.min) return bad(`"${name}" is too short`);
  if (size.max !== undefined && bytes > size.max) return tooLarge(`"${name}" is longer than ${size.max} bytes`);
  return { ok: true, value };
}

/** 子会话投递信封的开头：首行以 `<channel` 加空白起（`parseChannelPrompt` / `parseChannelBatch` 认的信封头都长这样） */
const CHANNEL_ENVELOPE = /^<channel\s/;
const sessionIdOf = (value: unknown): Checked<string> =>
  stringOf(value, "sessionId", { max: 36, pattern: SESSION_ID_PATTERN });
const deviceIdOf = (value: unknown, name = "d"): Checked<string> =>
  stringOf(value, name, { max: 32, pattern: MOBILE_CRYPTO.deviceIdPattern });
/** 解码后恰好 `bytes` 字节的 base64（定长，长度不对是形状错） */
const fixedB64 = (value: unknown, name: string, bytes: number): Checked<string> => b64Of(value, name, { exactly: bytes });

// ————————————————————————————————————————————————————————————————
// 帧
// ————————————————————————————————————————————————————————————————

/** 一行文本 → 帧：先按 UTF-8 字节数卡上限，再解析，再校验形状 */
export function parseInboundFrame(text: string): Wire<InboundFrame> {
  if (new TextEncoder().encode(text).length > MOBILE_FRAME_MAX_BYTES) {
    return tooLarge(`frame exceeds ${MOBILE_FRAME_MAX_BYTES} bytes`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("frame is not JSON");
  }
  return shapeInboundFrame(raw);
}

/** 已经 `JSON.parse` 过的一帧 → 形状 */
export function shapeInboundFrame(raw: unknown): Wire<InboundFrame> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("frame must be an object");
  const record = raw as Record<string, unknown>;
  return record["type"] === undefined ? shapeSealedFrame(record) : shapeClearFrame(record);
}

function versionOf(fields: Record<string, unknown>): MobileError | null {
  return fields["v"] === MOBILE_PROTOCOL_VERSION ? null : { code: "bad_request", message: "unsupported protocol version" };
}

/** `n` / `ct` 两个字段：加密帧与 hello 帧共用 */
function sealedBody(fields: Record<string, unknown>): Checked<Pick<SealedFrame, "n" | "ct">> {
  const n = intOf(fields["n"], "n", 1, Number.MAX_SAFE_INTEGER);
  if (!n.ok) return n;
  // 密文至少是一个 tag；上限由帧大小管（密文永远比它解出来的明文长）
  const ct = b64Of(fields["ct"], "ct", { min: MOBILE_CRYPTO.tagBytes });
  if (!ct.ok) return ct;
  return { ok: true, value: { n: n.value, ct: ct.value } };
}

function shapeClearFrame(raw: Record<string, unknown>): Wire<InboundFrame> {
  const type = raw["type"];
  if (typeof type !== "string" || !(CLEAR_TYPES as readonly string[]).includes(type)) {
    return bad(`unknown frame type "${echo(typeof type === "string" ? type : "")}"`);
  }
  const required = type === "pair.start" ? ["v", "type", "id"] : type === "pair.prove" ? ["v", "type", "id", "params"] : ["v", "type", "id", "d", "n", "ct"];
  const fields = fieldsOf(raw, required, type === "pair.start" ? ["params"] : []);
  if (!fields.ok) return fields;
  const version = versionOf(fields.value);
  if (version !== null) return { ok: false, error: version };
  const id = intOf(fields.value["id"], "id", 0, 0x7fffffff);
  if (!id.ok) return id;
  if (type === "pair.start") {
    const params = noParams(fields.value["params"]);
    return params.ok ? { ok: true, value: { v: MOBILE_PROTOCOL_VERSION, type: "pair.start", id: id.value, params: params.value } } : params;
  }
  if (type === "pair.prove") {
    const params = fieldsOf(fields.value["params"], ["offerId", "deviceBoxPublic", "deviceName", "proof"]);
    if (!params.ok) return params;
    const offerId = stringOf(params.value["offerId"], "offerId", { max: MOBILE_LIMITS.offerId, pattern: MOBILE_CRYPTO.offerIdPattern });
    if (!offerId.ok) return offerId;
    const deviceBoxPublic = fixedB64(params.value["deviceBoxPublic"], "deviceBoxPublic", MOBILE_CRYPTO.keyBytes);
    if (!deviceBoxPublic.ok) return deviceBoxPublic;
    const deviceName = stringOf(params.value["deviceName"], "deviceName", { max: MOBILE_LIMITS.deviceName, min: 1, trim: true });
    if (!deviceName.ok) return deviceName;
    const proof = fixedB64(params.value["proof"], "proof", 32);
    if (!proof.ok) return proof;
    return {
      ok: true,
      value: {
        v: MOBILE_PROTOCOL_VERSION,
        type: "pair.prove",
        id: id.value,
        params: { offerId: offerId.value, deviceBoxPublic: deviceBoxPublic.value, deviceName: deviceName.value, proof: proof.value },
      },
    };
  }
  const d = deviceIdOf(fields.value["d"]);
  if (!d.ok) return d;
  // hello 是手机方向的第一个加密帧：seq 必须是 1
  if (fields.value["n"] !== 1) return bad('"n" must be 1 for hello');
  const body = sealedBody(fields.value);
  if (!body.ok) return body;
  return { ok: true, value: { v: MOBILE_PROTOCOL_VERSION, type: "hello", id: id.value, d: d.value, n: 1, ct: body.value.ct } };
}

function shapeSealedFrame(raw: Record<string, unknown>): Wire<SealedFrame> {
  const fields = fieldsOf(raw, ["v", "n", "ct"]);
  if (!fields.ok) return fields;
  const version = versionOf(fields.value);
  if (version !== null) return { ok: false, error: version };
  const body = sealedBody(fields.value);
  if (!body.ok) return body;
  return { ok: true, value: { v: MOBILE_PROTOCOL_VERSION, ...body.value } };
}

// ————————————————————————————————————————————————————————————————
// 加密段里的请求
// ————————————————————————————————————————————————————————————————

/** 请求的 `id`：手机拿它对 应答。同一个数在一条连接里重复用是手机的事，这里只管形状 */
export function parseRequest(raw: unknown): Wire<MobileRequest> {
  const fields = fieldsOf(raw, ["id", "method"], ["params"]);
  if (!fields.ok) return fields;
  const id = intOf(fields.value["id"], "id", 0, 0x7fffffff);
  if (!id.ok) return id;
  const method = fields.value["method"];
  if (typeof method !== "string" || !(MOBILE_METHODS as readonly string[]).includes(method)) {
    return bad(`unknown method "${typeof method === "string" ? echo(method) : ""}"`);
  }
  return paramsOf(method as MobileMethod, fields.value["params"], id.value);
}

/** 无参方法的 params：缺席或空对象，别的都拒 */
function noParams(raw: unknown): Checked<Record<string, never>> {
  if (raw === undefined) return { ok: true, value: {} };
  const fields = fieldsOf(raw, []);
  return fields.ok ? { ok: true, value: {} } : fields;
}

function paramsOf(method: MobileMethod, raw: unknown, id: number): Wire<MobileRequest> {
  // 各分支都返回字面量：method 与 params 的搭配由字面量类型钉死，不靠运行时再查一遍
  const ok = (request: MobileRequest): Wire<MobileRequest> => ({ ok: true, value: request });
  switch (method) {
    case "sessions.list":
    case "sessions.watch":
    case "sessions.unwatch":
    case "ping": {
      const params = noParams(raw);
      return params.ok ? ok({ id, method, params: params.value }) : params;
    }
    case "tail.load": {
      const fields = fieldsOf(raw, ["sessionId"], ["before"]);
      if (!fields.ok) return fields;
      const sessionId = sessionIdOf(fields.value["sessionId"]);
      if (!sessionId.ok) return sessionId;
      if (fields.value["before"] === undefined) return ok({ id, method, params: { sessionId: sessionId.value } });
      const before = stringOf(fields.value["before"], "before", { max: MOBILE_LIMITS.recordId, min: 1 });
      if (!before.ok) return before;
      return ok({ id, method, params: { sessionId: sessionId.value, before: before.value } });
    }
    case "tail.watch":
    case "tail.unwatch":
    case "stop":
    case "unread.clear": {
      const fields = fieldsOf(raw, ["sessionId"]);
      if (!fields.ok) return fields;
      const sessionId = sessionIdOf(fields.value["sessionId"]);
      if (!sessionId.ok) return sessionId;
      return ok({ id, method, params: { sessionId: sessionId.value } });
    }
    case "reply": {
      const fields = fieldsOf(raw, ["sessionId", "text", "requestId"]);
      if (!fields.ok) return fields;
      const sessionId = sessionIdOf(fields.value["sessionId"]);
      if (!sessionId.ok) return sessionId;
      const text = stringOf(fields.value["text"], "text", { max: MOBILE_LIMITS.replyText, min: 1, trim: true, multiline: true });
      if (!text.ok) return text;
      // 子会话投递信封的开头：会被当成「父会话发来的话」而不是用户说的，跳过指令预处理——手机这条路直接拒
      if (CHANNEL_ENVELOPE.test(text.value)) return bad('"text" looks like a channel delivery envelope');
      const requestId = stringOf(fields.value["requestId"], "requestId", { max: MOBILE_LIMITS.requestId, min: 1 });
      if (!requestId.ok) return requestId;
      return ok({ id, method, params: { sessionId: sessionId.value, text: text.value, requestId: requestId.value } });
    }
  }
  return bad("unknown method");
}

/** `hello` 的密文里解开的东西：`{ pn, name? }`。名字想改才带，可以是空串 */
export function parseHelloBody(raw: unknown): Wire<HelloBody> {
  const fields = fieldsOf(raw, ["pn"], ["name"]);
  if (!fields.ok) return fields;
  const pn = fixedB64(fields.value["pn"], "pn", MOBILE_CRYPTO.nonceBytes);
  if (!pn.ok) return pn;
  if (fields.value["name"] === undefined) return { ok: true, value: { pn: pn.value } };
  const name = stringOf(fields.value["name"], "name", { max: MOBILE_LIMITS.deviceName, trim: true });
  return name.ok ? { ok: true, value: { pn: pn.value, name: name.value } } : name;
}

// ————————————————————————————————————————————————————————————————
// 设置 IPC 的入参（renderer → 主进程）
// ————————————————————————————————————————————————————————————————

/** `mobile:set-bind` 的载荷：只许绑候选里那一类地址，端口 1–65535 */
export function parseSetBind(raw: unknown): Wire<{ address: string; port: number }> {
  const fields = fieldsOf(raw, ["address", "port"]);
  if (!fields.ok) return fields;
  const address = stringOf(fields.value["address"], "address", { max: 45, trim: true });
  if (!address.ok) return address;
  if (!isBindableAddress(address.value)) return bad("this address cannot be bound");
  const port = fields.value["port"];
  if (!isMobilePort(port)) return bad(`"port" must be an integer between 1 and 65535`);
  return { ok: true, value: { address: address.value, port } };
}

/** `mobile:revoke` 的载荷 */
export function parseDeviceId(raw: unknown): Wire<string> {
  return deviceIdOf(raw, "deviceId");
}
