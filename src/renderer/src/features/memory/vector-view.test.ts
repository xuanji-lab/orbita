import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryDownloadProgress } from "../../../../shared/memory.ts";
import { vectorFileView } from "./vector-view.ts";

const progress = (patch: Partial<MemoryDownloadProgress>): MemoryDownloadProgress => ({
  requestId: "r",
  phase: "downloading",
  source: "https://hf-mirror.com/x/resolve/main/m.gguf",
  received: 0,
  total: 100,
  ...patch,
});

describe("vectorFileView：模型文件一格", () => {
  test("下载中以事件为准：百分比取整、来源只留域名", () => {
    assert.deepEqual(vectorFileView({ state: "none" }, progress({ received: 42.9 })), {
      kind: "downloading",
      percent: 42,
      host: "hf-mirror.com",
    });
  });

  test("快照已就绪时，旧的失败事件不遮住它", () => {
    assert.deepEqual(vectorFileView({ state: "ready", sizeBytes: 1 }, progress({ phase: "failed", error: "x" })), {
      kind: "ready",
    });
  });

  test("事件说失败、快照还是 none：显示失败原因", () => {
    assert.deepEqual(vectorFileView({ state: "none" }, progress({ phase: "failed", error: "HTTP 503" })), {
      kind: "failed",
      error: "HTTP 503",
    });
  });

  test("没事件：照快照；total 为 0 不除零", () => {
    assert.deepEqual(vectorFileView({ state: "downloading", received: 5, total: 0, source: "bad url" }, null), {
      kind: "downloading",
      percent: 0,
      host: null,
    });
    assert.deepEqual(vectorFileView({ state: "none" }, null), { kind: "none" });
  });
});
