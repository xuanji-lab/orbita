import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MobileBindCandidate } from "../../shared/mobile.ts";
import { MOBILE_DEFAULT_PORT } from "../../shared/mobile.ts";
import { boxKeyPairFromRaw, generateBoxKeyPair } from "./crypto.ts";
import type { HostCrypto, HostKeyResult } from "./host-keys.ts";
import { createMobileIpcHandlers, type MobileIpcDeps } from "./ipc-handlers.ts";
import { PairingBook } from "./pairing.ts";
import { MobileStore, mobileSettingsOf } from "./store.ts";

const HOST = boxKeyPairFromRaw(Buffer.from("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a", "hex"));
const DEVICE_ID = "0123456789abcdef0123456789abcdef";
const CANDIDATE: MobileBindCandidate = { address: "100.100.101.102", kind: "tailscale", interfaceName: "utun6" };
const lite = (code: Buffer, salt: Buffer): Promise<Buffer> => Promise.resolve(createHash("sha256").update(code).update(salt).digest());

class FakeServer {
  listening = false;
  message: string | null = null;
  failListen = false;
  private book: PairingBook | null = null;
  private readonly store: MobileStore;

  constructor(store: MobileStore) {
    this.store = store;
  }

  async settings(candidates: MobileBindCandidate[]) {
    return mobileSettingsOf(await this.store.read(), candidates, this.listening, this.message);
  }

  async stop(): Promise<void> {
    this.book?.cancel();
    this.book = null;
    this.listening = false;
    this.message = null;
  }

  async start(_crypto: HostCrypto): Promise<void> {
    this.book = new PairingBook({ now: Date.now, hostBoxPublic: HOST.publicRaw, derivePinKey: lite });
    this.listening = !this.failListen;
    this.message = this.failListen ? "这个地址现在不在本机上" : null;
  }

  pairingBook(): PairingBook | null {
    return this.book;
  }

  isConnected(): boolean {
    return false;
  }

  reportError(message: string): void {
    this.message = message;
  }

  async revokeDevice(id: string): Promise<void> {
    await this.store.removeDevice(id);
  }
}

let dir = "";
let store: MobileStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-mobile-ipc-"));
  store = new MobileStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function fixture(options: { candidates?: MobileBindCandidate[]; keyResult?: HostKeyResult } = {}) {
  const server = new FakeServer(store);
  const hostCrypto: HostCrypto = { privateKey: HOST.privateKey, publicRaw: HOST.publicRaw };
  const deps: MobileIpcDeps = {
    store,
    server,
    hostKeys: { ensure: () => Promise.resolve(options.keyResult ?? { ok: true, crypto: hostCrypto }) },
    candidates: () => options.candidates ?? [CANDIDATE],
  };
  return { server, handlers: createMobileIpcHandlers(deps) };
}

describe("设置 IPC：每个 handler 的入参与回执", () => {
  test("get 回默认；setEnabled 只收布尔，坏输入不改状态", async () => {
    const { handlers } = fixture();
    const initial = await handlers.get();
    assert.equal(initial.enabled, false);
    assert.equal(initial.bind, null);
    assert.deepEqual(initial.candidates, [CANDIDATE]);
    assert.equal(initial.listening, false);
    for (const raw of ["true", 1, null, undefined, {}]) {
      await assert.rejects(handlers.setEnabled(raw), /布尔值/);
    }
    assert.equal((await store.read()).enabled, false);
  });

  test("setBind：公网 / 坏端口 / 缺字段 / 未知字段都拒；合法绑定落盘", async () => {
    const { handlers } = fixture();
    for (const raw of [
      { address: "203.0.113.5", port: 47620 },
      { address: "100.100.1.2", port: 0 },
      { address: "100.100.1.2" },
      { address: "100.100.1.2", port: 47620, extra: true },
      null,
    ]) {
      await assert.rejects(handlers.setBind(raw), /mobile:set-bind/);
    }
    assert.equal((await store.read()).bind, null);
    const result = await handlers.setBind({ address: "192.168.1.20", port: 47621 });
    assert.deepEqual(result.bind, { address: "192.168.1.20", port: 47621 });
    assert.equal(result.enabled, false);
    assert.equal(result.listening, false);
  });

  test("首次启用自动选 Tailscale 候选与默认端口；提议可生成 / 取消", async () => {
    const { handlers, server } = fixture();
    await assert.rejects(handlers.offerCreate(), /先开启手机服务/);
    const enabled = await handlers.setEnabled(true);
    assert.equal(enabled.enabled, true);
    assert.equal(enabled.listening, true);
    assert.deepEqual(enabled.bind, { address: CANDIDATE.address, port: MOBILE_DEFAULT_PORT });
    const offer = await handlers.offerCreate();
    assert.match(offer.code, /^[1-9]\d{5}$/);
    assert.equal(offer.address, CANDIDATE.address);
    assert.equal(offer.port, MOBILE_DEFAULT_PORT);
    assert.equal(server.pairingBook()?.current()?.code, offer.code);
    assert.equal(handlers.offerCancel(), undefined);
    assert.equal(server.pairingBook()?.current(), null);
    const disabled = await handlers.setEnabled(false);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.listening, false);
  });

  test("没有可绑地址 / 密钥库不可用：开关回关，原因给设置页", async () => {
    const noAddress = fixture({ candidates: [] }).handlers;
    const addressResult = await noAddress.setEnabled(true);
    assert.equal(addressResult.enabled, false);
    assert.match(addressResult.message ?? "", /没有可绑定/);
    const noKeys = fixture({ keyResult: { ok: false, reason: "系统密钥库不可用" } }).handlers;
    const keyResult = await noKeys.setEnabled(true);
    assert.equal(keyResult.enabled, false);
    assert.equal(keyResult.message, "系统密钥库不可用");
  });

  test("监听失败保留真实原因，不能生成配对码", async () => {
    const { handlers, server } = fixture();
    server.failListen = true;
    const result = await handlers.setEnabled(true);
    assert.equal(result.listening, false);
    assert.equal(result.message, "这个地址现在不在本机上");
    await assert.rejects(handlers.offerCreate(), /这个地址现在不在本机上/);
  });

  test("devices / revoke：坏设备 id 拒，合法撤销回剩余列表", async () => {
    const { handlers } = fixture();
    const device = generateBoxKeyPair();
    await store.addDevice({ id: DEVICE_ID, name: "Pixel", boxPublic: device.publicRaw.toString("base64"), pairedAt: 1, lastSeenAt: null });
    const listed = await handlers.devices();
    assert.deepEqual(listed.map((entry) => [entry.id, entry.connected]), [[DEVICE_ID, false]]);
    for (const raw of ["not-a-device", DEVICE_ID.toUpperCase(), 7, null]) {
      await assert.rejects(handlers.revoke(raw), /mobile:revoke/);
    }
    assert.equal((await store.device(DEVICE_ID))?.id, DEVICE_ID);
    assert.deepEqual(await handlers.revoke(DEVICE_ID), []);
    assert.equal(await store.device(DEVICE_ID), null);
    // 不存在的合法 id 幂等
    assert.deepEqual(await handlers.revoke(DEVICE_ID), []);
  });
});
