/**
 * 模型下载器（downloader.ts）——流式进度、sha256 校验、多源兜底、失败清临时文件。
 * 纯模块直测（node --test）：fetch 注入桩。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadWithFallback, type DownloadFetch } from "./downloader.ts";

const PAYLOAD = Buffer.from("模型文件内容（假）");

function fakeFetch(input: { failSources?: string[]; chunks?: number[][] }): DownloadFetch {
  return async (url) => {
    if (input.failSources?.includes(url)) {
      return { ok: false, status: 503, body: null };
    }
    let at = 0;
    const chunks = input.chunks ?? [Array.from(PAYLOAD)];
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (at >= chunks.length) return { done: true };
            const value = Uint8Array.from(chunks[at]!);
            at += 1;
            return { done: false, value };
          },
        }),
      },
    };
  };
}

test("下载 + 边下边校验 sha256：成功落目标文件、进度序列对", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const target = join(dir, "model.gguf");
  const sha256 = createHash("sha256").update(PAYLOAD).digest("hex");
  const events: string[] = [];
  const outcome = await downloadWithFallback({
    sources: ["https://hf.example/model.gguf"],
    targetPath: target,
    sha256,
    sizeBytes: PAYLOAD.byteLength,
    fetchImpl: fakeFetch({ chunks: [Array.from(PAYLOAD.slice(0, 5)), Array.from(PAYLOAD.slice(5))] }),
    onProgress: (event) => events.push(event.phase),
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(await readFile(target), PAYLOAD);
  assert.deepEqual(events, ["downloading", "verifying", "done"]);
});

test("sha256 不符：换下一个源；全挂返回失败并清临时文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const target = join(dir, "model.gguf");
  const outcome = await downloadWithFallback({
    sources: ["https://bad.example/m.gguf", "https://mirror.example/m.gguf"],
    targetPath: target,
    sha256: "deadbeef",
    sizeBytes: PAYLOAD.byteLength,
    fetchImpl: fakeFetch({}),
    onProgress: () => undefined,
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(await readdir(dir), []); // 临时文件清掉了
});

test("首源 503：自动落到镜像源成功", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const target = join(dir, "model.gguf");
  const sha256 = createHash("sha256").update(PAYLOAD).digest("hex");
  const sources: string[] = [];
  const outcome = await downloadWithFallback({
    sources: ["https://hf.example/m.gguf", "https://hf-mirror.example/m.gguf"],
    targetPath: target,
    sha256,
    sizeBytes: PAYLOAD.byteLength,
    fetchImpl: async (url) => {
      sources.push(url);
      return fakeFetch({ failSources: ["https://hf.example/m.gguf"] })(url);
    },
    onProgress: () => undefined,
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(sources, ["https://hf.example/m.gguf", "https://hf-mirror.example/m.gguf"]);
});

test("大小不符：按失败处理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const outcome = await downloadWithFallback({
    sources: ["https://s.example/m.gguf"],
    targetPath: join(dir, "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 999, // 声称的大小与实收不符
    fetchImpl: fakeFetch({}),
    onProgress: () => undefined,
  });
  assert.equal(outcome.ok, false);
});
