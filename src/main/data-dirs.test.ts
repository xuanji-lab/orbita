import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { devDataDirs } from "./data-dirs.ts";

// 期望值一律用 join 拼，与产品代码同一套规则：写死 "/AS/orbita-dev" 只在 POSIX 上成立，
// Windows 上产品代码产出的是 "\\AS\\orbita-dev"——那是分隔符差异，不是产品行为差异。
const APP_DATA = "/AS";
const HOME = "/Users/me";

/** 正式版的名字：userData 是 orbita，工作区根是 Orbita（Electron / WorkspaceStore 的默认值） */
const PACKAGED_USER_DATA = join(APP_DATA, "orbita");
const PACKAGED_ORBITA_ROOT = join(HOME, "Orbita");

describe("devDataDirs", () => {
  test("正式版不改路径：返回 null，沿用 Electron 与 WorkspaceStore 的默认值", () => {
    assert.equal(devDataDirs({ packaged: true, appData: APP_DATA, home: HOME }), null);
  });

  test("开发版：userData 挪到 orbita-dev，工作区根挪到 ~/Orbita-dev", () => {
    assert.deepEqual(devDataDirs({ packaged: false, appData: APP_DATA, home: HOME }), {
      userData: join(APP_DATA, "orbita-dev"),
      orbitaRoot: join(HOME, "Orbita-dev"),
    });
  });

  test("开发版的两个目录都不与正式版撞（大小写不敏感的 APFS 上也不撞）", () => {
    const dev = devDataDirs({ packaged: false, appData: APP_DATA, home: HOME });
    assert.notEqual(dev?.userData.toLowerCase(), PACKAGED_USER_DATA.toLowerCase());
    assert.notEqual(dev?.orbitaRoot.toLowerCase(), PACKAGED_ORBITA_ROOT.toLowerCase());
  });
});
