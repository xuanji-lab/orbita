import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SecretsPort } from "../provider/store.ts";
import { McpOauthCredentialStore, type McpOauthCredential } from "./credential-store.ts";

class SlowSecrets implements SecretsPort {
  readonly data = new Map<string, string>();
  /** 模拟 SafeStorageSecrets 的「读全量 → 改一项 → 整体写回」：并发时后写的会盖掉先写的 */
  private async rewrite(change: (all: Record<string, string>) => void): Promise<void> {
    const snapshot = Object.fromEntries(this.data);
    await new Promise((resolve) => setTimeout(resolve, 5));
    change(snapshot);
    this.data.clear();
    for (const [k, v] of Object.entries(snapshot)) this.data.set(k, v);
  }
  set(account: string, plaintext: string): Promise<void> {
    return this.rewrite((all) => {
      all[account] = plaintext;
    });
  }
  async get(account: string): Promise<string | null> {
    return this.data.get(account) ?? null;
  }
  delete(account: string): Promise<void> {
    return this.rewrite((all) => {
      delete all[account];
    });
  }
}

const credential = (name: string): McpOauthCredential => ({
  serverUrl: `https://${name}.example.com/mcp`,
  clientInformation: { client_id: `client-${name}` },
  tokens: { access_token: `at-${name}`, token_type: "Bearer", refresh_token: `rt-${name}` },
  expiresAt: 123,
  revocationEndpoint: null,
  savedAt: 1,
});

describe("McpOauthCredentialStore", () => {
  test("按 server 名存取；整条 JSON 只落在 mcp-oauth: 前缀的账号下", async () => {
    const secrets = new SlowSecrets();
    const store = new McpOauthCredentialStore(secrets);
    await store.set("notion", credential("notion"));
    assert.deepEqual(await store.get("notion"), credential("notion"));
    assert.equal(await store.get("supabase"), null);
    assert.deepEqual([...secrets.data.keys()], ["mcp-oauth:notion"]);
    await store.delete("notion");
    assert.equal(await store.get("notion"), null);
  });

  test("并发写不同的 server：串行化，一项都不丢（登录和续期可能同时落盘）", async () => {
    const store = new McpOauthCredentialStore(new SlowSecrets());
    await Promise.all(["a", "b", "c", "d"].map((name) => store.set(name, credential(name))));
    for (const name of ["a", "b", "c", "d"]) assert.deepEqual(await store.get(name), credential(name), name);
  });

  test("一次写失败不卡住后面的写", async () => {
    const secrets = new SlowSecrets();
    let fail = true;
    const original = secrets.set.bind(secrets);
    secrets.set = (account, plaintext) => (fail ? Promise.reject(new Error("钥匙串不可用")) : original(account, plaintext));
    const store = new McpOauthCredentialStore(secrets);
    await assert.rejects(store.set("a", credential("a")), /钥匙串不可用/);
    fail = false;
    await store.set("b", credential("b"));
    assert.deepEqual(await store.get("b"), credential("b"));
  });

  test("读到坏 JSON、缺字段、类型不对的密文：当作没有，不抛", async () => {
    const secrets = new SlowSecrets();
    const store = new McpOauthCredentialStore(secrets);
    for (const bad of ["{", "null", "[]", JSON.stringify({ serverUrl: "x" }), JSON.stringify({ ...credential("a"), expiresAt: "soon" }), JSON.stringify({ ...credential("a"), tokens: {} })]) {
      secrets.data.set("mcp-oauth:a", bad);
      assert.equal(await store.get("a"), null, bad);
    }
  });
});
