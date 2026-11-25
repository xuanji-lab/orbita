import assert from "node:assert/strict";
import { test } from "node:test";
import { LruCache } from "./lru.ts";

test("命中会刷新新鲜度，淘汰的是最久没用的", () => {
  const lru = new LruCache<number>(2);
  lru.set("a", 1);
  lru.set("b", 2);
  assert.equal(lru.get("a"), 1);
  lru.set("c", 3);
  assert.equal(lru.get("b"), undefined);
  assert.equal(lru.size, 2);
});

test("覆盖同键不增长，delete 生效", () => {
  const lru = new LruCache<number>(2);
  lru.set("a", 1);
  lru.set("a", 2);
  assert.equal(lru.size, 1);
  assert.equal(lru.get("a"), 2);
  lru.delete("a");
  assert.equal(lru.get("a"), undefined);
});

test("values 按最久到最近列出全部候选，本身不刷新新鲜度", () => {
  const lru = new LruCache<number>(3);
  lru.set("a", 1);
  lru.set("b", 2);
  lru.set("c", 3);
  assert.deepEqual(lru.values(), [1, 2, 3]);
  lru.set("d", 4);
  assert.deepEqual(lru.values(), [2, 3, 4]);
});
