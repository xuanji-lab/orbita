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

test("首源 503：自动落到镜像源成功，中间不广播 failed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const target = join(dir, "model.gguf");
  const sha256 = createHash("sha256").update(PAYLOAD).digest("hex");
  const sources: string[] = [];
  const events: string[] = [];
  const outcome = await downloadWithFallback({
    sources: ["https://hf.example/m.gguf", "https://hf-mirror.example/m.gguf"],
    targetPath: target,
    sha256,
    sizeBytes: PAYLOAD.byteLength,
    fetchImpl: async (url) => {
      sources.push(url);
      return fakeFetch({ failSources: ["https://hf.example/m.gguf"] })(url);
    },
    onProgress: (event) => events.push(event.phase),
  });
  assert.equal(outcome.ok, true);
  assert.deepEqual(sources, ["https://hf.example/m.gguf", "https://hf-mirror.example/m.gguf"]);
  assert.deepEqual(events, ["downloading", "verifying", "done"]);
});

test("大小不符（实收少于声明）：按失败处理，只广播一次 failed，不留临时文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const events: string[] = [];
  const outcome = await downloadWithFallback({
    sources: ["https://s.example/m.gguf"],
    targetPath: join(dir, "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 999, // 声称的大小与实收不符
    fetchImpl: fakeFetch({}),
    onProgress: (event) => events.push(event.phase),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /大小不符/);
  assert.deepEqual(events, ["failed"]);
  assert.deepEqual(await readdir(dir), []);
});

test("实收超过声明大小：读到超限块立即中止，不继续消费响应流", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  let reads = 0;
  const outcome = await downloadWithFallback({
    sources: ["https://s.example/m.gguf"],
    targetPath: join(dir, "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 2,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            reads += 1;
            if (reads >= 3) return { done: true };
            return reads === 1
              ? { done: false, value: Uint8Array.from([1, 2, 3]) }
              : { done: false, value: Uint8Array.from([4]) };
          },
        }),
      },
    }),
    onProgress: () => undefined,
  });
  assert.equal(outcome.ok, false);
  assert.equal(reads, 1);
  assert.match(outcome.ok ? "" : outcome.error, /超过声明大小/);
});

test("取消：不再尝试后续源，也不把用户取消广播成下载失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const controller = new AbortController();
  controller.abort();
  const events: string[] = [];
  let fetches = 0;
  const outcome = await downloadWithFallback({
    sources: ["https://a.example/m.gguf", "https://b.example/m.gguf"],
    targetPath: join(dir, "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 2,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("aborted");
    },
    onProgress: (event) => events.push(event.phase),
    signal: controller.signal,
  });
  assert.equal(outcome.ok, false);
  assert.equal(fetches, 0);
  // 取消报一次 cancelled（界面据此收起进度），不报 failed
  assert.deepEqual(events, ["cancelled"]);
});

test("源卡住（不再来数据）：超过卡住时限判这个源失败、换下一个源下完", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const target = join(dir, "m.gguf");
  const good = fakeFetch({});
  const events: string[] = [];
  let hungAborted = false;
  const outcome = await downloadWithFallback({
    sources: ["https://hang.example/m.gguf", "https://ok.example/m.gguf"],
    targetPath: target,
    sha256: createHash("sha256").update(PAYLOAD).digest("hex"),
    sizeBytes: PAYLOAD.byteLength,
    stallMs: 40,
    fetchImpl: async (url, signal) => {
      if (url !== "https://hang.example/m.gguf") return good(url, signal);
      signal?.addEventListener("abort", () => (hungAborted = true), { once: true });
      // 先来一块数据，然后连接挂住（读永远不回）
      let first = true;
      return {
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () =>
              first
                ? ((first = false), Promise.resolve({ done: false, value: Uint8Array.from([1]) }))
                : new Promise<{ done: boolean; value?: Uint8Array }>(() => undefined),
          }),
        },
      };
    },
    onProgress: (event) => events.push(event.phase),
  });
  assert.equal(outcome.ok, true);
  assert.equal(hungAborted, true);
  assert.deepEqual(await readFile(target), PAYLOAD);
  assert.equal(events.includes("failed"), false);
  assert.equal(events.at(-1), "done");
});

test("所有源都卡住：报一次 failed，错误里写明多久没收到数据，不留临时文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  const events: { phase: string; error?: string }[] = [];
  const outcome = await downloadWithFallback({
    sources: ["https://hang.example/m.gguf"],
    targetPath: join(dir, "m.gguf"),
    sha256: "0".repeat(64),
    sizeBytes: 10,
    stallMs: 30,
    // 连响应头都不回
    fetchImpl: () => new Promise(() => undefined),
    onProgress: (event) => events.push({ phase: event.phase, error: event.error }),
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(
    events.map((event) => event.phase),
    ["failed"],
  );
  assert.match(events[0]?.error ?? "", /秒没有收到数据/);
  assert.deepEqual(await readdir(dir), []);
});
