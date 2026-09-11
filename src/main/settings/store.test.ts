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
    assert.deepEqual(await store.write({ theme: "dark" }), {
      theme: "dark",
      drawer: DEFAULT_SETTINGS.drawer,
    });
    assert.deepEqual(await new SettingsStore(dir).read(), {
      theme: "dark",
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
    await store.write({ theme: "dark" });
    assert.deepEqual(await readdir(dir), ["settings.json"]);
  });

  test("落盘的是格式化 JSON，用户手改得动", async () => {
    await store.write({ theme: "light" });
    const raw = await readFile(join(dir, "settings.json"), "utf8");
    // drawer 字段随 DEFAULT_SETTINGS 一起落盘——手改得到的形状要保持一眼可读
    assert.equal(
      raw,
      '{\n  "theme": "light",\n  "drawer": {\n    "open": false,\n    "width": 320,\n    "docked": []\n  }\n}\n',
    );
  });
});
