import { test } from "node:test";
import assert from "node:assert/strict";
import { INBOUND_WIRE_MAX_BYTES, pairProveOf, pairStartOf, parseHostFrame, parseSealedPayload, resultOf, sessionOf } from "./wire.ts";

const session = {
  id: "0199a0aa-6bb0-7cc0-8000-123456789012",
  title: "审 PR 565",
  workspaceId: "ws",
  workspaceName: "orbita",
  state: "done",
  lastLine: "看完了",
  updatedAt: 1_700_000_000_000,
  childrenRunning: 0,
};

test("帧的四种外壳各认得出；版本不对、超长、不是 JSON 都不认", () => {
  assert.equal(parseHostFrame('{"v":1,"type":"host.hello","nonce":"AAAA"}')?.kind, "hostHello");
  assert.equal(parseHostFrame('{"v":1,"id":1,"ok":true,"result":{}}')?.kind, "clearReply");
  // 形状不对的请求电脑回 id = 0：照样认得出
  assert.deepEqual(parseHostFrame('{"v":1,"id":0,"ok":false,"error":{"code":"bad_request","message":"x"}}'), {
    kind: "clearReply",
    id: 0,
    ok: false,
    error: { code: "bad_request", message: "x" },
  });
  assert.equal(parseHostFrame('{"v":1,"d":"ab","n":1,"ct":"AAAA"}')?.kind, "handshake");
  assert.equal(parseHostFrame('{"v":1,"d":"ab","n":2,"ct":"AAAA"}'), null);
  assert.equal(parseHostFrame('{"v":1,"n":3,"ct":"AAAA"}')?.kind, "sealed");
  assert.equal(parseHostFrame('{"v":2,"n":3,"ct":"AAAA"}'), null);
  assert.equal(parseHostFrame('{"v":1,"n":0,"ct":"AAAA"}'), null);
  assert.equal(parseHostFrame('{"v":1,"type":"pair.start","id":1}'), null);
  assert.equal(parseHostFrame("not json"), null);
  assert.equal(parseHostFrame(`{"v":1,"n":1,"ct":"${"A".repeat(INBOUND_WIRE_MAX_BYTES)}"}`), null);
  // 未知错误码按 internal
  const frame = parseHostFrame('{"v":1,"id":2,"ok":false,"error":{"code":"teapot","message":"x"}}');
  assert.ok(frame?.kind === "clearReply" && !frame.ok && frame.error.code === "internal");
});

test("出站上限 256 KB 的明文加密后仍在入站上限之内", () => {
  const ct = Math.ceil((256 * 1024 + 16) / 3) * 4;
  assert.ok(`{"v":1,"n":9007199254740991,"ct":""}`.length + ct <= INBOUND_WIRE_MAX_BYTES);
});

test("应答与五种通知；清单里坏的那条丢掉、好的照收", () => {
  assert.deepEqual(parseSealedPayload('{"id":3,"ok":true,"result":null}'), { kind: "reply", id: 3, ok: true, result: null });
  const changed = parseSealedPayload(JSON.stringify({ event: "sessions.changed", params: { sessions: [session, { id: 1 }], removed: ["x", 2] } }));
  assert.ok(changed?.kind === "notification" && changed.notification.event === "sessions.changed");
  assert.deepEqual(changed.notification.params, { sessions: [session], removed: ["x"] });
  assert.equal(parseSealedPayload('{"event":"tail.changed","params":{"sessionId":"s","rev":4}}')?.kind, "notification");
  assert.equal(parseSealedPayload('{"event":"reply.sent","params":{"requestId":"r"}}')?.kind, "notification");
  assert.equal(parseSealedPayload('{"event":"reply.failed","params":{"requestId":"r","error":{"code":"busy","message":"m"}}}')?.kind, "notification");
  assert.equal(parseSealedPayload('{"event":"host.shutdown","params":{}}')?.kind, "notification");
  assert.equal(parseSealedPayload('{"event":"what","params":{}}'), null);
  assert.equal(parseSealedPayload('{"event":"tail.changed","params":{"sessionId":"s"}}'), null);
});

test("会话摘要、尾部、各方法结果的形状", () => {
  assert.deepEqual(sessionOf(session), session);
  assert.equal(sessionOf({ ...session, state: "sleeping" }), null);
  assert.equal(sessionOf({ ...session, updatedAt: -1 }), null);
  assert.deepEqual(sessionOf({ ...session, workspaceId: null, workspaceName: null, lastLine: null }), {
    ...session,
    workspaceId: null,
    workspaceName: null,
    lastLine: null,
  });
  assert.deepEqual(
    resultOf["tail.load"]({ entries: [{ id: "a", at: 1, kind: "process", steps: 3, failed: 1 }], hasMore: true, rev: 2 }),
    { entries: [{ id: "a", at: 1, kind: "process", steps: 3, failed: 1 }], hasMore: true, rev: 2 },
  );
  assert.equal(resultOf["tail.load"]({ entries: [{ id: "a", at: 1, kind: "tool" }], hasMore: false, rev: 0 }), null);
  assert.deepEqual(resultOf.reply({ queued: true, position: 1 }), { queued: true, position: 1 });
  assert.equal(resultOf.reply({ queued: "yes", position: 1 }), null);
  assert.equal(resultOf["sessions.list"]({ sessions: [], truncated: 1 }), null);
});

test("配对的两种结果", () => {
  const start = {
    offerId: "0123456789abcdef0123456789abcdef",
    expiresAt: 1,
    kdf: { name: "scrypt", N: 131072, r: 8, p: 1 },
    salt: "a",
    iv: "b",
    box: "c",
    hostBoxPublic: "d",
  };
  assert.deepEqual(pairStartOf(start), start);
  assert.equal(pairStartOf({ ...start, offerId: "XYZ" }), null);
  assert.equal(pairStartOf({ ...start, kdf: { name: "argon2", N: 1, r: 1, p: 1 } }), null);
  const prove = { deviceId: "fedcba9876543210fedcba9876543210", hostProof: "x", host: { name: "mac", protocol: 1 } };
  assert.deepEqual(pairProveOf(prove), prove);
  assert.equal(pairProveOf({ ...prove, host: null }), null);
});
