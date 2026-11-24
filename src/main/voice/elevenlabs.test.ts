import { test } from "node:test";
import assert from "node:assert/strict";
import { speechUrl, synthesizeSpeech, type SpeechFetch, type SpeechResponse } from "./elevenlabs.ts";

const credentials = { apiKey: "sk_secret_value", voiceId: "voice/1", modelId: "eleven_flash_v2_5" };

function reply(status: number, body: string | Uint8Array): SpeechResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => (typeof body === "string" ? new TextEncoder().encode(body) : body).slice().buffer,
    text: async () => (typeof body === "string" ? body : ""),
  };
}

test("speechUrl：音色 id 编码进路径，要 mp3", () => {
  assert.equal(
    speechUrl("voice/1", "https://x"),
    "https://x/v1/text-to-speech/voice%2F1/stream?output_format=mp3_44100_128",
  );
});

test("成功：钥匙走请求头、正文带文字与模型，回整段音频", async () => {
  let seen: Parameters<SpeechFetch>[1] | null = null;
  const result = await synthesizeSpeech(credentials, "  你好。 ", {
    fetch: async (_url, init) => {
      seen = init;
      return reply(200, new Uint8Array([1, 2, 3]));
    },
  });
  assert.deepEqual(result, { ok: true, audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" });
  assert.ok(seen !== null);
  const init = seen as Parameters<SpeechFetch>[1];
  assert.equal(init.headers["xi-api-key"], "sk_secret_value");
  assert.deepEqual(JSON.parse(init.body), { text: "你好。", model_id: "eleven_flash_v2_5" });
});

test("失败分类：401 → unauthorized，422 → rejected 带原话，抛 → network，超时 → timeout", async () => {
  const unauthorized = await synthesizeSpeech(credentials, "a", { fetch: async () => reply(401, '{"detail":"invalid_api_key"}') });
  assert.equal(unauthorized.ok, false);
  assert.equal(!unauthorized.ok && unauthorized.reason, "unauthorized");
  assert.equal(!unauthorized.ok && unauthorized.detail, '401 {"detail":"invalid_api_key"}');

  const rejected = await synthesizeSpeech(credentials, "a", { fetch: async () => reply(422, "bad model") });
  assert.equal(!rejected.ok && rejected.reason, "rejected");

  const network = await synthesizeSpeech(credentials, "a", {
    fetch: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  assert.equal(!network.ok && network.reason, "network");

  const timeout = await synthesizeSpeech(credentials, "a", {
    timeoutMs: 10,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  assert.equal(!timeout.ok && timeout.reason, "timeout");
});

test("报错里不带钥匙；空文字不发请求", async () => {
  let called = false;
  const empty = await synthesizeSpeech(credentials, "   ", {
    fetch: async () => {
      called = true;
      return reply(200, new Uint8Array([1]));
    },
  });
  assert.equal(empty.ok, false);
  assert.equal(called, false);
  const failed = await synthesizeSpeech(credentials, "a", { fetch: async () => reply(500, "oops") });
  assert.doesNotMatch(JSON.stringify(failed), /sk_secret_value/);
});
