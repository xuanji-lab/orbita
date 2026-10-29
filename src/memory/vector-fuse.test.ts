/**
 * 加权 RRF 融合（vector-fuse.ts）——强向量臂不被弱字面拖累、单路条目照收。
 * 纯模块直测（node --test）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fuseRanked, VECTOR_WEIGHT, LEXICAL_WEIGHT, RRF_K } from "./vector-fuse.ts";
import type { MemoryEntry, MemoryHit } from "../shared/memory.ts";

function entry(id: string): MemoryEntry {
  return {
    id,
    type: "fact",
    text: `条目 ${id}`,
    keywords: [],
    layer: "workspace",
    scopeId: "ws",
    sessionId: "s",
    turns: [1],
    at: 1,
    episodeId: "ep",
    source: "chat",
  };
}

function hit(id: string, score: number): MemoryHit {
  return { entry: entry(id), score };
}

test("两路都有的条目吃两份分；只在一路的吃单份", () => {
  const byId = new Map(["va", "vb", "la"].map((id) => [id, entry(id)]));
  const fused = fuseRanked(
    [ { id: "va", score: 0.9 }, { id: "vb", score: 0.8 } ],
    [hit("la", 0.5), hit("va", 0.4)],
    byId,
  );
  const ids = fused.map((each) => each.entry.id);
  assert.ok(ids.includes("va"));
  assert.ok(ids.includes("vb"));
  assert.ok(ids.includes("la"));
  // va 两路都有 → 分最高
  assert.equal(fused[0]?.entry.id, "va");
  const expected = VECTOR_WEIGHT / (RRF_K + 1) + LEXICAL_WEIGHT / (RRF_K + 2);
  assert.ok(Math.abs((fused[0]?.score ?? 0) - expected) < 1e-12);
});

test("向量第一名稳赢字面第一名（等权 RRF 的教训），映射不到的 id 丢弃", () => {
  const byId = new Map(["v1", "l1"].map((id) => [id, entry(id)]));
  const fused = fuseRanked([{ id: "v1", score: 0.9 }], [hit("l1", 0.9)], byId);
  // v1：向量第 1 名 3/(60+1)；l1：字面第 1 名 1/(60+1)——v1 在前
  assert.deepEqual(fused.map((each) => each.entry.id), ["v1", "l1"]);
  // 幽灵 id（条目已删）被丢
  const clean = fuseRanked([{ id: "ghost", score: 1 }], [], byId);
  assert.deepEqual(clean, []);
});
