import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, type RawData } from "ws";
import type { SessionMeta } from "../../shared/session.ts";
import type { HostInfo, PairProveResult, PairStartResult } from "../../shared/mobile.ts";
import { MOBILE_PATH, MOBILE_PROTOCOL_VERSION } from "../../shared/mobile.ts";
import {
  boxKeyPairFromRaw,
  boxPrivateKeyFromRaw,
  channelKey,
  generateBoxKeyPair,
  helloKey,
  hostProofOf,
  openFrame,
  openPairingBox,
  pairMessage,
  pairProofOf,
  sealFrame,
  sharedSecret,
} from "./crypto.ts";
import type { HostCrypto } from "./host-keys.ts";
import { MobileCatalog } from "./summaries.ts";
import { MobileServer } from "./server.ts";
import { MobileStore } from "./store.ts";
import { MobileTails } from "./tails.ts";
import { ReplyQueue } from "./replies.ts";

const SESSION = "0199a0aa-6bb0-7cc0-8000-123456789012";
const HOST = boxKeyPairFromRaw(Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex"));
const lite = (code: Buffer, salt: Buffer): Promise<Buffer> => Promise.resolve(createHash("sha256").update(code).update(salt).digest());

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no test port"));
        return;
      }
      const { port } = address;
      probe.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}

/** 一个很小的手机客户端：帧先排队，测试按到达顺序取 */
class Phone {
  readonly socket: WebSocket;
  readonly closed: Promise<void>;
  private readonly frames: Record<string, unknown>[] = [];
  private readonly waiting: ((frame: Record<string, unknown>) => void)[] = [];
  private closeResolve: (() => void) | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closed = new Promise((resolve) => {
      this.closeResolve = resolve;
    });
    socket.on("message", (data: RawData) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      const resolve = this.waiting.shift();
      if (resolve === undefined) this.frames.push(frame);
      else resolve(frame);
    });
    socket.on("close", () => this.closeResolve?.());
  }

  static async open(port: number): Promise<Phone> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        return await new Promise<Phone>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}${MOBILE_PATH}`);
          socket.once("open", () => resolve(new Phone(socket)));
          socket.once("error", reject);
        });
      } catch (cause) {
        lastError = cause;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  send(frame: object): void {
    this.socket.send(JSON.stringify(frame));
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("等手机帧超时")), 2_000);
      this.waiting.push((frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
  }

  close(): void {
    this.socket.terminate();
  }
}

const meta: SessionMeta = {
  id: SESSION,
  title: "手机集成测试",
  titleSource: "auto",
  cwd: "/repo",
  workspaceId: "ws",
  providerId: "zai",
  modelId: "glm-5.3",
  mode: "plan",
  thinkingLevel: "medium",
  piSessionFile: "/data/pi-sessions/a.jsonl",
  pinned: false,
  archived: false,
  recentQueries: [],
  stats: null,
  createdAt: 1,
  updatedAt: Date.now(),
  unread: { at: 2, failed: false },
};

let dir = "";
let server: MobileServer | null = null;
const phones: Phone[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-mobile-server-"));
});
afterEach(async () => {
  for (const phone of phones.splice(0)) phone.close();
  await server?.stop();
  server = null;
  await rm(dir, { recursive: true, force: true });
});

async function fixture(): Promise<{ port: number; store: MobileStore; submitted: string[]; aborted: string[]; cleared: string[] }> {
  const port = await freePort();
  const store = new MobileStore(dir);
  await store.setBind({ address: "127.0.0.1", port });
  await store.setEnabled(true);
  const submitted: string[] = [];
  const aborted: string[] = [];
  const cleared: string[] = [];
  const catalog = new MobileCatalog({
    listMetas: async () => [meta],
    listWorkspaces: async () => [{ id: "ws", name: "测试工作区" }],
    tailRecords: async () => [],
    tailStat: async () => null,
    phaseOf: () => undefined,
    now: () => Date.now(),
  });
  const tails = new MobileTails({
    tailWindow: async () => ({ records: [], start: 0, next: 0, end: 0 }),
    tailStat: async () => null,
  });
  let serverRef: MobileServer | null = null;
  const replies = new ReplyQueue(
    {
      readMeta: async () => meta,
      submitTurn: async (input) => {
        submitted.push(input.text);
      },
      isRunning: () => false,
    },
    {
      sent: (reply) => serverRef?.notifyReply("reply.sent", reply.source, { requestId: reply.requestId }),
      failed: (reply, _sessionId, error) => serverRef?.notifyReply("reply.failed", reply.source, { requestId: reply.requestId, error }),
    },
  );
  const hostCrypto: HostCrypto = { privateKey: HOST.privateKey, publicRaw: HOST.publicRaw };
  server = new MobileServer({
    store,
    catalog,
    tails,
    replies,
    isRunning: () => false,
    abort: async (id) => {
      aborted.push(id);
    },
    setUnread: async (id) => {
      cleared.push(id);
    },
    metaChanged: () => undefined,
    hostName: () => "集成测试电脑",
    now: Date.now,
    derivePinKey: lite,
  });
  serverRef = server;
  await server.start(hostCrypto);
  return { port, store, submitted, aborted, cleared };
}

describe("手机服务：真 WebSocket 走整条协议", () => {
  test("配对 → 双向确认 → hello → 四个口；重放与撤销都断开", async () => {
    const { port, store, submitted, aborted, cleared } = await fixture();
    const book = server?.pairingBook();
    assert.ok(book);
    const offer = await book.create();
    const phone = await Phone.open(port);
    phones.push(phone);
    const hostHello = await phone.next();
    assert.equal(hostHello["type"], "host.hello");
    const nonce = Buffer.from(hostHello["nonce"] as string, "base64");
    assert.equal(nonce.length, 32);

    phone.send({ v: 1, type: "pair.start", id: 1 });
    const startReply = await phone.next();
    assert.equal(startReply["ok"], true);
    const wire = startReply["result"] as PairStartResult;
    assert.equal(wire.offerId, offer.offerId);
    const seed = await openPairingBox(Buffer.from(wire.box, "base64"), Buffer.from(wire.salt, "base64"), Buffer.from(wire.iv, "base64"), offer.code, lite);
    assert.ok(seed);
    const device = generateBoxKeyPair();
    const message = pairMessage({
      offerId: wire.offerId,
      salt: Buffer.from(wire.salt, "base64"),
      iv: Buffer.from(wire.iv, "base64"),
      box: Buffer.from(wire.box, "base64"),
      hostBoxPublic: Buffer.from(wire.hostBoxPublic, "base64"),
      deviceBoxPublic: device.publicRaw,
      deviceName: "集成测试 Pixel",
    });
    phone.send({
      v: 1,
      type: "pair.prove",
      id: 2,
      params: { offerId: wire.offerId, deviceBoxPublic: device.publicRaw.toString("base64"), deviceName: "集成测试 Pixel", proof: pairProofOf(seed, message).toString("base64") },
    });
    const proveReply = await phone.next();
    assert.equal(proveReply["ok"], true);
    const paired = proveReply["result"] as PairProveResult;
    assert.equal((paired.host as HostInfo).name, "集成测试电脑");
    assert.equal(paired.hostProof, hostProofOf(seed, message, paired.deviceId).toString("base64"));

    const shared = sharedSecret(boxPrivateKeyFromRaw(device.privateRaw), HOST.publicRaw);
    const kh = helloKey(shared, nonce);
    const pn = Buffer.alloc(32, 7);
    phone.send({
      v: 1,
      type: "hello",
      id: 3,
      d: paired.deviceId,
      n: 1,
      ct: sealFrame(kh, "deviceToHost", 1, paired.deviceId, JSON.stringify({ pn: pn.toString("base64"), name: "集成测试 Pixel" })).ct,
    });
    const handshake = await phone.next();
    assert.equal(handshake["d"], paired.deviceId);
    const helloPlain = openFrame(kh, "hostToDevice", 1, paired.deviceId, Buffer.from(handshake["ct"] as string, "base64"));
    assert.ok(helloPlain);
    assert.equal((JSON.parse(helloPlain) as { ok: boolean }).ok, true);
    const key = channelKey(shared, nonce, pn, paired.deviceId);

    const request = (n: number, id: number, method: string, params?: object): void => {
      const body = JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) });
      phone.send({ v: 1, n, ct: sealFrame(key, "deviceToHost", n, paired.deviceId, body).ct });
    };
    const response = async (): Promise<{ frame: Record<string, unknown>; body: Record<string, unknown> }> => {
      const frame = await phone.next();
      const plaintext = openFrame(key, "hostToDevice", frame["n"] as number, paired.deviceId, Buffer.from(frame["ct"] as string, "base64"));
      assert.ok(plaintext);
      return { frame, body: JSON.parse(plaintext) as Record<string, unknown> };
    };

    request(1, 10, "ping");
    const pong = await response();
    assert.equal(pong.body["ok"], true);
    assert.equal(typeof (pong.body["result"] as { now: number }).now, "number");

    request(2, 11, "sessions.list");
    const list = await response();
    const listed = (list.body["result"] as { sessions: { id: string; title: string; workspaceName: string }[] }).sessions;
    assert.deepEqual(listed.map((session) => [session.id, session.title, session.workspaceName]), [[SESSION, "手机集成测试", "测试工作区"]]);

    request(3, 12, "reply", { sessionId: SESSION, text: "从手机回一句", requestId: "phone-r1" });
    const queued = await response();
    assert.deepEqual(queued.body["result"], { queued: false, position: 0 });
    const sent = await response();
    assert.equal(sent.body["event"], "reply.sent");
    assert.deepEqual(sent.body["params"], { requestId: "phone-r1" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(submitted, ["从手机回一句"]);

    // 断线重发同一个 requestId：回上次的排队结果，不重复开一轮
    request(4, 13, "reply", { sessionId: SESSION, text: "从手机回一句", requestId: "phone-r1" });
    const duplicate = await response();
    assert.deepEqual(duplicate.body["result"], { queued: false, position: 0 });
    assert.deepEqual(submitted, ["从手机回一句"]);

    request(5, 14, "stop", { sessionId: SESSION });
    const stopped = await response();
    assert.equal(stopped.body["ok"], true);
    assert.deepEqual(aborted, [SESSION]);

    request(6, 15, "unread.clear", { sessionId: SESSION });
    assert.equal((await response()).body["ok"], true);
    assert.deepEqual(cleared, [SESSION]);

    request(7, 16, "tail.load", { sessionId: SESSION });
    const tail = await response();
    assert.deepEqual(tail.body["result"], { entries: [], hasMore: false, rev: 0 });

    await server?.revokeDevice(paired.deviceId);
    await phone.closed;
    assert.equal(await store.device(paired.deviceId), null);
    assert.equal(server?.isConnected(paired.deviceId), false);

    // 撤销之后即使用新 nonce 重新算一个密码学上正确的 hello，设备表没记录也认不了
    const returning = await Phone.open(port);
    phones.push(returning);
    const secondHostHello = await returning.next();
    const secondNonce = Buffer.from(secondHostHello["nonce"] as string, "base64");
    const secondKh = helloKey(shared, secondNonce);
    returning.send({
      v: MOBILE_PROTOCOL_VERSION,
      type: "hello",
      id: 20,
      d: paired.deviceId,
      n: 1,
      ct: sealFrame(secondKh, "deviceToHost", 1, paired.deviceId, JSON.stringify({ pn: Buffer.alloc(32, 8).toString("base64") })).ct,
    });
    await returning.closed;
  });

  test("旧序号重放：直接断连，不再执行一次方法", async () => {
    const { port, store } = await fixture();
    // 完整配对再录一帧的成本上面已经付过；这里用一条真实设备记录，只走 hello 与数据段
    const device = generateBoxKeyPair();
    const deviceId = "0123456789abcdef0123456789abcdef";
    await store.addDevice({ id: deviceId, name: "已配对", boxPublic: device.publicRaw.toString("base64"), pairedAt: 1, lastSeenAt: null });
    const phone = await Phone.open(port);
    phones.push(phone);
    const hostHello = await phone.next();
    const nonce = Buffer.from(hostHello["nonce"] as string, "base64");
    const shared = sharedSecret(boxPrivateKeyFromRaw(device.privateRaw), HOST.publicRaw);
    const kh = helloKey(shared, nonce);
    const pn = Buffer.alloc(32, 3);
    phone.send({ v: 1, type: "hello", id: 1, d: deviceId, n: 1, ct: sealFrame(kh, "deviceToHost", 1, deviceId, JSON.stringify({ pn: pn.toString("base64") })).ct });
    await phone.next();
    const key = channelKey(shared, nonce, pn, deviceId);
    const ping = { v: 1, n: 1, ct: sealFrame(key, "deviceToHost", 1, deviceId, '{"id":1,"method":"ping"}').ct };
    phone.send(ping);
    await phone.next();
    phone.send(ping);
    await phone.closed;
  });

  test("绑定的地址已经不在本机：start 返回时 listening=false，原因立即可见", async () => {
    const { port, store } = await fixture();
    await store.setBind({ address: "192.0.2.1", port });
    await server?.start({ privateKey: HOST.privateKey, publicRaw: HOST.publicRaw });
    const settings = await server?.settings([]);
    assert.equal(settings?.listening, false);
    assert.equal(settings?.message, "这个地址现在不在本机上");
  });

  test("浏览器 Origin 的握手被拒； enabled=false 不起监听", async () => {
    const { port } = await fixture();
    await assert.rejects(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${MOBILE_PATH}`, { headers: { Origin: "https://evil.example" } });
        socket.once("open", resolve);
        socket.once("error", reject);
      }),
      /403/,
    );
    await server?.stop();
    const disabledStore = new MobileStore(dir);
    await disabledStore.setEnabled(false);
    await disabledStore.setBind({ address: "127.0.0.1", port });
    const disabled = new MobileServer({
      store: disabledStore,
      catalog: new MobileCatalog({ listMetas: async () => [], listWorkspaces: async () => [], tailRecords: async () => [], tailStat: async () => null, phaseOf: () => undefined, now: Date.now }),
      tails: new MobileTails({ tailWindow: async () => null, tailStat: async () => null }),
      replies: new ReplyQueue({ readMeta: async () => null, submitTurn: async () => undefined, isRunning: () => false }, { sent: () => undefined, failed: () => undefined }),
      isRunning: () => false,
      abort: async () => undefined,
      setUnread: async () => undefined,
      metaChanged: () => undefined,
      hostName: () => "x",
      now: Date.now,
    });
    server = disabled;
    await disabled.start({ privateKey: HOST.privateKey, publicRaw: HOST.publicRaw });
    assert.equal((await disabled.settings([])).listening, false);
    await assert.rejects(Phone.open(port));
  });
});
