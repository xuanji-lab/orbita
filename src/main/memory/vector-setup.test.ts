import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MEMORY_VECTOR_MODELS } from "../../shared/memory.ts";
import {
  deviceStatusOf,
  effectiveVectorSettings,
  modelDownloadSources,
  modelFilePath,
  modelFileStateOf,
  parseVectorPatch,
  vectorServiceConfig,
} from "./vector-setup.ts";

const MODEL = MEMORY_VECTOR_MODELS[0]!;

test("effectiveVectorSettings：缺席全默认，patch 只覆盖动过的键", () => {
  assert.deepEqual(effectiveVectorSettings(undefined), {
    mode: "off",
    model: "embeddinggemma-2",
    idleUnloadMin: 5,
    deferOnBattery: true,
  });
  assert.deepEqual(effectiveVectorSettings({ mode: "local" }), {
    mode: "local",
    model: "embeddinggemma-2",
    idleUnloadMin: 5,
    deferOnBattery: true,
  });
});

test("deviceStatusOf：8GB 是本地推荐分档线，设备事实原样保留", () => {
  const base = { chip: "M3", onBattery: false, platform: "darwin", arch: "arm64" };
  assert.equal(deviceStatusOf({ ...base, memoryGb: 7 }).recommend, "cloud");
  assert.deepEqual(deviceStatusOf({ ...base, memoryGb: 8 }), {
    ...base,
    memoryGb: 8,
    recommend: "local",
  });
});

test("vectorServiceConfig：off / 缺模型 / 缺二进制都关闭；就绪时换算卸载毫秒", () => {
  const settings = effectiveVectorSettings({ mode: "local", idleUnloadMin: 2 });
  assert.equal(vectorServiceConfig({ settings, ggufPath: "/m", binaryPath: "/b" })?.idleUnloadMs, 120_000);
  assert.equal(vectorServiceConfig({ settings: { ...settings, mode: "off" }, ggufPath: "/m", binaryPath: "/b" }), null);
  assert.equal(vectorServiceConfig({ settings, ggufPath: null, binaryPath: "/b" }), null);
  assert.equal(vectorServiceConfig({ settings, ggufPath: "/m", binaryPath: null }), null);
});

test("模型路径与下载源：userData/vector 下落盘，HF 直连后接镜像", () => {
  assert.equal(modelFilePath(MODEL, "/tmp/user-data"), join("/tmp/user-data", "vector", MODEL.file));
  assert.deepEqual(modelDownloadSources(MODEL), [
    `https://huggingface.co/${MODEL.repo}/resolve/main/${MODEL.file}`,
    `https://hf-mirror.com/${MODEL.repo}/resolve/main/${MODEL.file}`,
  ]);
});

test("parseVectorPatch：合法 patch 原样解析，卸载分钟取整且至少 1", () => {
  assert.deepEqual(parseVectorPatch({ mode: "local", model: MODEL.id, idleUnloadMin: 2.6, deferOnBattery: false }), {
    mode: "local",
    model: MODEL.id,
    idleUnloadMin: 3,
    deferOnBattery: false,
  });
  assert.deepEqual(parseVectorPatch({ idleUnloadMin: -4, unknown: "ignored" }), { idleUnloadMin: 1 });
  assert.deepEqual(parseVectorPatch({}), {});
});

test("parseVectorPatch：坏入参抛错，不把 renderer 的任意值写进设置", () => {
  for (const raw of [null, undefined, "local", 1, []]) {
    assert.throws(() => parseVectorPatch(raw));
  }
  for (const raw of [
    { mode: "cloud" },
    { model: "not-a-model" },
    { idleUnloadMin: Number.NaN },
    { idleUnloadMin: Number.POSITIVE_INFINITY },
    { idleUnloadMin: "5" },
    { deferOnBattery: "yes" },
  ]) {
    assert.throws(() => parseVectorPatch(raw));
  }
});

test("modelFileStateOf：文件已就绪优先于旧失败；不在时如实回落下载状态", () => {
  const failed = { state: "failed", error: "network" } as const;
  assert.deepEqual(modelFileStateOf({ model: MODEL, fileExists: true, download: failed }), {
    state: "ready",
    sizeBytes: MODEL.sizeBytes,
  });
  assert.deepEqual(modelFileStateOf({ model: MODEL, fileExists: false, download: failed }), failed);
  assert.deepEqual(modelFileStateOf({ model: MODEL, fileExists: false, download: null }), { state: "none" });
});
