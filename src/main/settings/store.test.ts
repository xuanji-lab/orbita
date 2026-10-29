import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "./store.ts";
import { DEFAULT_SETTINGS } from "../../shared/settings.ts";

let dir = "";
let store: SettingsStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-settings-"));
  store = new SettingsStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SettingsStore", () => {
  test("没有文件时是默认设置", async () => {
    assert.deepEqual(await store.read(), DEFAULT_SETTINGS);
  });

  test("写完能读回来，并且换个实例也读得到", async () => {
    assert.deepEqual(await store.write({ theme: "graphite" }), {
      theme: "graphite",
      drawer: DEFAULT_SETTINGS.drawer,
    });
    assert.deepEqual(await new SettingsStore(dir).read(), {
      theme: "graphite",
      drawer: DEFAULT_SETTINGS.drawer,
    });
  });

  test("坏文件退回默认，不抛——设置随时能再选，不值得为此让应用起不来", async () => {
    await writeFile(join(dir, "settings.json"), "{ 这不是 JSON", "utf8");
    assert.deepEqual(await new SettingsStore(dir).read(), DEFAULT_SETTINGS);
  });

  test("坏值不落库：写进去的非法主题被 parseSettings 挡下", async () => {
    await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "midnight" }), "utf8");
    const fresh = new SettingsStore(dir);
    assert.deepEqual(await fresh.read(), DEFAULT_SETTINGS);
  });

  test("原子写：不留临时文件", async () => {
    await store.write({ theme: "light" });
    await store.write({ theme: "graphite" });
    assert.deepEqual(await readdir(dir), ["settings.json"]);
  });

  test("drawer 的部分更新按键合并，不整块覆盖", async () => {
    await store.write({ drawer: { width: 380, docked: ["a"] } });
    // 只发改一个键：其余两个保持——渲染层闭包里的旧值不许冲掉它（真机实测过的竞态）
    await store.write({ drawer: { docked: ["a", "b"] } });
    const read = await store.read();
    assert.deepEqual(read.drawer, { width: 380, docked: ["a", "b"] });
  });

  test("模型服务页的界面记忆按键合并：切卡片尺寸不抹掉「仅显示已添加」与图的分类", async () => {
    await store.write({ providersPage: { onlyAdded: true } });
    await store.write({ providersPage: { chartCategory: "webdev" } });
    await store.write({ providersPage: { cardSize: "small" } });
    assert.deepEqual((await store.read()).providersPage, { onlyAdded: true, chartCategory: "webdev", cardSize: "small" });
  });

  test("向量设置按键合并：只切模式不抹掉模型、卸载时间与电池偏好", async () => {
    await store.write({
      vector: { model: "qwen3-embedding-0.6b", idleUnloadMin: 9, deferOnBattery: false },
    });
    await store.write({ vector: { mode: "local" } });
    assert.deepEqual((await store.read()).vector, {
      mode: "local",
      model: "qwen3-embedding-0.6b",
      idleUnloadMin: 9,
      deferOnBattery: false,
    });
    assert.deepEqual((await new SettingsStore(dir).read()).vector, (await store.read()).vector);
  });

  test("落盘的是格式化 JSON，用户手改得动", async () => {
    await store.write({ theme: "light" });
    const raw = await readFile(join(dir, "settings.json"), "utf8");
    // drawer 字段随 DEFAULT_SETTINGS 一起落盘——手改得到的形状要保持一眼可读
    assert.equal(
      raw,
      '{\n  "theme": "light",\n  "drawer": {\n    "width": 320,\n    "docked": []\n  }\n}\n',
    );
  });

  test("choreModel 传 null = 清除，退回「Same as session」", async () => {
    await store.write({ choreModel: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" } });
    assert.deepEqual((await store.read()).choreModel, {
      providerId: "zhipu-coding",
      modelId: "glm-5.3-flash",
    });
    // undefined 在补丁语义里是「这个键没改」，所以清除必须是显式的 null
    await store.write({ choreModel: null });
    assert.deepEqual((await store.read()).choreModel, undefined);
    assert.deepEqual((await new SettingsStore(dir).read()).choreModel, undefined);
  });

  test("旧键 titleModel 平滑迁移：读得到，任何一次写入都把旧键从盘上带走", async () => {
    // 旧版本写的盘上只有 titleModel（只管起名的时代）
    await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "light", titleModel: { providerId: "kimi", modelId: "kimi-k3" } }));
    assert.deepEqual((await store.read()).choreModel, { providerId: "kimi", modelId: "kimi-k3" });
    // 与本次无关的一次写入（改主题）也顺手迁移：解析白名单重建对象，旧键自然消失
    await store.write({ sidebarWidth: 300 });
    const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal("titleModel" in raw, false);
    assert.deepEqual(raw["choreModel"], { providerId: "kimi", modelId: "kimi-k3" });
    assert.deepEqual((await new SettingsStore(dir).read()).choreModel, { providerId: "kimi", modelId: "kimi-k3" });
  });

  test("lastUsed 的部分更新按键合并——切档不抹已记的模型", async () => {
    await store.write({ lastUsed: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" } });
    await store.write({ lastUsed: { mode: "skip" } });
    const read = await store.read();
    assert.deepEqual(read.lastUsed, {
      providerId: "zhipu-coding",
      modelId: "glm-5.3-flash",
      mode: "skip",
    });
  });
});
