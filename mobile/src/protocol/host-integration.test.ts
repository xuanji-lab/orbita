/**
 * 手机协议客户端 ↔ **真的电脑侧服务**（`src/main/mobile/server.ts`，真 WebSocket、真 scrypt）。
 * 电脑侧照它自己的集成测试搭（假会话目录、假 agent），手机侧用这里写的 `pairWithHost` 与
 * `HostLink`，连接用 Node 自带的全局 WebSocket（它不带 Origin 头，和 app 里把 Origin 写空同一效果）。
 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionMeta } from "../../../src/shared/session.ts";
import type { MobileNotification } from "../../../src/shared/mobile.ts";
import { boxKeyPairFromRaw } from "../../../src/main/mobile/crypto.ts";
import { MobileCatalog } from "../../../src/main/mobile/summaries.ts";
import { MobileServer } from "../../../src/main/mobile/server.ts";
import { MobileStore } from "../../../src/main/mobile/store.ts";
import { MobileTails } from "../../../src/main/mobile/tails.ts";
import { ReplyQueue } from "../../../src/main/mobile/replies.ts";
import { HostLink, RequestError, type LinkStatus } from "./link.ts";
import { pairWithHost, type Credentials } from "./pair.ts";
import type { SocketFactory, SocketLike } from "./socket.ts";
import { resultOf } from "./wire.ts";

const SESSION = "0199a0aa-6bb0-7cc0-8000-123456789012";
const HOST = boxKeyPairFromRaw(Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex"));

const nodeSockets: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
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
const links: HostLink[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-mobile-phone-"));
});
afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  await server?.stop();
  server = null;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

interface Fixture {
  port: number;
  store: MobileStore;
  submitted: string[];
  aborted: string[];
  start(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const port = await freePort();
  const store = new MobileStore(dir);
  await store.setBind({ address: "127.0.0.1", port });
  await store.setEnabled(true);
  const submitted: string[] = [];
  const aborted: string[] = [];
  let serverRef: MobileServer | null = null;
  const build = () =>
    new MobileServer({
      store,
      catalog: new MobileCatalog({
        listMetas: async () => [meta],
        listWorkspaces: async () => [{ id: "ws", name: "测试工作区" }],
        tailRecords: async () => [],
        tailStat: async () => null,
        phaseOf: () => undefined,
        now: () => Date.now(),
      }),
      tails: new MobileTails({ tailWindow: async () => ({ records: [], start: 0, next: 0, end: 0 }), tailStat: async () => null }),
      replies: new ReplyQueue(
        {
          readMeta: async () => meta,
          submitTurn: async (input) => {
            submitted.push(input.text);
          },
          isRunning: () => false,
        },
        {
          sent: (reply) => serverRef?.notifyReply("reply.sent", reply.source, { requestId: reply.requestId }),
          failed: (reply, _id, error) => serverRef?.notifyReply("reply.failed", reply.source, { requestId: reply.requestId, error }),
        },
      ),
      isRunning: () => false,
      abort: async (id) => {
        aborted.push(id);
      },
      setUnread: async () => undefined,
      metaChanged: () => undefined,
      hostName: () => "集成测试电脑",
      now: Date.now,
    });
  return {
    port,
    store,
    submitted,
    aborted,
    async start() {
      await server?.stop();
      server = build();
      serverRef = server;
      await server.start({ privateKey: HOST.privateKey, publicRaw: HOST.publicRaw });
    },
  };
}

/** 盯着连接状态：等到某种状态出现 */
function watcher() {
  const seen: LinkStatus[] = [];
  const notes: MobileNotification[] = [];
  let opens = 0;
  const waiters: (() => void)[] = [];
  const poke = () => {
    for (const waiter of waiters.splice(0)) waiter();
  };
  return {
    seen,
    notes,
    get opens() {
      return opens;
    },
    onStatus(status: LinkStatus) {
      seen.push(status);
      poke();
    },
    onNotification(notification: MobileNotification) {
      notes.push(notification);
      poke();
    },
    onOpen() {
      opens += 1;
      poke();
    },
    async until(check: () => boolean, ms = 8_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(seen.at(-1))}`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
  };
}

async function pairOnce(fx: Fixture): Promise<Credentials> {
  const book = server?.pairingBook();
  assert.ok(book);
  const offer = await book.create();
  const progress: number[] = [];
  const outcome = await pairWithHost({
    address: "127.0.0.1",
    port: fx.port,
    code: offer.code,
    deviceName: "集成测试 Pixel",
    socketFactory: nodeSockets,
    now: Date.now,
    onProgress: (fraction) => progress.push(fraction),
  });
  assert.ok(outcome.ok, `配对失败：${outcome.ok ? "" : outcome.reason}`);
  assert.ok(progress.length > 0);
  return outcome.credentials;
}

function linkFor(fx: Fixture, credentials: Credentials, w: ReturnType<typeof watcher>, timing = {}): HostLink {
  const link = new HostLink({
    credentials,
    socketFactory: nodeSockets,
    deviceName: null,
    now: Date.now,
    onStatus: (status) => w.onStatus(status),
    onNotification: (note) => w.onNotification(note),
    onOpen: () => w.onOpen(),
    timing: { backoffMs: [50, 100, 200], shutdownRetryMs: 200, ...timing },
  });
  links.push(link);
  return link;
}

describe("手机客户端 ↔ 真电脑服务", () => {
  test("配对（两条连接、真 scrypt）→ 电脑登记设备 → 握手 → 列任务、读尾部、回一句、停止", async () => {
    const fx = await fixture();
    await fx.start();
    const credentials = await pairOnce(fx);
    assert.match(credentials.deviceId, /^[0-9a-f]{32}$/);
    assert.equal(credentials.hostName, "集成测试电脑");
    assert.equal(credentials.hostPublic, HOST.publicRaw.toString("base64"));
    const devices = await fx.store.read();
    assert.deepEqual(devices.devices.map((device) => device.name), ["集成测试 Pixel"]);

    const w = watcher();
    const link = linkFor(fx, credentials, w);
    link.start();
    await w.until(() => w.opens === 1);
    assert.equal(link.status.kind, "open");

    const list = resultOf["sessions.list"](await link.request("sessions.list", {}));
    assert.deepEqual(list?.sessions.map((session) => [session.id, session.state, session.workspaceName]), [[SESSION, "done", "测试工作区"]]);
    assert.deepEqual(resultOf["tail.load"](await link.request("tail.load", { sessionId: SESSION })), { entries: [], hasMore: false, rev: 0 });
    assert.deepEqual(resultOf.reply(await link.request("reply", { sessionId: SESSION, text: "从手机回一句", requestId: "r1" })), {
      queued: false,
      position: 0,
    });
    await w.until(() => w.notes.some((note) => note.event === "reply.sent"));
    assert.deepEqual(fx.submitted, ["从手机回一句"]);
    assert.equal(await link.request("stop", { sessionId: SESSION }), null);
    // 不在清单里的会话：电脑拒，手机拿到带错误码的 RequestError
    await assert.rejects(link.request("stop", { sessionId: "0199a0aa-6bb0-7cc0-8000-000000000000" }), (error: unknown) => {
      return error instanceof RequestError && error.error.code === "not_found";
    });
    // 连发几个请求：手机的 seq 连续，电脑都收（不会因为乱序断线）
    const pings = await Promise.all([1, 2, 3, 4].map(() => link.request("ping", {})));
    assert.equal(pings.length, 4);
    assert.equal(link.status.kind, "open");
  });

  test("配对码不对：不发证明，报 wrongCode；没有有效提议：报 expired；地址没人听：报 offline", async () => {
    const fx = await fixture();
    await fx.start();
    const book = server?.pairingBook();
    assert.ok(book);
    const base = { address: "127.0.0.1", port: fx.port, deviceName: "x", socketFactory: nodeSockets, now: Date.now };
    assert.deepEqual(await pairWithHost({ ...base, code: "123456" }), { ok: false, reason: "expired" });
    const offer = await book.create();
    const wrong = offer.code === "999999" ? "999998" : "999999";
    assert.deepEqual(await pairWithHost({ ...base, code: wrong }), { ok: false, reason: "wrongCode" });
    assert.deepEqual((await fx.store.read()).devices, []);
    // 码不对没有烧掉提议：正确的码还能配
    const right = await pairWithHost({ ...base, code: offer.code });
    assert.equal(right.ok, true);
    // 用掉了：再配一次报过期
    assert.deepEqual(await pairWithHost({ ...base, code: offer.code }), { ok: false, reason: "expired" });
    const closed = await freePort();
    assert.deepEqual(await pairWithHost({ ...base, port: closed, code: offer.code }), { ok: false, reason: "offline" });
  });

  test("电脑重启：手机自己重连上，再握一次手（onOpen 第二次）", async () => {
    const fx = await fixture();
    await fx.start();
    const credentials = await pairOnce(fx);
    const w = watcher();
    linkFor(fx, credentials, w).start();
    await w.until(() => w.opens === 1);
    await server?.stop();
    await w.until(() => w.seen.some((status) => status.kind === "waiting"));
    await fx.start();
    await w.until(() => w.opens === 2, 10_000);
  });

  test("设备被电脑忘掉：连着几次 hello 被一声不吭地断开，判成 rejected、不再重连", async () => {
    const fx = await fixture();
    await fx.start();
    const credentials = await pairOnce(fx);
    const w = watcher();
    const link = linkFor(fx, credentials, w);
    link.start();
    await w.until(() => w.opens === 1);
    await server?.revokeDevice(credentials.deviceId);
    await w.until(() => link.status.kind === "rejected", 10_000);
  });
});
