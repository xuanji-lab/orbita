import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { allShownTicked, importedFirst, setShown } from "./login-sites.ts";

describe("登录状态导入 · 全选", () => {
  test("全选只勾显示中的网站：搜索过滤掉的不被悄悄勾上", () => {
    const next = setShown(new Set(), ["nus.edu.sg", "libproxy1.nus.edu.sg"], true);
    assert.deepEqual([...next].sort(), ["libproxy1.nus.edu.sg", "nus.edu.sg"]);
  });

  test("全不选只取消显示中的网站：之前勾好、现在被过滤掉的保留", () => {
    const ticked = new Set(["github.com", "nus.edu.sg"]);
    const next = setShown(ticked, ["nus.edu.sg"], false);
    assert.deepEqual([...next], ["github.com"]);
  });

  test("不改动传入的集合", () => {
    const ticked = new Set(["a.com"]);
    setShown(ticked, ["b.com"], true);
    assert.deepEqual([...ticked], ["a.com"]);
  });

  test("allShownTicked：显示中的全勾了才算；什么都没显示时为 false", () => {
    assert.equal(allShownTicked(["a.com", "b.com"], new Set(["a.com", "b.com", "c.com"])), true);
    assert.equal(allShownTicked(["a.com", "b.com"], new Set(["a.com"])), false);
    assert.equal(allShownTicked([], new Set(["a.com"])), false);
  });

  test("importedFirst：已导入过的排最前，两组内部保持原来的字母序；没导入过任何网站时原样", () => {
    const sites = [{ site: "a.com" }, { site: "github.com" }, { site: "google.com" }, { site: "z.com" }];
    assert.deepEqual(
      importedFirst(sites, new Set(["google.com", "github.com"])).map((item) => item.site),
      ["github.com", "google.com", "a.com", "z.com"],
    );
    assert.deepEqual(importedFirst(sites, new Set()).map((item) => item.site), ["a.com", "github.com", "google.com", "z.com"]);
  });
});
