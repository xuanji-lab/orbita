/**
 * 可续传下载器的测试（updater/resilient-download.ts）。
 *
 * 用替身传输层钉住四件事：多段拼接后字节完全一致、断流后从已写位置续传、取消不会被
 * 误报成网络失败、sha512 不符必须丢弃。真实网络行为另由 Electron 探针验证。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadFile,
  DownloadCancelledError,
  DownloadChecksumError,
  DownloadUnsupportedError,
  headerOf,
  planParts,
  totalFromContentRange,
  type RangeRequest,
  type RangeResponse,
  type RangeTransport,
} from "./resilient-download.ts";

function sha512(data: Buffer): string {
  return createHash("sha512").update(data).digest("base64");
}

/** 一段 Range 的替身响应；failAfter 有值时先吐一半再断流 */
function responseOf(
  data: Buffer,
  range: RangeRequest,
  options: { status?: number; failAfter?: number; headers?: Record<string, string> } = {},
): RangeResponse {
  const status = options.status ?? 206;
  const slice = data.subarray(range.start, range.end + 1);
  const failAfter = options.failAfter;
  const body = (async function* () {
    if (failAfter !== undefined) {
      yield slice.subarray(0, Math.min(failAfter, slice.length));
      throw new Error("socket hang up");
    }
    yield slice;
  })();
  return {
    status,
    headers:
      options.headers ??
      (status === 206
        ? { "content-range": `bytes ${range.start}-${range.end}/${data.length}` }
        : { "content-length": String(data.length) }),
    body,
    close: () => undefined,
  };
}

class FakeTransport implements RangeTransport {
  readonly calls: RangeRequest[] = [];
  private readonly data: Buffer;
  private readonly plan: { failCall?: number; failAfter?: number; ignoreRange?: boolean };

  constructor(
    data: Buffer,
    plan: { failCall?: number; failAfter?: number; ignoreRange?: boolean } = {},
  ) {
    this.data = data;
    this.plan = plan;
  }

  async open(_url: URL, _headers: Readonly<Record<string, string>>, range: RangeRequest): Promise<RangeResponse> {
    const call = this.calls.length;
    this.calls.push(range);
    if (this.plan.ignoreRange === true) {
      return responseOf(this.data, { start: 0, end: this.data.length - 1 }, { status: 200 });
    }
    const failAfter = call === this.plan.failCall ? this.plan.failAfter : undefined;
    return responseOf(this.data, range, failAfter === undefined ? {} : { failAfter });
  }
}

async function withTempFile(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-dl-"));
  try {
    await run(join(dir, "update.exe"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const URL_OK = new URL("https://example.invalid/file.exe");

describe("planParts / totalFromContentRange", () => {
  test("按 4MB 切段，末段不越界", () => {
    assert.deepEqual(planParts(10, 4), [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 9 },
    ]);
    assert.deepEqual(planParts(8, 4), [
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
    assert.deepEqual(planParts(0, 4), []);
  });

  test("Content-Range 取总长度；* 或畸形返回 null", () => {
    assert.equal(totalFromContentRange("bytes 0-0/177819819"), 177_819_819);
    assert.equal(totalFromContentRange("bytes 0-0/*"), null);
    assert.equal(totalFromContentRange("nonsense"), null);
    assert.equal(totalFromContentRange(null), null);
  });

  test("headerOf 大小写不敏感，数组取第一个", () => {
    assert.equal(headerOf({ "Content-Range": "bytes 0-0/10" }, "content-range"), "bytes 0-0/10");
    assert.equal(headerOf({ "content-range": ["a", "b"] }, "CONTENT-RANGE"), "a");
  });
});

describe("downloadFile", () => {
  test("多段并行：拼出来的字节与源一致，进度收尾到 100%", async () => {
    const data = Buffer.alloc(300_000);
    for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
    const transport = new FakeTransport(data);
    const progress: number[] = [];

    await withTempFile(async (path) => {
      await downloadFile(transport, {
        url: URL_OK,
        destination: path,
        headers: {},
        sha512: sha512(data),
        partSize: 64 * 1024,
        concurrency: 3,
        onProgress: (value) => progress.push(value.percent),
      });
      const written = await readFile(path);
      assert.equal(written.length, data.length);
      assert.equal(sha512(written), sha512(data));
    });

    assert.equal(progress.at(-1), 100);
    assert.ok(progress.every((value, index) => index === 0 || value >= (progress[index - 1] ?? 0)));
    // 1 次探针 + 5 段（300000 / 65536 向上取整）
    assert.equal(transport.calls.length, 6);
    assert.deepEqual(transport.calls[0], { start: 0, end: 0 });
  });

  test("中途断流：只重发这一段剩下的字节，最终文件完整", async () => {
    const data = Buffer.alloc(120_000);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 7) % 256;
    // 第一次分段请求吐 20000 字节后断流；后续请求正常
    const transport = new FakeTransport(data, { failCall: 1, failAfter: 20_000 });

    await withTempFile(async (path) => {
      await downloadFile(transport, {
        url: URL_OK,
        destination: path,
        headers: {},
        sha512: sha512(data),
        partSize: data.length,
        concurrency: 1,
        retryBaseDelayMs: 1,
      });
      const written = await readFile(path);
      assert.equal(written.length, data.length);
      assert.equal(sha512(written), sha512(data));
    });

    // 探针(0-0)、断流(0-119999)、续传(20000-119999)
    assert.deepEqual(
      transport.calls.slice(1),
      [
        { start: 0, end: 119_999 },
        { start: 20_000, end: 119_999 },
      ],
    );
  });

  test("sha512 不符 → 抛校验错误", async () => {
    const data = Buffer.from("not the installer");
    const transport = new FakeTransport(data);
    await withTempFile(async (path) => {
      await assert.rejects(
        downloadFile(transport, {
          url: URL_OK,
          destination: path,
          headers: {},
          sha512: sha512(Buffer.from("other")),
        }),
        (error: unknown) => error instanceof DownloadChecksumError,
      );
    });
  });

  test("用户取消 → CancellationError，不被当成网络失败重试", async () => {
    const data = Buffer.alloc(10_000);
    const cancellation = { cancelled: false };
    const transport: RangeTransport = {
      async open(_url, _headers, range) {
        // 第一次就取消：模拟用户刚点下载又点取消
        cancellation.cancelled = true;
        return responseOf(data, range);
      },
    };
    await withTempFile(async (path) => {
      await assert.rejects(downloadFile(transport, { url: URL_OK, destination: path, headers: {}, cancellation, sha512: sha512(data) }), (error: unknown) =>
        error instanceof DownloadCancelledError,
      );
    });
  });

  test("一段反复失败：其余段立刻收工，不再打网络也不再写已关闭的文件", async () => {
    const data = Buffer.alloc(120_000, 3);
    let calls = 0;
    /** 第 0 段永远连不上；其它段慢慢吐，保证第 0 段先耗尽重试 */
    const transport: RangeTransport = {
      async open(_url, _headers, range) {
        calls += 1;
        if (range.start === 0 && range.end > 0) throw new Error("socket hang up");
        return {
          status: 206,
          headers: { "content-range": `bytes ${range.start}-${range.end}/${data.length}` },
          body: (async function* () {
            const slice = data.subarray(range.start, range.end + 1);
            for (let offset = 0; offset < slice.length; offset += 4096) {
              await new Promise((resolve) => setTimeout(resolve, 5));
              yield slice.subarray(offset, offset + 4096);
            }
          })(),
          close: () => undefined,
        };
      },
    };

    await withTempFile(async (path) => {
      await assert.rejects(
        downloadFile(transport, {
          url: URL_OK,
          destination: path,
          headers: {},
          sha512: sha512(data),
          partSize: 40_000,
          concurrency: 3,
          maxStalledAttempts: 2,
          retryBaseDelayMs: 1,
        }),
        /下载反复中断/,
      );

      // 失败后 60ms 内不应再有任何新请求：兄弟段已收工（修之前它们会碰 EBADF 重试）
      const afterFailure = calls;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(calls, afterFailure);
    });
  });

  test("服务器不认 Range（200 + content-length）→ 单段下载仍然完整", async () => {
    const data = Buffer.alloc(70_000, 7);
    const transport = new FakeTransport(data, { ignoreRange: true });
    await withTempFile(async (path) => {
      await downloadFile(transport, {
        url: URL_OK,
        destination: path,
        headers: {},
        sha512: sha512(data),
      });
      const written = await readFile(path);
      assert.equal(written.length, data.length);
      assert.equal(sha512(written), sha512(data));
    });
  });

  test("200 但没给 Content-Length → 说「无法确定大小」，不误报「更新包是 0 字节」", async () => {
    const data = Buffer.alloc(1000, 1);
    // 曾经 Number(null) === 0 把「不知道大小」当成长度 0，报成了「更新包是 0 字节」
    const transport: RangeTransport = {
      async open(_url, _headers, range) {
        return responseOf(data, range, { status: 200, headers: {} });
      },
    };
    await withTempFile(async (path) => {
      await assert.rejects(
        downloadFile(transport, { url: URL_OK, destination: path, headers: {}, sha512: sha512(data) }),
        (error: unknown) => {
          assert.ok(error instanceof DownloadUnsupportedError);
          assert.match(error.message, /无法确定更新包大小/);
          assert.doesNotMatch(error.message, /0 字节/);
          return true;
        },
      );
    });
  });

  test("sha512 缺失 / 空串 → 拒绝下载（不再跳过校验）", async () => {
    const data = Buffer.alloc(1000, 9);
    const transport = new FakeTransport(data);
    await withTempFile(async (path) => {
      await assert.rejects(
        downloadFile(transport, { url: URL_OK, destination: path, headers: {} }),
        /缺少 sha512/,
      );
      await assert.rejects(
        downloadFile(transport, { url: URL_OK, destination: path, headers: {}, sha512: "" }),
        /缺少 sha512/,
      );
      // 拒绝发生在下载开始之前：一次网络请求都不发、文件不落盘
      assert.equal(transport.calls.length, 0);
      await assert.rejects(readFile(path), /ENOENT/);
    });
  });
});
