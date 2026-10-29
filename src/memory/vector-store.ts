/**
 * 向量库 —— 记忆条目的向量存放，**纯模块**：不 import electron，可被
 * `node --test` 直接测。
 *
 * 盘上布局（dir = `<userData>/vector/`）：
 *
 *   manifest.json              全库一份：用的模型与维度（换模型整库重算 = 清空重来）
 *   <token>.bin                每层一个 float32 矩阵（行 × dims，小端）
 *   <token>.index.json         每层行号索引 { entryId: row }（原子重写）
 *
 * 为什么矩阵不用 JSON（#228 条目 JSONL 的同款权衡）：768 维 × 一万条按 JSON
 * 存 ~90MB，float32 二进制 30MB，读的时候一次 readFile + Float32Array 视图，
 * 零解析。索引是小的（一万条 ~几百 KB），JSON 读写方便原子换。
 *
 * 删除与换行：索引重写掉 id，bin 里的行留洞（文件不缩，下次整层重算时自然
 * 压实）——向量是缓存不是账本，可以随时整层重算。
 *
 * 召回打分是暴力点积（矩阵全量载入，一万条 × 768 维 ≈ 毫秒级）：语料是单
 * 作用域几百到几千条，不值得上 ANN 索引；语料长大到十万条再立项。
 */
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic, writeTextAtomic } from "../main/atomic-write.ts";
import { isNotFound } from "../main/fs-errors.ts";

export interface VectorManifest {
  /** 模型标识（如 "embeddinggemma-2"）；换模型必须整库重算 */
  model: string;
  /** 维度（MRL 截断后的实际维度） */
  dims: number;
  updatedAt: number;
}

/** 一层的全量载入：行号 → id 的有序表 + 矩阵（行序与 ids 一致）。 */
export interface LayerVectors {
  ids: string[];
  matrix: Float32Array;
}

function binFile(dir: string, token: string): string {
  return join(dir, `${token}.bin`);
}

function indexFile(dir: string, token: string): string {
  return join(dir, `${token}.index.json`);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

export class VectorStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** 全库清单；null = 还没向量化过。字段不齐当 null（坏文件当没算过，重算即可）。 */
  async manifest(): Promise<VectorManifest | null> {
    const raw = (await readJson(join(this.dir, "manifest.json"))) as Record<string, unknown> | null;
    if (raw === null || typeof raw.model !== "string" || typeof raw.dims !== "number") return null;
    return { model: raw.model, dims: raw.dims, updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0 };
  }

  /**
   * 换模型（或首次启用）：清空全库向量，写新清单。条目 JSONL 不动——向量只是
   * 缓存，重算的来源永远是条目正文。
   */
  async reset(model: string, dims: number, now: number): Promise<void> {
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch (cause) {
      if (!isNotFound(cause)) throw cause;
    }
    for (const name of names) {
      if (name === "manifest.json") continue;
      await rm(join(this.dir, name), { force: true });
    }
    await writeJsonAtomic(join(this.dir, "manifest.json"), { model, dims, updatedAt: now });
  }

  /** 某层的向量条数（只读索引文件，不碰矩阵——状态页统计用）。 */
  async count(token: string): Promise<number> {
    const raw = (await readJson(indexFile(this.dir, token))) as Record<string, unknown> | null;
    if (raw === null) return 0;
    return Object.values(raw).filter((row) => typeof row === "number").length;
  }

  /** 某层是否算过（有索引就有）。 */
  async hasLayer(token: string): Promise<boolean> {
    return (await readJson(indexFile(this.dir, token))) !== null;
  }

  /**
   * 全量载入一层（打分用）。索引坏了 / bin 缺了当没有（向量是缓存，坏了重算）。
   * 矩阵行序与 ids 一致；空层返回 { ids: [], matrix: new Float32Array(0) }。
   */
  async load(token: string, dims: number): Promise<LayerVectors | null> {
    const raw = (await readJson(indexFile(this.dir, token))) as Record<string, unknown> | null;
    if (raw === null) return null;
    const rows = new Map<string, number>();
    for (const [id, row] of Object.entries(raw)) {
      if (typeof row === "number" && Number.isInteger(row) && row >= 0) rows.set(id, row);
    }
    if (rows.size === 0) return null;
    let buffer: Buffer;
    try {
      buffer = await readFile(binFile(this.dir, token));
    } catch (cause) {
      if (isNotFound(cause)) return null;
      throw cause;
    }
    // 行号在 bin 里可能越界（上次写到一半被杀）：越界的行丢弃，剩下的照常用
    const usable = [...rows.entries()].filter(([, row]) => (row + 1) * dims * 4 <= buffer.byteLength);
    if (usable.length === 0) return null;
    const ids = usable.map(([id]) => id);
    const matrix = new Float32Array(usable.length * dims);
    for (let at = 0; at < usable.length; at += 1) {
      const view = new Float32Array(
        buffer.buffer,
        buffer.byteOffset + usable[at]![1]! * dims * 4,
        dims,
      );
      matrix.set(view, at * dims);
    }
    return { ids, matrix };
  }

  /**
   * 写入 / 更新一条的向量：已有行号则原位重写（编辑条目后重算），否则追加一行。
   * bin 的追加用一次 append；原位重写走整文件临时副本 + rename（行定长，重写
   * 不动其它行，但要防「写到一半」读到半行——rename 兜住）。
   */
  async upsert(token: string, id: string, vector: Float32Array, dims: number): Promise<void> {
    const raw = (await readJson(indexFile(this.dir, token))) as Record<string, number> | null;
    const rows = new Map<string, number>(
      Object.entries(raw ?? {}).filter(([, row]) => typeof row === "number"),
    ) as Map<string, number>;
    await mkdir(this.dir, { recursive: true });
    const existing = rows.get(id);
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    if (existing === undefined || !Number.isInteger(existing)) {
      const row = rows.size;
      await appendFile(binFile(this.dir, token), buffer);
      rows.set(id, row);
    } else {
      // 原位重写：读全量 → 换行 → 原子写回（行定长，越界行补齐）
      let current = Buffer.alloc(Math.max((existing + 1) * dims * 4, 0));
      try {
        current = await readFile(binFile(this.dir, token));
        if (current.byteLength < (existing + 1) * dims * 4) {
          const grown = Buffer.alloc((existing + 1) * dims * 4);
          current.copy(grown);
          current = grown;
        }
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;
      }
      buffer.copy(current, existing * dims * 4);
      await writeFile(binFile(this.dir, token), current);
    }
    const index: Record<string, number> = {};
    for (const [entryId, row] of rows) index[entryId] = row;
    await writeTextAtomic(indexFile(this.dir, token), `${JSON.stringify(index)}\n`);
  }

  /**
   * 删条目时同步删行号（bin 留洞）。幂等：不在也完事。整层空了连文件一起删。
   */
  async remove(token: string, ids: readonly string[]): Promise<void> {
    const raw = (await readJson(indexFile(this.dir, token))) as Record<string, number> | null;
    if (raw === null) return;
    const wanted = new Set(ids);
    const kept = Object.fromEntries(Object.entries(raw).filter(([id]) => !wanted.has(id)));
    if (Object.keys(kept).length === Object.keys(raw).length) return;
    if (Object.keys(kept).length === 0) {
      await rm(indexFile(this.dir, token), { force: true });
      await rm(binFile(this.dir, token), { force: true });
      return;
    }
    await writeTextAtomic(indexFile(this.dir, token), `${JSON.stringify(kept)}\n`);
  }
}

/* ---------- 归一化与打分（与评测脚本同口径：L2 归一化后点积） ---------- */

/** L2 归一化（原地）。零向量原样返回（防除零）。 */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let at = 0; at < vector.length; at += 1) sum += vector[at]! * vector[at]!;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let at = 0; at < vector.length; at += 1) vector[at] = vector[at]! / norm;
  }
  return vector;
}

/**
 * 暴力点积打分：query × 矩阵的每一行 → {id, score}[]（降序，截 top）。
 * 向量都归一化过，点积即余弦。dims 用矩阵行推导，query 维度不符返回空
 * （换模型过渡期里 query 与库可能不同维度，宁可不向量，不打出垃圾分）。
 */
export function dotProductRank(
  query: Float32Array,
  layer: LayerVectors,
  top: number,
): { id: string; score: number }[] {
  const dims = query.length;
  if (layer.ids.length === 0 || layer.matrix.length !== layer.ids.length * dims) return [];
  const scored: { id: string; score: number }[] = [];
  for (let row = 0; row < layer.ids.length; row += 1) {
    let dot = 0;
    const base = row * dims;
    for (let at = 0; at < dims; at += 1) dot += query[at]! * layer.matrix[base + at]!;
    scored.push({ id: layer.ids[row]!, score: dot });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, top);
}
