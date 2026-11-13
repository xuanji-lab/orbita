/**
 * 向量库（vector-store.ts）——布局、追加 / 原位重写、删除留洞、打分。
 * 纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
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
  assert.deepEqual(await store.manifest(), { version: 2, model: "embeddinggemma-2", dims: DIMS, updatedAt: 100 });
  assert.equal(await store.hasLayer("user"), false); // 旧向量清掉了
});

test("manifest：旧版没有行号布局版本，判为失效以触发整库重算", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify({ model: "embeddinggemma-2", dims: DIMS, updatedAt: 100 })}\n`,
    "utf8",
  );
  assert.equal(await new VectorStore(dir).manifest(), null);
});

test("upsert：删掉中间行留洞后，新行不撞上仍存活的向量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  await store.upsert("user", "b", vector(0, 1, 0, 0), DIMS);
  await store.upsert("user", "c", vector(0, 0, 1, 0), DIMS);
  await store.remove("user", ["b"]);
  await store.upsert("user", "d", vector(0, 0, 0, 1), DIMS);

  const layer = (await store.load("user", DIMS))!;
  assert.deepEqual(dotProductRank(vector(0, 0, 0, 1), layer, 1).map((hit) => hit.id), ["d"]);
  assert.deepEqual(dotProductRank(vector(0, 0, 1, 0), layer, 1).map((hit) => hit.id), ["c"]);
});

/** 读回某条在矩阵里的实际值（直接比对，不靠打分并列） */
function rowOf(layer: { ids: string[]; matrix: Float32Array }, id: string): number[] {
  const at = layer.ids.indexOf(id);
  assert.ok(at >= 0, `${id} 不在层里`);
  return Array.from(layer.matrix.slice(at * DIMS, (at + 1) * DIMS));
}

test("upsert：删掉的是最后一行时，新行仍落在 bin 末尾之后，不指向被删行的旧向量", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  await store.upsert("user", "b", vector(0, 1, 0, 0), DIMS);
  await store.upsert("user", "c", vector(0, 0, 1, 0), DIMS);
  await store.remove("user", ["c"]); // bin 仍是 3 行，索引最大行号只剩 1
  await store.upsert("user", "d", vector(0, 0, 0, 1), DIMS);
  await store.upsert("user", "e", vector(1, 1, 0, 0), DIMS);
  const layer = (await store.load("user", DIMS))!;
  assert.deepEqual(rowOf(layer, "d"), Array.from(vector(0, 0, 0, 1)));
  assert.deepEqual(rowOf(layer, "e"), Array.from(vector(1, 1, 0, 0)));
  assert.deepEqual(rowOf(layer, "a"), Array.from(vector(1, 0, 0, 0)));
});

test("upsert：bin 尾部有写到一半的残行时，新行覆盖残行对齐，不错位", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orbita-vec-"));
  const store = new VectorStore(dir);
  await store.upsert("user", "a", vector(1, 0, 0, 0), DIMS);
  await appendFile(join(dir, "user.bin"), Buffer.alloc(5, 0xff)); // 追加到一半被杀
  await store.upsert("user", "b", vector(0, 1, 0, 0), DIMS);
  const layer = (await store.load("user", DIMS))!;
  assert.deepEqual(rowOf(layer, "b"), Array.from(vector(0, 1, 0, 0)));
  assert.deepEqual(rowOf(layer, "a"), Array.from(vector(1, 0, 0, 0)));
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
