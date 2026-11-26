import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobileStore } from "./store.ts";

const DEVICE_A = "a".repeat(32);
const DEVICE_B = "b".repeat(32);

async function withStore(fn: (store: MobileStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mobile-store-"));
  try {
    await fn(new MobileStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("mobile.json：手机服务的持久化", () => {
  test("默认是关的、没绑定、没设备；写完能读回来", async () => {
    await withStore(async (store, dir) => {
      const initial = await store.read();
      assert.deepEqual(initial, { enabled: false, bind: null, devices: [], hostKeyNotice: null });
      await store.setBind({ address: "100.64.1.2", port: 47620 });
      await store.setEnabled(true);
      await store.addDevice({ id: DEVICE_A, name: "wafo 的 Pixel", boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: 1, lastSeenAt: null });
      // 换一个实例读同一文件：落盘的东西对得上
      const fresh = await new MobileStore(dir).read();
      assert.equal(fresh.enabled, true);
      assert.deepEqual(fresh.bind, { address: "100.64.1.2", port: 47620 });
      assert.equal(fresh.devices.length, 1);
      assert.equal(fresh.devices[0]?.name, "wafo 的 Pixel");
    });
  });

  test("坏文件当空文件，不抛", async () => {
    await withStore(async (store, dir) => {
      await writeFile(join(dir, "mobile.json"), "{ 这不是 JSON", "utf8");
      const state = await store.read();
      assert.deepEqual(state, { enabled: false, bind: null, devices: [], hostKeyNotice: null });
    });
  });

  test("设备登记：撤销、lastSeenAt、改名；撤销后读不回", async () => {
    await withStore(async (store) => {
      await store.addDevice({ id: DEVICE_A, name: "旧名字", boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: 1, lastSeenAt: null });
      await store.addDevice({ id: DEVICE_B, name: "另一台", boxPublic: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", pairedAt: 2, lastSeenAt: null });
      await store.renameDevice(DEVICE_A, "wafo 的 Pixel");
      await store.touchDevice(DEVICE_A, 1234);
      const devices = await store.devices();
      assert.equal(devices.length, 2);
      assert.equal(devices.find((d) => d.id === DEVICE_A)?.name, "wafo 的 Pixel");
      assert.equal(devices.find((d) => d.id === DEVICE_A)?.lastSeenAt, 1234);
      await store.removeDevice(DEVICE_A);
      assert.equal((await store.devices()).length, 1);
      assert.equal(await store.device(DEVICE_A), null);
    });
  });

  test("密钥丢了：清空设备 + 留告示；配上新设备告示才清", async () => {
    await withStore(async (store) => {
      await store.addDevice({ id: DEVICE_A, name: "旧机", boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: 1, lastSeenAt: null });
      await store.clearDevicesForLostKey("主机私钥读不回来了，请重新配对");
      const state = await store.read();
      assert.equal(state.devices.length, 0);
      assert.equal(state.hostKeyNotice, "主机私钥读不回来了，请重新配对");
      await store.addDevice({ id: DEVICE_B, name: "新机", boxPublic: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=", pairedAt: 2, lastSeenAt: null });
      assert.equal((await store.read()).hostKeyNotice, null);
    });
  });

  test("并发读改写不互相踩：20 个并发 addDevice 一个不少", async () => {
    await withStore(async (store) => {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          store.addDevice({ id: i.toString(16).padStart(32, "0"), name: `设备 ${i}`, boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: i, lastSeenAt: null }),
        ),
      );
      assert.equal((await store.devices()).length, 20);
    });
  });

  test("id 形状不对的设备在读取时被丢掉（坏行不拖垮整份）", async () => {
    await withStore(async (store, dir) => {
      await writeFile(
        join(dir, "mobile.json"),
        JSON.stringify({
          enabled: true,
          bind: { address: "127.0.0.1", port: 47620 },
          devices: [
            { id: DEVICE_A, name: "好", boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: 1, lastSeenAt: null },
            { id: "不是 id", name: "坏", boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: 1 },
            { id: DEVICE_B, name: "好二", boxPublic: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", pairedAt: "昨天" },
          ],
        }),
        "utf8",
      );
      const state = await store.read();
      assert.equal(state.devices.length, 1);
      assert.equal(state.devices[0]?.id, DEVICE_A);
      // 文件里的字原样还在（读取时过滤，不改写文件）
      const raw = JSON.parse(await readFile(join(dir, "mobile.json"), "utf8")) as { devices: unknown[] };
      assert.equal(raw.devices.length, 3);
    });
  });
});
