import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import type { DictationEvent, VoiceFailure } from "../../shared/voice.ts";
import { DoubaoAsr, type OpenSocket, type SocketHandlers } from "./doubao-asr.ts";

const CREDS = { appId: "app", accessToken: "token", resourceId: "volc.seedasr.sauc.duration" };

/** 可遥控的 socket 替身：记下发出去的帧与请求头，测试决定何时 open / 收消息 / 关 */
function fakeSockets() {
  const opened: { headers: Record<string, string>; handlers: SocketHandlers; sent: Uint8Array[]; closed: boolean }[] = [];
  const openSocket: OpenSocket = (_url, headers, handlers) => {
    const entry = { headers, handlers, sent: [] as Uint8Array[], closed: false };
    opened.push(entry);
    return {
      send: (data) => entry.sent.push(data),
      close: () => {
        entry.closed = true;
      },
    };
  };
  return { opened, openSocket };
}

function resultFrame(text: string, last = false): Buffer {
  const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text } }), "utf8"));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([Buffer.from([0x11, 0x90 | (last ? 0b0010 : 0), 0x11, 0]), size, payload]);
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("start：带三样鉴权头连上后先发首帧；音频按帧转发；结果推给发起方", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "network" }) });
  const events: DictationEvent[] = [];
  const started = asr.start("s1", 7, CREDS, (event) => events.push(event));
  const socket = opened[0];
  assert.ok(socket !== undefined);
  assert.equal(socket.headers["X-Api-App-Key"], "app");
  assert.equal(socket.headers["X-Api-Access-Key"], "token");
  assert.equal(socket.headers["X-Api-Resource-Id"], "volc.seedasr.sauc.duration");
  assert.ok((socket.headers["X-Api-Connect-Id"] ?? "") !== "");
  socket.handlers.onOpen();
  assert.deepEqual(await started, { ok: true });
  assert.equal(socket.sent[0]?.[1], 0x10, "首帧是完整请求");

  asr.audio("s1", new Uint8Array([1, 2]));
  assert.equal(socket.sent[1]?.[1], 0x20, "音频帧");
  asr.audio("s1", new Uint8Array());
  assert.equal(socket.sent.length, 2, "空段不发");

  socket.handlers.onMessage(resultFrame("你好"));
  assert.deepEqual(events, [{ sessionId: "s1", kind: "transcript", text: "你好", final: false }]);
});

test("stop：发最后一包，服务端推完最终结果再关，回来时结果已推过；之后的音频静默丢弃", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "network" }) });
  const events: DictationEvent[] = [];
  const started = asr.start("s1", 7, CREDS, (event) => events.push(event));
  const socket = opened[0]!;
  socket.handlers.onOpen();
  await started;
  const stopped = asr.stop("s1");
  assert.equal(socket.sent.at(-1)?.[1], 0x22, "最后一包带标志");
  socket.handlers.onMessage(resultFrame("你好世界。", true));
  socket.handlers.onClose();
  await stopped;
  assert.deepEqual(events, [
    { sessionId: "s1", kind: "transcript", text: "你好世界。", final: true },
    { sessionId: "s1", kind: "ended" },
  ]);
  const before = socket.sent.length;
  asr.audio("s1", new Uint8Array([1]));
  assert.equal(socket.sent.length, before);
});

test("stop：服务端迟迟不关就到点强关，按正常结束通知一次", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "network" }), stopTimeoutMs: 10 });
  const events: DictationEvent[] = [];
  const started = asr.start("s1", 7, CREDS, (event) => events.push(event));
  opened[0]!.handlers.onOpen();
  await started;
  await asr.stop("s1");
  assert.equal(opened[0]!.closed, true);
  assert.deepEqual(events, [{ sessionId: "s1", kind: "ended" }]);
  // 迟到的关闭不再多推一次
  opened[0]!.handlers.onClose();
  assert.equal(events.length, 1);
});

test("服务端停顿收尾（连着时被关）推 ended；错误帧推 server 错误并断开，之后不再推 ended", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "network" }) });
  const events: DictationEvent[] = [];
  const first = asr.start("a", 1, CREDS, (event) => events.push(event));
  opened[0]!.handlers.onOpen();
  await first;
  opened[0]!.handlers.onClose();
  assert.deepEqual(events.at(-1), { sessionId: "a", kind: "ended" });

  const second = asr.start("b", 1, CREDS, (event) => events.push(event));
  opened[1]!.handlers.onOpen();
  await second;
  const message = Buffer.from("bad audio", "utf8");
  const code = Buffer.alloc(4);
  code.writeUInt32BE(45000002, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(message.length, 0);
  opened[1]!.handlers.onMessage(Buffer.concat([Buffer.from([0x11, 0xf0, 0x10, 0]), code, size, message]));
  assert.deepEqual(events.at(-1), { sessionId: "b", kind: "error", reason: "server", detail: "45000002 bad audio" });
  assert.equal(opened[1]!.closed, true);
  opened[1]!.handlers.onClose();
  assert.equal(events.at(-1)?.kind, "error");
});

test("握手失败：error 与 close 前后脚来只诊断一次，原因原样回给调用方", async () => {
  const { opened, openSocket } = fakeSockets();
  let diagnosed = 0;
  const failure: VoiceFailure = { reason: "unauthorized", detail: '401 {"error":"load grant"}' };
  const asr = new DoubaoAsr({
    openSocket,
    diagnose: async () => {
      diagnosed += 1;
      return failure;
    },
  });
  const started = asr.start("s1", 7, CREDS, () => undefined);
  opened[0]!.handlers.onError();
  opened[0]!.handlers.onClose();
  assert.deepEqual(await started, { ok: false, ...failure });
  assert.equal(diagnosed, 1);
});

test("连接超时回 timeout 并关掉 socket；之后才到的 open 不算数", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "network" }), connectTimeoutMs: 10 });
  const result = await asr.start("s1", 7, CREDS, () => undefined);
  assert.deepEqual(result, { ok: false, reason: "timeout" });
  assert.equal(opened[0]!.closed, true);
  opened[0]!.handlers.onOpen();
  await tick();
  assert.equal(opened[0]!.sent.length, 0);
});

test("cancel 立刻断开且不再推事件；cancelOwner 只收那个窗口的连接", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "network" }) });
  const events: DictationEvent[] = [];
  const a = asr.start("a", 1, CREDS, (event) => events.push(event));
  const b = asr.start("b", 2, CREDS, (event) => events.push(event));
  opened[0]!.handlers.onOpen();
  opened[1]!.handlers.onOpen();
  await Promise.all([a, b]);
  asr.cancel("a");
  assert.equal(opened[0]!.closed, true);
  opened[0]!.handlers.onMessage(resultFrame("迟到的"));
  opened[0]!.handlers.onClose();
  assert.deepEqual(events, []);
  asr.cancelOwner(2);
  assert.equal(opened[1]!.closed, true);
});

test("test：连上即关，回 ok；连不上回诊断结果", async () => {
  const { opened, openSocket } = fakeSockets();
  const asr = new DoubaoAsr({ openSocket, diagnose: async () => ({ reason: "unauthorized", detail: "401" }) });
  const ok = asr.test(CREDS);
  opened[0]!.handlers.onOpen();
  assert.deepEqual(await ok, { ok: true });
  assert.equal(opened[0]!.closed, true);
  const bad = asr.test(CREDS);
  opened[1]!.handlers.onError();
  assert.deepEqual(await bad, { ok: false, reason: "unauthorized", detail: "401" });
});
