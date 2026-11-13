/**
 * 召回的两路融合 —— **纯模块**，可被 `node --test` 直接测。
 *
 * 选型报告（e19bf631，2026-10-29）的关键发现：**等权 RRF 对强向量模型是负
 * 收益**（gemma-2 单独 R@5 0.432，等权融合掉到 0.364；弱向量才靠字面补）。
 * 所以这里做加权 RRF：向量臂权重高、字面臂兜底——具体权重由真实记忆条目上的
 * 小评测钉死（数字见接线 commit 正文），公式与评测脚本同款（k=60）。
 *
 * 只在一路出现的条目吃那一路的分（另一路按「没进前列」处理，不惩罚为零）；
 * 输出按融合分降序，映射回条目后沿用召回的字符预算由调用方裁。
 */
import type { MemoryEntry, MemoryHit } from "../shared/memory.ts";

/** RRF 的 k（名次平滑；评测脚本同款）。 */
export const RRF_K = 60;
/** 向量臂权重（真实记忆条目小评测钉死：26 条 / 18 个原话查询，3:1 与
 * 2:1、等权 R@5 都是 0.9444；3:1 最贴近强向量臂，词法只作兜底）。 */
export const VECTOR_WEIGHT = 3;
/** 字面臂权重。 */
export const LEXICAL_WEIGHT = 1;
/** 每路取前多少名参与融合。 */
export const FUSE_TOP = 50;

/**
 * 加权 RRF：向量名次表 × 词法命中 → 融合命中的条目（降序）。
 * byId 把两路的 id 映射回条目（词法命中的条目一定在，向量名次里可能有条目
 * 已删——映射不到的 id 丢弃）。
 */
export function fuseRanked(
  vectorRanked: readonly { id: string; score: number }[],
  lexical: readonly MemoryHit[],
  byId: ReadonlyMap<string, MemoryEntry>,
): MemoryHit[] {
  const fused = new Map<string, number>();
  for (let rank = 0; rank < Math.min(FUSE_TOP, vectorRanked.length); rank += 1) {
    const { id } = vectorRanked[rank]!;
    if (!byId.has(id)) continue;
    fused.set(id, (fused.get(id) ?? 0) + (VECTOR_WEIGHT / (RRF_K + rank + 1)));
  }
  for (let rank = 0; rank < Math.min(FUSE_TOP, lexical.length); rank += 1) {
    const { entry } = lexical[rank]!;
    fused.set(entry.id, (fused.get(entry.id) ?? 0) + (LEXICAL_WEIGHT / (RRF_K + rank + 1)));
  }
  return [...fused.entries()]
    .sort(([, a], [, b]) => b - a)
    .flatMap(([id, score]): MemoryHit[] => {
      const entry = byId.get(id);
      return entry === undefined ? [] : [{ entry, score }];
    });
}
