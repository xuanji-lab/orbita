import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { APP_ICONS } from "../../../../shared/app-icon.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

const DIR = new URL("../../../../../design-system/assets/app-icons/", import.meta.url);

describe("应用图标素材", () => {
  test("32 款都有同名 SVG，目录里没有多余文件", () => {
    for (const entry of APP_ICONS) {
      assert.ok(existsSync(new URL(`${entry.id}.svg`, DIR)), `缺 ${entry.id}.svg`);
    }
    const files = readdirSync(DIR).filter((name) => name.endsWith(".svg")).sort();
    assert.deepEqual(files, APP_ICONS.map((entry) => `${entry.id}.svg`).sort());
  });

  test("每个 SVG 都是 0 0 100 100 的满铺方形，且不自带圆角裁切（圆角由栅格化按平台网格画）", () => {
    for (const entry of APP_ICONS) {
      const svg = readFileSync(new URL(`${entry.id}.svg`, DIR), "utf8");
      assert.ok(svg.includes('viewBox="0 0 100 100"'), `${entry.id} viewBox`);
      assert.ok(!svg.includes("clip-path="), `${entry.id} 不该自带裁切`);
    }
  });

  test("石头之间的内部 id 带款式前缀，不会在同一页里互相冲突", () => {
    const seen = new Map<string, string>();
    for (const entry of APP_ICONS.filter((e) => e.kind !== "basic")) {
      const svg = readFileSync(new URL(`${entry.id}.svg`, DIR), "utf8");
      for (const match of svg.matchAll(/\sid="([^"]+)"/g)) {
        const id = match[1] ?? "";
        const owner = seen.get(id);
        assert.ok(owner === undefined || owner === entry.id, `id ${id} 同时出现在 ${owner} 与 ${entry.id}`);
        seen.set(id, entry.id);
      }
    }
  });

  test("每一款中英都有名字，三个分组标题只有一个词（旁边没有解释）", () => {
    for (const entry of APP_ICONS) {
      assert.ok(zh.settings.appIconNames[entry.key] !== "", `zh ${entry.key}`);
      assert.ok(en.settings.appIconNames[entry.key] !== "", `en ${entry.key}`);
    }
    assert.deepEqual(zh.settings.appIconKinds, { basic: "基础", stone: "石纹", nebula: "星云" });
    assert.deepEqual(en.settings.appIconKinds, { basic: "Basic", stone: "Stone", nebula: "Nebula" });
  });
});
