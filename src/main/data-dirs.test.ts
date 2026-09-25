import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { devDataDirs } from "./data-dirs.ts";

describe("devDataDirs", () => {
  test("正式版不改路径：返回 null，沿用 Electron 与 WorkspaceStore 的默认值", () => {
    assert.equal(devDataDirs({ packaged: true, appData: "/AS", home: "/Users/me" }), null);
  });

  test("开发版：userData 挪到 orbita-dev，工作区根挪到 ~/Orbita-dev", () => {
    assert.deepEqual(devDataDirs({ packaged: false, appData: "/AS", home: "/Users/me" }), {
      userData: "/AS/orbita-dev",
      orbitaRoot: "/Users/me/Orbita-dev",
    });
  });

  test("开发版的两个目录都不与正式版撞（大小写不敏感的 APFS 上也不撞）", () => {
    const dev = devDataDirs({ packaged: false, appData: "/AS", home: "/Users/me" });
    assert.notEqual(dev?.userData.toLowerCase(), "/as/orbita");
    assert.notEqual(dev?.orbitaRoot.toLowerCase(), "/users/me/orbita");
  });
});
