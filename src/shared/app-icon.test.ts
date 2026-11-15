import { deepStrictEqual, ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { APP_ICONS, DEFAULT_APP_ICON, isAppIconId } from "./app-icon.ts";

describe("应用图标款式表", () => {
  it("共 32 款（基础 4 + 石纹 14 + 星云 14），id 不重复，且都是 <kind>-<key>", () => {
    deepStrictEqual(APP_ICONS.length, 32);
    deepStrictEqual(new Set(APP_ICONS.map((entry) => entry.id)).size, 32);
    for (const entry of APP_ICONS) deepStrictEqual(entry.id, `${entry.kind}-${entry.key}`);
    deepStrictEqual(APP_ICONS.filter((entry) => entry.kind === "basic").length, 4);
    deepStrictEqual(APP_ICONS.filter((entry) => entry.kind === "stone").length, 14);
    deepStrictEqual(APP_ICONS.filter((entry) => entry.kind === "nebula").length, 14);
  });

  it("默认款是基础款第一个（墨底白圈）；isAppIconId 只认表里的值", () => {
    deepStrictEqual(DEFAULT_APP_ICON, APP_ICONS[0]?.id);
    ok(isAppIconId("stone-feicui"));
    ok(!isAppIconId("stone-feicui "));
    ok(!isAppIconId("basic"));
    ok(!isAppIconId(undefined));
  });
});
