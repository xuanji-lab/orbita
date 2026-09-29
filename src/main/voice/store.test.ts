import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretsPort } from "../provider/store.ts";
import { DEFAULT_DOUBAO_RESOURCE_ID } from "../../shared/voice.ts";
import { parseDoubao, VoiceStore } from "./store.ts";

function memorySecrets(): SecretsPort & { all: Map<string, string> } {
  const all = new Map<string, string>();
  return {
    all,
    set: async (account, plaintext) => {
      all.set(account, plaintext);
    },
    get: async (account) => all.get(account) ?? null,
    delete: async (account) => {
      all.delete(account);
    },
  };
}

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-voice-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("parseDoubao：去首尾空白，Resource ID 空回默认，坏值当没配过", () => {
  assert.deepEqual(parseDoubao({ appId: " 123 ", resourceId: " " }), { appId: "123", resourceId: DEFAULT_DOUBAO_RESOURCE_ID });
  assert.deepEqual(parseDoubao(null), { appId: "", resourceId: DEFAULT_DOUBAO_RESOURCE_ID });
  assert.deepEqual(parseDoubao({ appId: 5 }), { appId: "", resourceId: DEFAULT_DOUBAO_RESOURCE_ID });
});

test("没配过：配置为空、Token 无掩码、听写凭证为 null", async (t) => {
  const store = new VoiceStore(await tempDir(t), memorySecrets());
  assert.deepEqual(await store.doubaoConfig(), { appId: "", resourceId: DEFAULT_DOUBAO_RESOURCE_ID, tokenMasked: null });
  assert.equal(await store.doubaoCredentials(), null);
});

test("存：Token 进钥匙串、文件里没有；读回来只给掩码；空 Token 保留已存的", async (t) => {
  const dir = await tempDir(t);
  const secrets = memorySecrets();
  const store = new VoiceStore(dir, secrets);
  const saved = await store.saveDoubao({ appId: "123", resourceId: "", accessToken: "abcdefghijkl" });
  assert.deepEqual(saved, { appId: "123", resourceId: DEFAULT_DOUBAO_RESOURCE_ID, tokenMasked: "abc…ijkl" });
  const onDisk = await readFile(join(dir, "voice.json"), "utf8");
  assert.doesNotMatch(onDisk, /abcdefghijkl/);

  await store.saveDoubao({ appId: "456", resourceId: "volc.bigasr.sauc.duration", accessToken: "" });
  assert.deepEqual(await store.doubaoCredentials(), {
    appId: "456",
    accessToken: "abcdefghijkl",
    resourceId: "volc.bigasr.sauc.duration",
  });
});

test("存豆包不冲掉 voice.json 里别的键（以后加的厂商）", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "voice.json"), JSON.stringify({ stepfun: { model: "x" } }));
  const store = new VoiceStore(dir, memorySecrets());
  await store.saveDoubao({ appId: "123", resourceId: "", accessToken: "tok" });
  const onDisk = JSON.parse(await readFile(join(dir, "voice.json"), "utf8"));
  assert.deepEqual(onDisk.stepfun, { model: "x" });
  assert.equal(onDisk.doubao.appId, "123");
});

test("测试连接的凭证：草稿优先，Token 没填用已存的；APP ID 或 Token 缺一样回 null", async (t) => {
  const store = new VoiceStore(await tempDir(t), memorySecrets());
  assert.equal(await store.doubaoCredentialsFor({ appId: "123", resourceId: "" }), null);
  await store.saveDoubao({ appId: "123", resourceId: "", accessToken: "stored" });
  assert.deepEqual(await store.doubaoCredentialsFor({ appId: "999", resourceId: "" }), {
    appId: "999",
    accessToken: "stored",
    resourceId: DEFAULT_DOUBAO_RESOURCE_ID,
  });
  assert.equal((await store.doubaoCredentialsFor({ appId: "999", resourceId: "", accessToken: "typed" }))?.accessToken, "typed");
  assert.equal(await store.doubaoCredentialsFor({ appId: " ", resourceId: "" }), null);
});
