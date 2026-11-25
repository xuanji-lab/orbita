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
import { MOBILE_CRYPTO, MOBILE_PATH, MOBILE_PROTOCOL_VERSION } from "../../shared/mobile.ts";
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
import { MobileServer, admitsUnauthenticated } from "./server.ts";
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

  static async open(port: number, attempts = 30): Promise<Phone> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
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

  /** 给字符串就原样发（测「帧本身不是 JSON」用），给对象就 JSON 序列化 */
  send(frame: object | string): void {
    this.socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
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

  /** 等一帧，最多 `timeoutMs`；等不到回 null（不断言「不该有帧」，只把已经到的取走） */
  nextWithin(timeoutMs: number): Promise<Record<string, unknown> | null> {
    const queued = this.frames.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (frame: Record<string, unknown>): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiting.push(waiter);
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

interface Fixture {
  port: number;
  store: MobileStore;
  catalog: MobileCatalog;
  /** 手机的话真的交给了 agent 的那几条（文本） */
  submitted: string[];
  aborted: string[];
  cleared: string[];
}

async function fixture(options: { metas?: SessionMeta[] } = {}): Promise<Fixture> {
  const port = await freePort();
  const store = new MobileStore(dir);
  await store.setBind({ address: "127.0.0.1", port });
  await store.setEnabled(true);
  const submitted: string[] = [];
  const aborted: string[] = [];
  const cleared: string[] = [];
  const metas = options.metas ?? [meta];
  const catalog = new MobileCatalog({
    listMetas: async () => metas,
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
      readMeta: async (id) => metas.find((entry) => entry.id === id) ?? null,
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
  return { port, store, catalog, submitted, aborted, cleared };
}

/** 一个已经过了握手的手机会话：能发请求、按序号解开电脑的应答与通知 */
interface Authenticated {
  request(n: number, id: number, method: string, params?: object): void;
  /** 发一帧，密文里放调用方给的原文（测形状不对的请求用） */
  sendRaw(n: number, plaintext: string): void;
  /** 下一帧并解开；等不到回 null */
  next(timeoutMs?: number): Promise<{ frame: Record<string, unknown>; body: Record<string, unknown> } | null>;
}

/** 不走完整配对（上面那条用例付过成本了）：直接登记一台设备，然后 hello 进加密段 */
async function openAuthenticated(port: number, store: MobileStore, pnByte: number): Promise<Authenticated> {
  const phone = await Phone.open(port);
  phones.push(phone);
  return authenticate(phone, store, pnByte);
}

/** 给一条刚连上、还没发过东西的连接配上身份：登记一台设备，等 host.hello，发 hello，等握手应答 */
async function authenticate(phone: Phone, store: MobileStore, pnByte: number): Promise<Authenticated> {
  const device = generateBoxKeyPair();
  const deviceId = pnByte.toString(16).padStart(2, "0").repeat(16);
  await store.addDevice({ id: deviceId, name: "已配对", boxPublic: device.publicRaw.toString("base64"), pairedAt: 1, lastSeenAt: null });
  const hostHello = await phone.next();
  const nonce = Buffer.from(hostHello["nonce"] as string, "base64");
  const shared = sharedSecret(boxPrivateKeyFromRaw(device.privateRaw), HOST.publicRaw);
  const kh = helloKey(shared, nonce);
  const pn = Buffer.alloc(32, pnByte);
  phone.send({ v: 1, type: "hello", id: 1, d: deviceId, n: 1, ct: sealFrame(kh, "deviceToHost", 1, deviceId, JSON.stringify({ pn: pn.toString("base64") })).ct });
  // 契约：收到握手应答再发数据帧
  await phone.next();
  const key = channelKey(shared, nonce, pn, deviceId);
  const sendRaw = (n: number, plaintext: string): void => {
    phone.send({ v: 1, n, ct: sealFrame(key, "deviceToHost", n, deviceId, plaintext).ct });
  };
  return {
    sendRaw,
    request: (n, id, method, params) => {
      sendRaw(n, JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
    },
    next: async (timeoutMs = 2_000) => {
      const frame = await phone.nextWithin(timeoutMs);
      if (frame === null) return null;
      const plaintext = openFrame(key, "hostToDevice", frame["n"] as number, deviceId, Buffer.from(frame["ct"] as string, "base64"));
      assert.ok(plaintext);
      return { frame, body: JSON.parse(plaintext) as Record<string, unknown> };
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

describe("准入：四个口只认清单，增量刷新也只认根会话", () => {
  const CHILD = "0199a0aa-6bb0-7cc0-8000-0000000000a1";
  const AUTOMATION = "0199a0aa-6bb0-7cc0-8000-0000000000a2";

  test("子会话与自动化会话各出一个事件之后，tail.load / stop / unread.clear / reply 照样 not_found，观看者收不到它们", async () => {
    const child: SessionMeta = { ...meta, id: CHILD, title: "子会话", parentId: SESSION };
    const automation: SessionMeta = { ...meta, id: AUTOMATION, title: "自动化新开的", automationId: "auto-1" };
    const fx = await fixture({ metas: [meta, child, automation] });
    const session = await openAuthenticated(fx.port, fx.store, 3);

    session.request(1, 1, "sessions.list");
    const list = await session.next();
    assert.deepEqual((list?.body["result"] as { sessions: { id: string }[] }).sessions.map((entry) => entry.id), [SESSION]);
    assert.deepEqual([...fx.catalog.snapshotIds()], [SESSION]);
    session.request(2, 2, "sessions.watch");
    assert.equal((await session.next())?.body["ok"], true);

    // 两条不该点的会话各出一个带 sessionId 的事件：以前增量刷新只查「没归档 + 30 天内」，它们就进了准入集合
    fx.catalog.onAgentEvent({ type: "title", sessionId: CHILD, title: "子会话的新标题" });
    fx.catalog.onAgentEvent({ type: "title", sessionId: AUTOMATION, title: "自动化的新标题" });
    await sleep(600);
    assert.deepEqual([...fx.catalog.snapshotIds()], [SESSION], "增量刷新之后准入集合没有变");

    // 观看清单的手机只收到「第一次全量」（只有根会话），没有那两条
    for (let i = 0; i < 4; i += 1) {
      const pushed = await session.next(200);
      if (pushed === null) break;
      assert.equal(pushed.body["event"], "sessions.changed");
      const payload = pushed.body["params"] as { sessions: { id: string }[]; removed: string[] };
      assert.deepEqual(payload.sessions.map((entry) => entry.id), [SESSION]);
      assert.deepEqual(payload.removed, []);
    }
    assert.equal(await session.next(100), null, "之后没有别的推送");

    // 四个口逐个点它们
    let seq = 3;
    const expectNotFound = async (method: string, params: object): Promise<void> => {
      const id = seq;
      session.request(seq, seq, method, params);
      seq += 1;
      const reply = await session.next();
      assert.equal(reply?.body["id"], id, method);
      assert.equal(reply?.body["ok"], false, `${method} 不该放行`);
      assert.equal((reply?.body["error"] as { code: string }).code, "not_found", method);
    };
    for (const id of [CHILD, AUTOMATION]) {
      await expectNotFound("tail.load", { sessionId: id });
      await expectNotFound("stop", { sessionId: id });
      await expectNotFound("unread.clear", { sessionId: id });
      await expectNotFound("reply", { sessionId: id, text: "从手机塞进去的一句话", requestId: `sneak-${id}` });
    }
    await sleep(50);
    assert.deepEqual(fx.submitted, [], "一句话都没交给 agent");
    assert.deepEqual(fx.aborted, []);
    assert.deepEqual(fx.cleared, []);

    // 根会话出了事件：照常留在准入集合里，口还点得动（tail.load 每秒两次的额度上面用掉了，换一个不限速的口）
    fx.catalog.onAgentEvent({ type: "title", sessionId: SESSION, title: "手机集成测试" });
    await sleep(600);
    assert.deepEqual([...fx.catalog.snapshotIds()], [SESSION]);
    session.request(seq, seq, "unread.clear", { sessionId: SESSION });
    assert.equal((await session.next())?.body["ok"], true);
    assert.deepEqual(fx.cleared, [SESSION]);
  });
});

describe("未认证的连接：全局最多 8 条，同一个来源地址最多占 2 条", () => {
  test("同一地址的第三条空连接被 503 挡在 HTTP 握手；过了握手的、关掉了的不再占名额", async () => {
    const { port, store } = await fixture();
    const first = await Phone.open(port);
    phones.push(first);
    const second = await Phone.open(port);
    phones.push(second);
    await second.next(); // host.hello 到了，连接已经记进表
    // 第三、第四条：不重试（Phone.open 默认会重试，名额放出来它就连上了）
    await assert.rejects(Phone.open(port, 1), /503/);
    await assert.rejects(Phone.open(port, 1), /503/);

    // 第一条过了握手，成了已认证设备：不再占未认证名额，第三条空连接进得来
    await authenticate(first, store, 5);
    const third = await Phone.open(port);
    phones.push(third);
    await third.next();
    await assert.rejects(Phone.open(port, 1), /503/);

    // 关掉一条没认证的：名额放出来
    second.close();
    await second.closed;
    const fourth = await Phone.open(port);
    phones.push(fourth);
    await fourth.next();
  });

  test("判据本身：同一地址的第三条被拒时别的地址还有名额；全局 8 条满了谁都进不来", () => {
    const peers = ["10.0.0.1", "10.0.0.1", "10.0.0.2", "10.0.0.2", "10.0.0.3", "10.0.0.3", "10.0.0.4", "10.0.0.4"];
    assert.equal(MOBILE_CRYPTO.maxUnauthenticatedConnections, 8);
    assert.equal(admitsUnauthenticated([], "10.0.0.9"), true);
    assert.equal(admitsUnauthenticated(peers.slice(0, 6), "10.0.0.1"), false, "同一地址已经有两条");
    assert.equal(admitsUnauthenticated(peers.slice(0, 6), "10.0.0.9"), true, "别的地址还有名额");
    assert.equal(admitsUnauthenticated(peers, "10.0.0.9"), false, "全局 8 条满了");
  });
});


describe("契约备注：形状不对的请求带回自己的 id", () => {
  test("形状不对的请求，应答带请求自己的 id（空文本、多带字段、未知方法）；读不出 id 才是 0，连接不断", async () => {
    const { port, store } = await fixture();
    const session = await openAuthenticated(port, store, 6);
    const cases: [string, string, number][] = [
      ["空文本的 reply", JSON.stringify({ id: 41, method: "reply", params: { sessionId: SESSION, text: "   ", requestId: "r" } }), 41],
      ["多带字段", JSON.stringify({ id: 42, method: "ping", params: {}, extra: 1 }), 42],
      ["未知方法", JSON.stringify({ id: 43, method: "nope" }), 43],
      ["请求是个数组（读不出 id）", JSON.stringify([44]), 0],
      ["id 是数字串（读不出 id）", JSON.stringify({ id: "45", method: "ping" }), 0],
      ["id 超出范围（读不出 id）", JSON.stringify({ id: 0x80000000, method: "ping" }), 0],
      ["密文里不是 JSON（读不出 id）", "{not json", 0],
    ];
    let n = 1;
    for (const [label, plaintext, expected] of cases) {
      session.sendRaw(n, plaintext);
      n += 1;
      const reply = await session.next();
      assert.equal(reply?.body["id"], expected, label);
      assert.equal(reply?.body["ok"], false, label);
    }
    // 连接没断：之后一个正常请求照常应答
    session.request(n, 99, "ping");
    assert.equal((await session.next())?.body["id"], 99);

    // 明文段（还没认出设备）：形状不对的 pair.start 也是先回一句带 id 的错误再断
    const stranger = await Phone.open(port);
    phones.push(stranger);
    await stranger.next();
    stranger.send({ v: 1, type: "pair.start", id: 51, params: {}, surprise: true });
    const refused = await stranger.next();
    assert.equal(refused["id"], 51);
    assert.equal(refused["ok"], false);
    await stranger.closed;
    // 帧本身不是 JSON：只能回 0
    const another = await Phone.open(port);
    phones.push(another);
    await another.next();
    another.send("{not json");
    assert.equal((await another.next())["id"], 0);
  });


});
