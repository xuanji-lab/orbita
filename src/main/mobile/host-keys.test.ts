import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HostKeys, MOBILE_HOST_KEY_ACCOUNT } from "./host-keys.ts";
import type { SecretsPort } from "../provider/store.ts";

/** 内存版 SecretsPort：测试不碰 safeStorage */
class MemorySecrets implements SecretsPort {
  readonly map = new Map<string, string>();
  writes = 0;
  async set(account: string, plaintext: string): Promise<void> {
    this.writes += 1;
    this.map.set(account, plaintext);
  }
  async get(account: string): Promise<string | null> {
    return this.map.get(account) ?? null;
  }
  async delete(account: string): Promise<void> {
    this.map.delete(account);
  }
}

function keysOf(opts: {
  secrets?: MemorySecrets;
  available?: boolean;
  backend?: string;
  devices?: number;
  lost?: string[];
}): { hostKeys: HostKeys; secrets: MemorySecrets; lost: string[] } {
  const secrets = opts.secrets ?? new MemorySecrets();
  const lost = opts.lost ?? [];
  const hostKeys = new HostKeys({
    secrets,
    safeStorage: { available: () => opts.available ?? true, backend: () => opts.backend ?? "keychain" },
    deviceCount: () => Promise.resolve(opts.devices ?? 0),
    onKeyLost: (notice) => {
      lost.push(notice);
      return Promise.resolve();
    },
  });
  return { hostKeys, secrets, lost };
}

describe("主机私钥的生命周期", () => {
  test("第一次：生成并落库；第二次：读回同一把", async () => {
    const { hostKeys, secrets } = keysOf({});
    const first = await hostKeys.ensure();
    assert.ok(first.ok);
    assert.equal(first.crypto.publicRaw.length, 32);
    assert.ok(secrets.map.has(MOBILE_HOST_KEY_ACCOUNT));
    // 新实例（模拟重启）：从库里读回同一把
    const again = keysOf({ secrets });
    const second = await again.hostKeys.ensure();
    assert.ok(second.ok);
    assert.equal(second.crypto.publicRaw.toString("hex"), first.crypto.publicRaw.toString("hex"));
  });

  test("并发 ensure 只生成 / 写入一把，所有调用方拿到同一个公钥", async () => {
    const { hostKeys, secrets } = keysOf({});
    const results = await Promise.all([hostKeys.ensure(), hostKeys.ensure(), hostKeys.ensure()]);
    assert.ok(results.every((result) => result.ok));
    const publicKeys = results.map((result) => (result.ok ? result.crypto.publicRaw.toString("hex") : ""));
    assert.equal(new Set(publicKeys).size, 1);
    assert.equal(secrets.writes, 1);
  });

  test("密钥库不可用：拒绝，不生成", async () => {
    const { hostKeys, secrets } = keysOf({ available: false });
    const result = await hostKeys.ensure();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /密钥库不可用/);
    assert.equal(secrets.map.size, 0);
  });

  test("Linux 退化成 basic_text：等于明文，拒绝", async () => {
    const { hostKeys, secrets } = keysOf({ backend: "basic_text" });
    const result = await hostKeys.ensure();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /basic_text|明文/);
    assert.equal(secrets.map.size, 0);
  });

  test("密钥丢了但设备还在：清空设备、留告示、重铸（安全审查第 8 条）", async () => {
    const { hostKeys, lost } = keysOf({ devices: 2 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 1);
    assert.match(lost[0] ?? "", /重新配对/);
  });

  test("密文损坏（读不回）同样清设备", async () => {
    const secrets = new MemorySecrets();
    secrets.map.set(MOBILE_HOST_KEY_ACCOUNT, "这不是 base64 的私钥!!");
    const { hostKeys, lost } = keysOf({ secrets, devices: 1 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 1);
    // 重铸之后能读回
    const again = await keysOf({ secrets }).hostKeys.ensure();
    assert.ok(again.ok);
  });

  test("密钥丢了但一台设备都没有：不打扰（第一次启用就是这样）", async () => {
    const { hostKeys, lost } = keysOf({ devices: 0 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 0);
  });
});
