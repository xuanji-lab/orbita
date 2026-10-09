import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecretsPort } from "../provider/store.ts";
import { DEFAULT_DOUBAO_RESOURCE_ID } from "../../shared/voice.ts";
import { parseDictationProvider, parseDoubao, VoiceStore } from "./store.ts";

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

test("parseDictationProvider：只有 stepfun 是阶跃，其余（含没写）回豆包默认", () => {
  assert.equal(parseDictationProvider("stepfun"), "stepfun");
  assert.equal(parseDictationProvider("doubao"), "doubao");
  assert.equal(parseDictationProvider(undefined), "doubao");
  assert.equal(parseDictationProvider("StepFun"), "doubao");
  assert.equal(parseDictationProvider(5), "doubao");
});

test("听写选择：没配过是豆包未就绪；选阶跃落盘、不冲别的键；就绪跟着那家的凭证走", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "voice.json"), JSON.stringify({ doubao: { appId: "123" }, stepfun: { model: "x" } }));
  const store = new VoiceStore(dir, memorySecrets());
  assert.deepEqual(await store.dictationSelection(), { provider: "doubao", configured: false });

  await store.saveDoubao({ appId: "123", resourceId: "", accessToken: "tok" });
  assert.deepEqual(await store.dictationSelection(), { provider: "doubao", configured: true });

  assert.deepEqual(await store.setDictationProvider("stepfun"), { provider: "stepfun", configured: false });
  const onDisk = JSON.parse(await readFile(join(dir, "voice.json"), "utf8"));
  assert.equal(onDisk.dictationProvider, "stepfun");
  assert.equal(onDisk.doubao.appId, "123");
  assert.deepEqual(onDisk.stepfun, { model: "x" });

  await store.saveStepfun({ apiKey: "sk-live" });
  assert.deepEqual(await store.dictationSelection(), { provider: "stepfun", configured: true });
});

test("阶跃 key：存后只回掩码、voice.json 里没有；草稿优先；空 key 保留已存的", async (t) => {
  const dir = await tempDir(t);
  const secrets = memorySecrets();
  const store = new VoiceStore(dir, secrets);
  assert.deepEqual(await store.stepfunConfig(), { apiKeyMasked: null });
  assert.equal(await store.stepfunApiKey(), null);

  assert.deepEqual(await store.saveStepfun({ apiKey: "abcdefghijkl" }), { apiKeyMasked: "abc…ijkl" });
  const raw = await readFile(join(dir, "voice.json"), "utf8").catch(() => "");
  assert.doesNotMatch(raw, /abcdefghijkl/);
  assert.equal(await store.stepfunApiKey(), "abcdefghijkl");

  assert.equal(await store.stepfunCredentialsFor({}), "abcdefghijkl");
  assert.equal(await store.stepfunCredentialsFor({ apiKey: " typed " }), "typed");
  assert.equal(await store.stepfunCredentialsFor({ apiKey: " " }), "abcdefghijkl");

  // 空 key 保存 = 保留已存的（改别的格子时不必重粘）
  assert.deepEqual(await store.saveStepfun({ apiKey: "" }), { apiKeyMasked: "abc…ijkl" });
  assert.equal(await store.stepfunApiKey(), "abcdefghijkl");
});
