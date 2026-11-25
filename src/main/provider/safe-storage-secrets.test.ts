import { afterEach, beforeEach, describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `SafeStorageSecrets` 的严格读：`readStrict` 把「没有这条密文」与「有、解不开」分开报，
 * `unlocksAny` 只读不写。electron 在 node --test 里是空壳，换成替身——只替 `safeStorage` 一个，
 * 别的都是真的（真的 secrets.json、真的写链）。
 *
 * 替身的加密是「密钥库密码 + 异或」：同一个密码解得开，换了密码（换机器 / 重装系统 / 重置了钥匙串）
 * 解出来的开头对不上校验串就抛，和真 safeStorage 一样是抛、不是回空串。`locked` 模拟钥匙串没解锁。
 */
const vault = {
  password: "old-machine-key",
  locked: false,
  encryptCalls: 0,
  decryptCalls: 0,
};
const CHECK = "orbita:";

function xor(text: string, password: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) out += String.fromCharCode(text.charCodeAt(i) ^ password.charCodeAt(i % password.length));
  return out;
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => !vault.locked,
  encryptString(plaintext: string): Buffer {
    vault.encryptCalls += 1;
    if (vault.locked) throw new Error("OS secret storage is unavailable");
    return Buffer.from(xor(`${CHECK}${plaintext}`, vault.password), "utf8");
  },
  decryptString(encrypted: Buffer): string {
    vault.decryptCalls += 1;
    if (vault.locked) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    const text = xor(encrypted.toString("utf8"), vault.password);
    if (!text.startsWith(CHECK)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    return text.slice(CHECK.length);
  },
};

mock.module("electron", {
  namedExports: {
    safeStorage: fakeSafeStorage,
    // 这份实现的依赖链里用不到别的名字；留一个空壳免得别的模块加载时找不到
    app: {},
  },
});
const { SafeStorageSecrets } = await import("./safe-storage-secrets.ts");

let dir = "";
let secrets: InstanceType<typeof SafeStorageSecrets>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-secrets-"));
  secrets = new SafeStorageSecrets(dir);
  vault.password = "old-machine-key";
  vault.locked = false;
  vault.encryptCalls = 0;
  vault.decryptCalls = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SafeStorageSecrets 的严格读", () => {
  test("readStrict 把三种处境分开；get 把「解不开」也说成「没有」", async () => {
    assert.deepEqual(await secrets.readStrict("mobile-host-box"), { status: "missing" });
    await secrets.set("mobile-host-box", "一把主机私钥");
    assert.deepEqual(await secrets.readStrict("mobile-host-box"), { status: "ok", plaintext: "一把主机私钥" });

    // 换了密钥库密码（换机器 / 重装系统 / 重置钥匙串）：密文还在，解不开
    vault.password = "new-machine-key";
    const unreadable = await secrets.readStrict("mobile-host-box");
    assert.equal(unreadable.status, "undecryptable");
    if (unreadable.status === "undecryptable") assert.match(unreadable.cause, /decrypting/);
    assert.equal(await secrets.get("mobile-host-box"), null, "get 看不出「没有」和「解不开」的区别");
  });

  test("unlocksAny：锁着时谁也解不开；解锁后别的密文有一条能解就算密钥库可用；没有别的密文不算", async () => {
    await secrets.set("mobile-host-box", "一把主机私钥");
    assert.equal(await secrets.unlocksAny("mobile-host-box"), false, "密钥库里只有它自己，没有旁证");
    await secrets.set("provider:zai", "一把 API key");

    vault.locked = true;
    const reads = vault.decryptCalls;
    assert.equal(await secrets.unlocksAny("mobile-host-box"), false, "钥匙串没解锁：别的密文也解不开");
    assert.equal(vault.decryptCalls - reads, 1, "只试一条就停手——锁着时每试一次都可能弹一次框");

    vault.locked = false;
    assert.equal(await secrets.unlocksAny("mobile-host-box"), true, "API key 解得开：密码拿得到");
    // 主机私钥那条坏了、别的密文好好的（换机器之后重新填了 API key）：密钥库照样算可用
    vault.password = "new-machine-key";
    await secrets.set("provider:zai", "新机器上重新填的 API key");
    const hostKey = await secrets.readStrict("mobile-host-box");
    assert.equal(hostKey.status, "undecryptable");
    assert.equal(await secrets.unlocksAny("mobile-host-box"), true);
  });

  test("unlocksAny 只读：不加密、不往密钥库写", async () => {
    await secrets.set("provider:zai", "一把 API key");
    const before = vault.encryptCalls;
    vault.locked = true;
    assert.equal(await secrets.unlocksAny("mobile-host-box"), false);
    vault.locked = false;
    assert.equal(await secrets.unlocksAny("mobile-host-box"), true);
    assert.equal(vault.encryptCalls, before, "一次 encryptString 都没调");
  });
});
