/**
 * 向量库（vector-store.ts）——布局、追加 / 原位重写、删除留洞、打分。
 * 纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VectorStore, dotProductRank, normalize } from "./vector-store.ts";

const DIMS = 4;

function vector(...values: number[]): Float32Array {
  return normalize(new Float32Array(values));
}

test("manifest：null 起步；reset 清库写新清单", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  assert.equal(await store.manifest(), null);
  await store.upsert("user", "mem_1", vector(1, 0, 0, 0), DIMS);
  await store.reset("embeddinggemma-2", DIMS, 100);
  assert.deepEqual(await store.manifest(), { model: "embeddinggemma-2", dims: DIMS, updatedAt: 100 });
  assert.equal(await store.hasLayer("user"), false); // 旧向量清掉了
});

test("upsert / load：追加与原位重写；打分点积降序", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  await store.upsert("user", "b", vector(0, 1, 0, 0), DIMS);
  await store.upsert("user", "c", vector(0.9, 0.1, 0, 0), DIMS);
  const layer = (await store.load("user", DIMS))!;
  assert.deepEqual(layer.ids, ["a", "b", "c"]);
  const ranked = dotProductRank(vector(1, 0, 0, 0), layer, 2);
  assert.deepEqual(ranked.map((hit) => hit.id), ["a", "c"]); // c 与 query 同向但略偏
  assert.ok(ranked[0]!.score > ranked[1]!.score);

  // 编辑后重算：原位重写，行数不变、值更新
  await store.upsert("user", "b", vector(0, 0, 1, 0), DIMS);
  const rewritten = (await store.load("user", DIMS))!;
  assert.equal(rewritten.ids.length, 3);
  assert.deepEqual(dotProductRank(vector(0, 0, 1, 0), rewritten, 1).map((h) => h.id), ["b"]);
});

test("remove：行号删、整层空了连文件删；bin 留洞但不炸 load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  await store.upsert("user", "b", vector(0, 1, 0, 0), DIMS);
  await store.remove("user", ["a"]);
  const layer = (await store.load("user", DIMS))!;
  assert.deepEqual(layer.ids, ["b"]); // a 的行成了洞，索引里没了
  await store.remove("user", ["b", "不在的"]);
  assert.equal(await store.hasLayer("user"), false);
  assert.equal(await store.load("user", DIMS), null);
});

test("load 容错：索引指向越界行（写到一半被杀）丢弃越界行", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  await store.upsert("user", "b", vector(0, 1, 0, 0), DIMS);
  // 手工把 b 的行号改到越界
  await writeFile(join(dir, "user.index.json"), `${JSON.stringify({ a: 0, b: 99 })}\n`, "utf8");
  const layer = await store.load("user", DIMS);
  assert.deepEqual(layer?.ids, ["a"]);
});

test("dotProductRank：维度不符返回空（换模型过渡期宁缺勿错）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  const layer = (await store.load("user", DIMS))!;
  assert.deepEqual(dotProductRank(new Float32Array(8), layer, 5), []);
});
