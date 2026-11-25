import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isClearFrame,
  isSealedFrame,
  parseDeviceId,
  parseHelloName,
  parseInboundFrame,
  parseRequest,
  parseSetBind,
  shapeInboundFrame,
  type InboundFrame,
  type Wire,
} from "./mobile-wire.ts";
import { MOBILE_FRAME_MAX_BYTES, MOBILE_LIMITS } from "./mobile.ts";

const SESSION = "0199a0aa-6bb0-7cc0-8000-123456789012";
const DEVICE = "0123456789abcdef0123456789abcdef";
/** 64 字节全 0 的 base64（签名长度） */
const SIG = Buffer.alloc(64).toString("base64");
/** 16 字节全 0 的 base64（一个 GCM tag，最短的合法密文） */
const CT = Buffer.alloc(16).toString("base64");

/** 把失败收成一个短字符串，断言时一眼看得出是哪一类 */
function failure<T>(result: Wire<T>): string {
  return result.ok ? "ok" : `${result.error.code}: ${result.error.message}`;
}

describe("帧的解析：形状", () => {
  test("三种明文帧与加密帧各认各的形状，认出来的是另建的新对象", () => {
    const start = parseInboundFrame(JSON.stringify({ v: 1, type: "pair.start", id: 1, params: { deviceName: "wafo 的 Pixel" } }));
    assert.ok(start.ok && isClearFrame(start.value));
    assert.deepEqual(start.value, { v: 1, type: "pair.start", id: 1, params: { deviceName: "wafo 的 Pixel" } });

    const prove = parseInboundFrame(JSON.stringify({ v: 1, type: "pair.prove", id: 2, params: { offerId: "o-1", sig: SIG } }));
    assert.ok(prove.ok);
    assert.deepEqual(prove.value, { v: 1, type: "pair.prove", id: 2, params: { offerId: "o-1", sig: SIG } });

    const hello = parseInboundFrame(JSON.stringify({ v: 1, type: "hello", id: 1, d: DEVICE, n: 1, ct: CT }));
    assert.ok(hello.ok && isClearFrame(hello.value));
    assert.deepEqual(hello.value, { v: 1, type: "hello", id: 1, d: DEVICE, n: 1, ct: CT });

    const sealed = parseInboundFrame(JSON.stringify({ v: 1, d: DEVICE, n: 7, ct: CT }));
    assert.ok(sealed.ok && isSealedFrame(sealed.value) && !isClearFrame(sealed.value));
    assert.deepEqual(sealed.value, { v: 1, d: DEVICE, n: 7, ct: CT });
  });

  test("不是 JSON、不是对象、版本不对、不认识的帧类型", () => {
    assert.equal(failure(parseInboundFrame("{nope")), "bad_request: frame is not JSON");
    assert.equal(failure(parseInboundFrame("[1,2]")), "bad_request: frame must be an object");
    assert.equal(failure(parseInboundFrame("7")), "bad_request: frame must be an object");
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 2, type: "pair.start", id: 1, params: { deviceName: "x" } }))), "bad_request: unsupported protocol version");
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 2, d: DEVICE, n: 1, ct: CT }))), "bad_request: unsupported protocol version");
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 1, type: "ping", id: 1 }))), 'bad_request: unknown frame type "ping"');
  });

  test("加密帧的 seq 从 1 起；设备 id 必须是 32 个小写十六进制字符", () => {
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 2, d: DEVICE, n: 1, ct: CT }))), "bad_request: unsupported protocol version");
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 1, d: DEVICE, n: 1.5, ct: CT }))), 'bad_request: "n" must be an integer');
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 1, d: DEVICE.toUpperCase(), n: 1, ct: CT }))), 'bad_request: "d" has an unexpected format');
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 1, d: DEVICE.repeat(2), n: 1, ct: CT }))), 'too_large: "d" is longer than 32 characters');
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 1, d: DEVICE, n: 1, ct: "!!!" }))), 'bad_request: "ct" is not valid base64');
  });
});

describe("帧的解析：未知字段", () => {
  test("明文帧多一个字段就拒，错误里说出是哪个", () => {
    const extra = parseInboundFrame(JSON.stringify({ v: 1, type: "pair.start", id: 1, params: { deviceName: "x" }, token: "abc" }));
    assert.equal(failure(extra), 'bad_request: unknown field "token"');
    const nested = parseInboundFrame(JSON.stringify({ v: 1, type: "pair.prove", id: 1, params: { offerId: "o", sig: SIG, name: "x" } }));
    assert.equal(failure(nested), 'bad_request: unknown field "name"');
    const sealed = parseInboundFrame(JSON.stringify({ v: 1, d: DEVICE, n: 1, ct: CT, id: 3 }));
    assert.equal(failure(sealed), 'bad_request: unknown field "id"');
  });

  test("缺字段也拒", () => {
    assert.equal(failure(parseInboundFrame(JSON.stringify({ v: 1, type: "pair.start", id: 1 }))), 'bad_request: missing "params"');
    assert.equal(failure(parseInboundFrame(JSON.stringify({ type: "hello", id: 1, d: DEVICE, n: 1, ct: CT }))), 'bad_request: missing "v"');
  });

  test("回显的字段名截短、去掉控制字符——不把对端发来的长串吐回去", () => {
    const long = shapeInboundFrame({ v: 1, d: DEVICE, n: 1, ct: CT, ["k".repeat(40)]: 1 });
    assert.equal(failure(long), `bad_request: unknown field "${"k".repeat(32)}"`);
    const ansi = shapeInboundFrame({ v: 1, d: DEVICE, n: 1, ct: CT, ["ab\u001b[31mclear\u0007"]: 1 });
    assert.equal(failure(ansi), 'bad_request: unknown field "ab?[31mclear?"');
  });
});

describe("帧的解析：错的类型与格式", () => {
  test("pair.start 的 id 与 deviceName", () => {
    const frame = (id: unknown, deviceName: unknown): Wire<InboundFrame> =>
      shapeInboundFrame({ v: 1, type: "pair.start", id, params: { deviceName } });
    assert.equal(failure(frame("1", "x")), 'bad_request: "id" must be an integer');
    assert.equal(failure(frame(-1, "x")), 'bad_request: "id" is out of range');
    assert.equal(failure(frame(1.5, "x")), 'bad_request: "id" must be an integer');
    assert.equal(failure(frame(1, 42)), 'bad_request: "deviceName" must be a string');
    assert.equal(failure(frame(1, "   ")), 'bad_request: "deviceName" is too short');
    assert.equal(failure(frame(1, "bad\u0000name")), 'bad_request: "deviceName" contains control characters');
    assert.equal(failure(frame(1, "line\nbreak")), 'bad_request: "deviceName" contains control characters');
    assert.equal(failure(frame(1, "\ud83d")), 'bad_request: "deviceName" contains unpaired surrogates');
    // 首尾空白去掉后收下
    const trimmed = frame(1, "  我的手机  ");
    assert.ok(trimmed.ok);
    assert.equal(isClearFrame(trimmed.value) && trimmed.value.type === "pair.start" ? trimmed.value.params.deviceName : "", "我的手机");
  });

  test("pair.prove 的 offerId 与签名", () => {
    const frame = (offerId: unknown, sig: unknown): Wire<unknown> =>
      shapeInboundFrame({ v: 1, type: "pair.prove", id: 1, params: { offerId, sig } });
    assert.equal(failure(frame("../x", SIG)), 'bad_request: "offerId" has an unexpected format');
    assert.equal(failure(frame("o", SIG.slice(0, -4))), 'bad_request: "sig" must decode to 64 bytes');
    assert.equal(failure(frame("o", Buffer.alloc(63).toString("base64"))), 'bad_request: "sig" must decode to 64 bytes');
    assert.equal(failure(frame("o", Buffer.alloc(65).toString("base64"))), 'bad_request: "sig" must decode to 64 bytes');
  });

  test("base64 必须是规范形：缺填充、末位冗余、夹空白都拒", () => {
    // 32 字节 → 44 个字符：43 个数据字符 + 一个「=」；最后一个数据字符只带 4 个有效位
    const canonical = Buffer.alloc(32, 0xab).toString("base64");
    assert.equal(canonical.length, 44);
    assert.equal(canonical.at(-1), "=");
    assert.deepEqual(bytesOfShape(canonical), { ok: true, value: { v: 1, d: DEVICE, n: 1, ct: canonical } });
    assert.equal(failure(bytesOfShape(canonical.slice(0, 43))), 'bad_request: "ct" is not valid base64'); // 缺填充
    // 末位冗余位：换成一个只差冗余位的字符——解出来一样，但不是规范形
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const lastIndex = alphabet.indexOf(canonical[42] ?? "!");
    assert.equal(lastIndex % 4, 0);
    const redundant = `${canonical.slice(0, 42)}${alphabet[lastIndex + 1]}=`;
    assert.equal(Buffer.from(redundant, "base64").equals(Buffer.alloc(32, 0xab)), true);
    assert.equal(failure(bytesOfShape(redundant)), 'bad_request: "ct" is not canonical base64');
    assert.equal(failure(bytesOfShape(` ${canonical}`.slice(0, 44))), 'bad_request: "ct" is not valid base64'); // 夹空白
    assert.equal(failure(bytesOfShape(`${canonical.slice(0, 43)}-`)), 'bad_request: "ct" is not valid base64'); // base64url 的字母表
    assert.equal(failure(bytesOfShape("A===")), 'bad_request: "ct" is not valid base64'); // 多余的填充
  });
});

function bytesOfShape(ct: string): Wire<unknown> {
  return shapeInboundFrame({ v: 1, d: DEVICE, n: 1, ct });
}

describe("帧的解析：超长", () => {
  test("帧超过 256 KB 拒成 too_large（按 UTF-8 字节算，中文算 3 个）", () => {
    const pad = "中".repeat(Math.floor(MOBILE_FRAME_MAX_BYTES / 3) + 1);
    const frame = JSON.stringify({ v: 1, type: "pair.start", id: 1, params: { deviceName: pad } });
    const bytes = new TextEncoder().encode(frame).length;
    // 按 UTF-8 字节算：字符数没到上限，字节数到了
    assert.ok(frame.length < MOBILE_FRAME_MAX_BYTES && bytes > MOBILE_FRAME_MAX_BYTES, `${frame.length} / ${bytes}`);
    assert.equal(failure(parseInboundFrame(frame)), "too_large: frame exceeds 262144 bytes");
  });

  test("字段超长：定长的东西是形状错，变长的东西是 too_large", () => {
    const longName = shapeInboundFrame({ v: 1, type: "pair.start", id: 1, params: { deviceName: "名".repeat(MOBILE_LIMITS.deviceName + 1) } });
    assert.equal(failure(longName), `too_large: "deviceName" is longer than ${MOBILE_LIMITS.deviceName} characters`);
    const okName = shapeInboundFrame({ v: 1, type: "pair.start", id: 1, params: { deviceName: "名".repeat(MOBILE_LIMITS.deviceName) } });
    assert.ok(okName.ok);
    const longOffer = shapeInboundFrame({ v: 1, type: "pair.prove", id: 1, params: { offerId: "a".repeat(MOBILE_LIMITS.offerId + 1), sig: SIG } });
    assert.equal(failure(longOffer), `too_large: "offerId" is longer than ${MOBILE_LIMITS.offerId} characters`);
  });
});

describe("加密段里的请求", () => {
  test("十个方法都认；无参方法的 params 可以不给或给空对象", () => {
    assert.ok(parseRequest({ id: 1, method: "sessions.list" }).ok);
    assert.ok(parseRequest({ id: 1, method: "ping", params: {} }).ok);
    assert.ok(parseRequest({ id: 0, method: "sessions.watch", params: {} }).ok);
    assert.equal(failure(parseRequest({ id: 1, method: "sessions.list", params: { extra: 1 } })), 'bad_request: unknown field "extra"');
    assert.equal(failure(parseRequest({ id: 1, method: "provider.reveal" })), 'bad_request: unknown method "provider.reveal"');
    assert.equal(failure(parseRequest({ id: 1, method: "__proto__" })), 'bad_request: unknown method "__proto__"');
    assert.equal(failure(parseRequest({ id: 1, method: "constructor" })), 'bad_request: unknown method "constructor"');
  });

  test("reply：sessionId、text、requestId 三个都要，形状要对", () => {
    const good = parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "  继续做  ", requestId: "r-1" } });
    assert.ok(good.ok);
    assert.deepEqual(good.value, { id: 5, method: "reply", params: { sessionId: SESSION, text: "继续做", requestId: "r-1" } });
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "  \n ", requestId: "r" } })), 'bad_request: "text" is too short');
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "x".repeat(MOBILE_LIMITS.replyText + 1), requestId: "r" } })), `too_large: "text" is longer than ${MOBILE_LIMITS.replyText} characters`);
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "a\u0000b", requestId: "r" } })), 'bad_request: "text" contains control characters');
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: 7, requestId: "r" } })), 'bad_request: "text" must be a string');
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "x" } })), 'bad_request: missing "requestId"');
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "x", requestId: "" } })), 'bad_request: "requestId" is too short');
    assert.equal(failure(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "x", requestId: "r", cwd: "/" } })), 'bad_request: unknown field "cwd"');
    // 回复正文允许换行、回车、制表
    assert.ok(parseRequest({ id: 5, method: "reply", params: { sessionId: SESSION, text: "第一行\n\t缩进\r\n第三行", requestId: "r" } }).ok);
  });

  test("sessionId 必须长得像会话 id——拼路径用的，不许带别的", () => {
    for (const bad of ["../../secrets.json", SESSION.toUpperCase(), SESSION.replace(/-/g, ""), ""]) {
      assert.equal(failure(parseRequest({ id: 1, method: "stop", params: { sessionId: bad } })), 'bad_request: "sessionId" has an unexpected format');
    }
    assert.equal(failure(parseRequest({ id: 1, method: "stop", params: { sessionId: 42 } })), 'bad_request: "sessionId" must be a string');
    assert.equal(failure(parseRequest({ id: 1, method: "stop" })), 'bad_request: expected an object');
    assert.equal(failure(parseRequest({ id: 1, method: "stop", params: { sessionId: SESSION, extra: true } })), 'bad_request: unknown field "extra"');
  });

  test("tail.load 的 before 可给可不给", () => {
    const withoutBefore = parseRequest({ id: 1, method: "tail.load", params: { sessionId: SESSION } });
    assert.ok(withoutBefore.ok);
    assert.deepEqual(withoutBefore.value, { id: 1, method: "tail.load", params: { sessionId: SESSION } });
    const withBefore = parseRequest({ id: 1, method: "tail.load", params: { sessionId: SESSION, before: "item-7" } });
    assert.ok(withBefore.ok);
    assert.deepEqual(withBefore.value, { id: 1, method: "tail.load", params: { sessionId: SESSION, before: "item-7" } });
    assert.equal(failure(parseRequest({ id: 1, method: "tail.load", params: { sessionId: SESSION, before: "" } })), 'bad_request: "before" is too short');
    assert.equal(
      failure(parseRequest({ id: 1, method: "tail.load", params: { sessionId: SESSION, before: "x".repeat(MOBILE_LIMITS.recordId + 1) } })),
      `too_large: "before" is longer than ${MOBILE_LIMITS.recordId} characters`,
    );
    assert.equal(failure(parseRequest({ id: 1, method: "tail.load", params: { sessionId: SESSION, before: 3 } })), 'bad_request: "before" must be a string');
  });

  test("其余带 sessionId 的方法；请求 id 的范围", () => {
    for (const method of ["tail.watch", "tail.unwatch", "stop", "unread.clear"]) {
      assert.ok(parseRequest({ id: 1, method, params: { sessionId: SESSION } }).ok, method);
      assert.equal(failure(parseRequest({ id: 1, method, params: { sessionId: SESSION, before: "x" } })), 'bad_request: unknown field "before"', method);
    }
    assert.equal(failure(parseRequest({ id: 0x80000000, method: "ping" })), 'bad_request: "id" is out of range');
    assert.equal(failure(parseRequest({ method: "ping" })), 'bad_request: missing "id"');
    assert.equal(failure(parseRequest({ id: 1, method: 1 })), 'bad_request: unknown method ""');
    assert.equal(failure(parseRequest("ping")), "bad_request: expected an object");
    assert.equal(failure(parseRequest([1, "ping"])), "bad_request: expected an object");
  });
});

describe("hello 密文里的名字与设置 IPC 的入参", () => {
  test("hello 里只许 name；可以是空串", () => {
    assert.deepEqual(parseHelloName({ name: " 我的手机 " }), { ok: true, value: { name: "我的手机" } });
    assert.deepEqual(parseHelloName({ name: "" }), { ok: true, value: { name: "" } });
    assert.equal(failure(parseHelloName({ name: "x", token: "y" })), 'bad_request: unknown field "token"');
    assert.equal(failure(parseHelloName({})), 'bad_request: missing "name"');
    assert.equal(failure(parseHelloName({ name: "x".repeat(MOBILE_LIMITS.deviceName + 1) })), `too_large: "name" is longer than ${MOBILE_LIMITS.deviceName} characters`);
  });

  test("set-bind：只许绑候选里那一类地址，端口 1–65535", () => {
    assert.deepEqual(parseSetBind({ address: " 100.100.1.2 ", port: 47620 }), { ok: true, value: { address: "100.100.1.2", port: 47620 } });
    assert.equal(failure(parseSetBind({ address: "203.0.113.5", port: 47620 })), "bad_request: this address cannot be bound");
    assert.equal(failure(parseSetBind({ address: "0.0.0.0", port: 47620 })), "bad_request: this address cannot be bound");
    assert.equal(failure(parseSetBind({ address: "100.100.1.2", port: 0 })), 'bad_request: "port" must be an integer between 1 and 65535');
    assert.equal(failure(parseSetBind({ address: "100.100.1.2", port: "47620" })), 'bad_request: "port" must be an integer between 1 and 65535');
    assert.equal(failure(parseSetBind({ address: "100.100.1.2" })), 'bad_request: missing "port"');
    assert.equal(failure(parseSetBind({ address: "100.100.1.2", port: 47620, host: "x" })), 'bad_request: unknown field "host"');
    assert.equal(failure(parseSetBind(null)), "bad_request: expected an object");
  });

  test("revoke 的载荷是设备 id", () => {
    assert.deepEqual(parseDeviceId(DEVICE), { ok: true, value: DEVICE });
    assert.equal(failure(parseDeviceId("not-a-device")), 'bad_request: "deviceId" has an unexpected format');
  });
});
