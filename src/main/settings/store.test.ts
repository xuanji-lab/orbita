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

  test("sidebarAgeDays：选了落盘、换实例读得到，补丁发 null 清除回「不限」，别的键不受影响", async () => {
    await store.write({ theme: "graphite", sidebarAgeDays: 3 });
    assert.equal((await new SettingsStore(dir).read()).sidebarAgeDays, 3);
    const cleared = await store.write({ sidebarAgeDays: null });
    assert.equal("sidebarAgeDays" in cleared, false);
    assert.equal(cleared.theme, "graphite");
    const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal("sidebarAgeDays" in onDisk, false);
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

  test("插件页的界面记忆按键合并：切卡片尺寸不抹掉「仅显示已启用」，重开 store 还在", async () => {
    await store.write({ pluginsPage: { onlyEnabled: true } });
    await store.write({ pluginsPage: { cardSize: "small" } });
    assert.deepEqual((await store.read()).pluginsPage, { onlyEnabled: true, cardSize: "small" });
    assert.deepEqual((await new SettingsStore(dir).read()).pluginsPage, { onlyEnabled: true, cardSize: "small" });
    // 模型服务页的记忆互不相干
    assert.equal((await store.read()).providersPage, undefined);
  });

  test("常驻对话指针与入口选择按工作区合并：记第二个不抹第一个，重开 store 还在，改别的设置不抹它们", async () => {
    await store.write({ orchestraMain: { ws1: "s1" }, orchestraEntry: { ws1: "main" } });
    await store.write({ orchestraMain: { ws2: "s2" }, orchestraEntry: { ws2: "new" } });
    await store.write({ orchestraMain: { ws1: "s3" } });
    await store.write({ theme: "light" });
    const reopened = await new SettingsStore(dir).read();
    assert.deepEqual(reopened.orchestraMain, { ws1: "s3", ws2: "s2" });
    assert.deepEqual(reopened.orchestraEntry, { ws1: "main", ws2: "new" });
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

  test("avatarModel：挑定的型号 / 「子会话模型」写进去重开还在；补丁发 null 选回默认（跟会话栏）；坏值不落盘", async () => {
    await store.write({ theme: "graphite", avatarModel: { providerId: "kimi-coding", modelId: "k3.1-pro" } });
    assert.deepEqual((await new SettingsStore(dir).read()).avatarModel, { providerId: "kimi-coding", modelId: "k3.1-pro" });
    await store.write({ sidebarWidth: 300 });
    assert.deepEqual((await new SettingsStore(dir).read()).avatarModel, { providerId: "kimi-coding", modelId: "k3.1-pro" }, "改别的设置不抹它");
    await store.write({ avatarModel: "sub_session" });
    assert.equal((await new SettingsStore(dir).read()).avatarModel, "sub_session");
    // undefined 在补丁语义里是「这个键没改」，所以选回默认必须是显式的 null
    const cleared = await store.write({ avatarModel: null });
    assert.equal("avatarModel" in cleared, false);
    assert.equal(cleared.theme, "graphite");
    const onDisk = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal("avatarModel" in onDisk, false);
    // 盘上的坏值（别的取法名、半截的一对）当作没选过：回到默认，不拦应用启动
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({ theme: "light", avatarModel: { providerId: "kimi-coding" } }),
      "utf8",
    );
    assert.equal((await new SettingsStore(dir).read()).avatarModel, undefined);
    await writeFile(join(dir, "settings.json"), JSON.stringify({ theme: "light", avatarModel: "follow" }), "utf8");
    assert.equal((await new SettingsStore(dir).read()).avatarModel, undefined);
    // 选回默认之后再写具体型号：仍是完整的成对
    await store.write({ avatarModel: { providerId: "zhipu-coding", modelId: "glm-5.4" } });
    assert.deepEqual((await new SettingsStore(dir).read()).avatarModel, { providerId: "zhipu-coding", modelId: "glm-5.4" });
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

  test("星系倾角：写进去重开还在；改别的设置不抹它；坏值不落盘", async () => {
    await store.write({ galaxyTilt: 25 });
    assert.equal((await new SettingsStore(dir).read()).galaxyTilt, 25);
    await store.write({ sidebarWidth: 300 });
    assert.equal((await new SettingsStore(dir).read()).galaxyTilt, 25);
    await store.write({ galaxyTilt: 37, galaxyAzimuth: 123, galaxyTurntable: false });
    assert.equal((await new SettingsStore(dir).read()).galaxyTilt, 37, "1° 精度");
    assert.equal((await new SettingsStore(dir).read()).galaxyAzimuth, 123);
    assert.equal((await new SettingsStore(dir).read()).galaxyTurntable, false);
    await store.write({ galaxyZoom: 1.4 });
    assert.equal((await new SettingsStore(dir).read()).galaxyZoom, 1.4, "缩放与倾角、方位一起存");
    await store.write({ galaxyDustDensity: "tenth" });
    assert.equal((await new SettingsStore(dir).read()).galaxyDustDensity, "tenth", "碎石密度写进去重开还在");
    assert.equal((await new SettingsStore(dir).read()).galaxyAzimuth, 123);
    await store.write({ galaxyTilt: 37.5, galaxyAzimuth: 400 });
    const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.equal("galaxyTilt" in raw, false, "不是整数度的值丢掉，回到默认");
    assert.equal("galaxyAzimuth" in raw, false, "越界的方位角丢掉");
  });

  test("lastUsed 的部分更新按键合并——只改模型 id 不抹已记的服务商", async () => {
    await store.write({ lastUsed: { providerId: "zhipu-coding", modelId: "glm-5.3-flash" } });
    await store.write({ lastUsed: { modelId: "glm-5.3" } });
    const read = await store.read();
    assert.deepEqual(read.lastUsed, {
      providerId: "zhipu-coding",
      modelId: "glm-5.3",
    });
  });

  /**
   * computerUse 目前只有 allowNetwork 一项，补丁是**整对象回写**（AppSettings 的注释里写明：
   * 加第二项时必须像 drawer / lastUsed 那样按键合并）。这条测试锁的是「今天这条路径真的能
   * 往返」——写 false 落盘、读出 false、新实例仍 false、与主题互不干扰、改回 true 落盘 true。
   * 将来加第二项时如果忘了按键合并，这里会先红。
   */
  test("computerUse 往返：写 false → 落盘 → 重建实例仍 false → 改主题不冲掉它 → 改回 true", async () => {
    assert.deepEqual(await store.write({ computerUse: { allowNetwork: false } }), {
      theme: DEFAULT_SETTINGS.theme,
      drawer: DEFAULT_SETTINGS.drawer,
      computerUse: { allowNetwork: false },
    });
    assert.deepEqual((await store.read()).computerUse, { allowNetwork: false });

    // 落盘的是可移植 JSON，用户手改得动（"false" 字符串会被解析层当缺席，不是这里的事）
    const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw["computerUse"], { allowNetwork: false });

    // 另一边换个实例从盘上读：缓存不是唯一真相
    assert.deepEqual((await new SettingsStore(dir).read()).computerUse, { allowNetwork: false });

    // 与其它键互不干扰：改主题不该把 computerUse 冲掉（整对象 patch 的边界就在这里）
    await store.write({ theme: "graphite" });
    const afterTheme = await store.read();
    assert.equal(afterTheme.theme, "graphite");
    assert.deepEqual(afterTheme.computerUse, { allowNetwork: false });
    assert.deepEqual((await new SettingsStore(dir).read()).computerUse, { allowNetwork: false });

    // 改回开：落盘也是 true
    await store.write({ computerUse: { allowNetwork: true } });
    assert.deepEqual((await store.read()).computerUse, { allowNetwork: true });
    const rawAfter = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(rawAfter["computerUse"], { allowNetwork: true });
  });

  /**
   * 第二项（准入白名单）落地后的按键合并：设置页的开关只发 {allowNetwork}，
   * 手改 / 将来别的入口写的 allowedApps 不能被它抹掉——这与 drawer / lastUsed 的竞态同一个错。
   */
  test("computerUse 按键合并：写白名单不冲掉出网开关，改开关也不冲掉白名单", async () => {
    await store.write({ computerUse: { allowedApps: ["notepad.exe"] } });
    assert.deepEqual((await store.read()).computerUse, { allowedApps: ["notepad.exe"] });

    // 设置页的开关补丁（只有 allowNetwork）→ 白名单还在
    await store.write({ computerUse: { allowNetwork: false } });
    assert.deepEqual((await store.read()).computerUse, {
      allowedApps: ["notepad.exe"],
      allowNetwork: false,
    });

    // 反过来：只写白名单不会把 allowNetwork 抹回缺席
    await store.write({ computerUse: { allowedApps: ["calc.exe"] } });
    assert.deepEqual((await store.read()).computerUse, {
      allowedApps: ["calc.exe"],
      allowNetwork: false,
    });
    const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw["computerUse"], { allowedApps: ["calc.exe"], allowNetwork: false });
  });

  /**
   * 第三项（沙箱浏览器）的按键合并：设置页的下拉只发 {browser}，手写的 allowedApps /
   * allowNetwork 不能被它冲掉；反过来改开关也不能把用户选的 Chrome 抹回缺省。
   */
  test("computerUse 按键合并：选浏览器不冲掉另两个键，改开关也不冲掉浏览器", async () => {
    await store.write({ computerUse: { browser: "chrome" } });
    assert.deepEqual((await store.read()).computerUse, { browser: "chrome" });

    await store.write({ computerUse: { allowNetwork: false } });
    assert.deepEqual((await store.read()).computerUse, { browser: "chrome", allowNetwork: false });

    await store.write({ computerUse: { allowedApps: ["notepad.exe"] } });
    assert.deepEqual((await store.read()).computerUse, {
      browser: "chrome",
      allowNetwork: false,
      allowedApps: ["notepad.exe"],
    });

    // 换个选项只改自己那个键
    await store.write({ computerUse: { browser: "brave" } });
    assert.deepEqual((await store.read()).computerUse, {
      browser: "brave",
      allowNetwork: false,
      allowedApps: ["notepad.exe"],
    });
    // 落盘也是可移植 JSON（用户在设置页选一下就会写进这个键）
    const raw = JSON.parse(await readFile(join(dir, "settings.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(raw["computerUse"], {
      browser: "brave",
      allowNetwork: false,
      allowedApps: ["notepad.exe"],
    });
  });
});
