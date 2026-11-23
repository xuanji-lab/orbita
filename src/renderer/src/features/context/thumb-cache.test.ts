import assert from "node:assert/strict";
import { test } from "node:test";
import { createThumbCache } from "./thumb-cache.ts";

test("键按会话 + 路径分开", () => {
  const cache = createThumbCache<string>();
  assert.notEqual(cache.key("a", "/x.html"), cache.key("b", "/x.html"));
  assert.notEqual(cache.key(null, "/x.html"), cache.key("a", "/x.html"));
});

test("戳没变不算变，变了或没有旧的才算", () => {
  const cache = createThumbCache<string>();
  const key = cache.key("a", "/x.html");
  assert.equal(cache.changed(cache.get(key), 5), true);
  cache.set(key, { data: "img", stamp: 5 });
  assert.equal(cache.changed(cache.get(key), 5), false);
  assert.equal(cache.changed(cache.get(key), 6), true);
});

test("超出上限淘汰最久没用的", () => {
  const cache = createThumbCache<number>(2);
  cache.set("a", { data: 1, stamp: 1 });
  cache.set("b", { data: 2, stamp: 1 });
  cache.get("a");
  cache.set("c", { data: 3, stamp: 1 });
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a")?.data, 1);
});
