import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { HostKeys, MOBILE_HOST_KEY_ACCOUNT, type HostKeySecrets } from "./host-keys.ts";
import type { SecretRead } from "../provider/store.ts";

/** Electron 解密失败时抛的那句原文 */
const DECRYPT_ERROR = "Error while decrypting the ciphertext provided to safeStorage.decryptString.";

/**
 * 内存版的密钥库：不加密，但把 `SafeStorageSecrets.readStrict` / `unlocksAny` 的三种处境摆得出来——
 * 整个密钥库锁着（谁也解不开）、某一条密文坏了（别的解得开、就它解不开）、一条密文偶发没读出来。
 */
class MemorySecrets implements HostKeySecrets {
  readonly map = new Map<string, string>();
  /** 主机私钥之外、同一个密钥库里的别的密文（API key 之类）；值用不上，只看有没有 */
  readonly others = new Map<string, string>();
  writes = 0;
  /** 严格读了几次（判据里「连读两次」要看它） */
  reads = 0;
  /** 探过几次「别的密文解不解得开」 */
  probes = 0;
  /** 钥匙串没解锁 / 访问被拒：这时谁也解不开 */
  locked = false;
  /** 换了机器 / 密钥库密码之后：别的密文好好的，就这几条解不开 */
  readonly broken = new Set<string>();
  /** 这几条密文头几次读会偶发失败（之后正常） */
  readonly flaky = new Map<string, number>();

  async set(account: string, plaintext: string): Promise<void> {
    this.writes += 1;
    this.map.set(account, plaintext);
  }

  async readStrict(account: string): Promise<SecretRead> {
    this.reads += 1;
    if (this.locked || this.broken.has(account) || (this.flaky.get(account) ?? 0) > 0) {
      if (!this.locked) this.flaky.set(account, Math.max(0, (this.flaky.get(account) ?? 0) - 1));
      return { status: "undecryptable", cause: DECRYPT_ERROR };
    }
    const value = this.map.get(account);
    return value === undefined ? { status: "missing" } : { status: "ok", plaintext: value };
  }

  async unlocksAny(exclude: string): Promise<boolean> {
    this.probes += 1;
    if (this.locked) return false;
    for (const account of this.others.keys()) {
      if (account !== exclude) return true;
    }
    return false;
  }
}

/** 造一组 HostKeys 与它的世界：设备表可变（被清空时归零）、日志收进数组、密钥库可在几个实例之间共用（模拟重启） */
function worldOf(secrets: MemorySecrets, options: { available?: boolean; backend?: string; devices?: number } = {}): {
  hostKeys: HostKeys;
  devices: string[];
  lost: string[];
  logs: string[];
} {
  const devices = Array.from({ length: options.devices ?? 0 }, (_, i) => `手机 ${i + 1}`);
  const lost: string[] = [];
  const logs: string[] = [];
  const hostKeys = new HostKeys({
    secrets,
    safeStorage: { available: () => options.available ?? true, backend: () => options.backend ?? "keychain" },
    deviceCount: async () => devices.length,
    onKeyLost: (notice) => {
      lost.push(notice);
      devices.length = 0;
      return Promise.resolve();
    },
    log: (line) => logs.push(line),
  });
  return { hostKeys, devices, lost, logs };
}

describe("主机私钥的生命周期", () => {
  test("第一次：生成并落库；第二次：读回同一把", async () => {
    const secrets = new MemorySecrets();
    const first = await worldOf(secrets).hostKeys.ensure();
    assert.ok(first.ok);
    assert.equal(first.crypto.publicRaw.length, 32);
    assert.ok(secrets.map.has(MOBILE_HOST_KEY_ACCOUNT));
    // 新实例（模拟重启）：从库里读回同一把
    const again = worldOf(secrets);
    const second = await again.hostKeys.ensure();
    assert.ok(second.ok);
    assert.equal(second.crypto.publicRaw.toString("hex"), first.crypto.publicRaw.toString("hex"));
    assert.equal(secrets.writes, 1, "读得回就不重写");
    assert.deepEqual(again.logs, [], "一切正常时不记日志");
  });

  test("并发 ensure 只生成 / 写入一把，所有调用方拿到同一个公钥", async () => {
    const secrets = new MemorySecrets();
    const { hostKeys } = worldOf(secrets);
    const results = await Promise.all([hostKeys.ensure(), hostKeys.ensure(), hostKeys.ensure()]);
    assert.ok(results.every((result) => result.ok));
    const publicKeys = results.map((result) => (result.ok ? result.crypto.publicRaw.toString("hex") : ""));
    assert.equal(new Set(publicKeys).size, 1);
    assert.equal(secrets.writes, 1);
  });

  test("密钥库不可用：拒绝，不生成，也不碰设备", async () => {
    const secrets = new MemorySecrets();
    const { hostKeys, lost, devices } = worldOf(secrets, { available: false, devices: 2 });
    const result = await hostKeys.ensure();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /密钥库不可用/);
    assert.equal(secrets.map.size, 0);
    assert.deepEqual(lost, []);
    assert.equal(devices.length, 2);
  });

  test("Linux 退化成 basic_text：等于明文，拒绝", async () => {
    const secrets = new MemorySecrets();
    const { hostKeys } = worldOf(secrets, { backend: "basic_text" });
    const result = await hostKeys.ensure();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /basic_text|明文/);
    assert.equal(secrets.map.size, 0);
  });

  test("密文不在了但设备还在：清空设备、留告示、重铸（安全审查第 8 条）", async () => {
    const secrets = new MemorySecrets();
    const { hostKeys, lost, devices, logs } = worldOf(secrets, { devices: 2 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 1);
    assert.match(lost[0] ?? "", /重新配对/);
    assert.deepEqual(devices, []);
    assert.equal(logs.length, 1, "清设备这件事要留一行日志");
    assert.match(logs[0] ?? "", /密文不在了/);
  });

  test("解得开、解出来的却不是合法私钥：不用探别的密文就能定罪，同样清设备", async () => {
    const secrets = new MemorySecrets();
    secrets.map.set(MOBILE_HOST_KEY_ACCOUNT, "这不是 base64 的私钥!!");
    const { hostKeys, lost, logs } = worldOf(secrets, { devices: 1 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 1);
    assert.equal(secrets.reads, 1, "密钥库已经给了密码，不用再探");
    assert.equal(secrets.probes, 0);
    assert.match(logs[0] ?? "", /不是一把合法的私钥/);
    // 重铸之后能读回
    const again = await worldOf(secrets).hostKeys.ensure();
    assert.ok(again.ok);
  });

  test("密钥丢了但一台设备都没有：不打扰（第一次启用就是这样）", async () => {
    const { hostKeys, lost, logs } = worldOf(new MemorySecrets(), { devices: 0 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 0);
    assert.deepEqual(logs, []);
  });

  test("一次没解出来（钥匙串没解锁 / 访问被拒）：不清设备、不重铸、记一行日志；解锁后读回原来那把", async () => {
    const secrets = new MemorySecrets();
    const first = await worldOf(secrets, { devices: 0 }).hostKeys.ensure();
    assert.ok(first.ok);
    secrets.others.set("provider:zai", "一把 API key");

    // 应用重启，这次系统密钥库不给解（secrets.json 里那条密文还在）
    secrets.locked = true;
    const afterRestart = worldOf(secrets, { devices: 2 });
    const result = await afterRestart.hostKeys.ensure();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /还没解锁/);
    assert.match(result.ok ? "" : result.reason, /设备都还在/);
    assert.deepEqual(afterRestart.lost, [], "没有清设备");
    assert.deepEqual(afterRestart.devices, ["手机 1", "手机 2"]);
    assert.equal(secrets.writes, 1, "没有重铸：密钥库一次都没写");
    assert.equal(afterRestart.logs.length, 1);
    assert.match(afterRestart.logs[0] ?? "", /这会儿读不出来/);
    assert.equal(secrets.reads, 2, "主机私钥读了一次，别的密文探了一次，就停手了");

    // 钥匙串解锁了，再开一次：读回的是原来那把，两台设备照旧认得电脑
    secrets.locked = false;
    const recovered = await afterRestart.hostKeys.ensure();
    assert.ok(recovered.ok);
    assert.equal(recovered.crypto.publicRaw.toString("hex"), first.crypto.publicRaw.toString("hex"));
    assert.deepEqual(afterRestart.lost, []);
    assert.equal(secrets.writes, 1);
  });

  test("换了电脑 / 重装系统：密钥库解得开别的密文，就这一条连读两次都解不开——确认坏了，才清设备重铸", async () => {
    const secrets = new MemorySecrets();
    const first = await worldOf(secrets, { devices: 0 }).hostKeys.ensure();
    assert.ok(first.ok);
    secrets.others.set("provider:zai", "新机器上存的 API key");
    secrets.broken.add(MOBILE_HOST_KEY_ACCOUNT);

    const moved = worldOf(secrets, { devices: 2 });
    const result = await moved.hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(moved.lost.length, 1, "确认坏了才清设备");
    assert.deepEqual(moved.devices, []);
    assert.notEqual(result.crypto.publicRaw.toString("hex"), first.crypto.publicRaw.toString("hex"), "重铸了一把新的");
    assert.equal(secrets.reads, 3, "第一次 + 密钥库可用之后回头再读一次");
    assert.equal(moved.logs.length, 1);
    assert.match(moved.logs[0] ?? "", /唯独这一条解不开/);
  });

  test("密钥库可用、这一条却偶发没读出来：回头再读读到了就用它，不清设备", async () => {
    const secrets = new MemorySecrets();
    const first = await worldOf(secrets, { devices: 0 }).hostKeys.ensure();
    assert.ok(first.ok);
    secrets.others.set("provider:zai", "一把 API key");
    secrets.flaky.set(MOBILE_HOST_KEY_ACCOUNT, 1);

    const glitch = worldOf(secrets, { devices: 2 });
    const result = await glitch.hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(result.crypto.publicRaw.toString("hex"), first.crypto.publicRaw.toString("hex"));
    assert.deepEqual(glitch.lost, []);
    assert.equal(secrets.writes, 1);
    assert.deepEqual(glitch.logs, []);
  });

  test("解不开、但一台设备都没有：没什么可丢，直接重铸，不去探别的密文", async () => {
    const secrets = new MemorySecrets();
    secrets.broken.add(MOBILE_HOST_KEY_ACCOUNT);
    secrets.others.set("provider:zai", "一把 API key");
    const { hostKeys, lost, logs } = worldOf(secrets, { devices: 0 });
    const result = await hostKeys.ensure();
    assert.ok(result.ok);
    assert.equal(lost.length, 0);
    assert.equal(secrets.probes, 0);
    assert.equal(secrets.writes, 1);
    assert.equal(logs.length, 1, "密文坏了重铸，哪怕没有设备要清也记一行");
    assert.match(logs[0] ?? "", /没有已配对设备要清/);
  });
});
