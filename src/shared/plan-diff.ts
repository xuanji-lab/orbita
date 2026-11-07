/**
 * 两版计划的对比（2026-10-30）：用户要看到的是「从什么改成了什么」，而计划每次都是整张替换——
 * 模型不给步骤编号，也不该给：模型最常见的错是**重新编号**（在第 1 步后插一步，2→3、3→4），
 * 编号一乱「改了什么」就全错，所以步骤的对应关系由系统按文字对齐。
 *
 * 对齐（纯函数，输入两张清单，输出新清单每一步对应旧清单的哪一步）：
 * 1. 文字完全相同的先配对；其中相对顺序不再单调的（最长递增子序列之外的）算「调了顺序」；
 * 2. 稳定配对把清单切成若干空档。空档里先看拆 / 合：旧的 1 条对新的 ≥ 2 条且文字有包含 / 重叠关系 = 拆成；
 *    反之 = 合成（不先看的话，「写测试并跑通」→「写测试」「跑通测试」会被相似度配成一个改说法加一个新增）；
 * 3. 不是拆 / 合的，剩下的步按相似度（字符二元组 Dice ≥ 0.5）配对，且不许交叉（保序）——配上但文字不同的
 *    算「改了说法」；仍没配上的，新的是「加了」、旧的是「去掉了」；
 * 4. 只有 status 变（打勾 / 换到下一步）不产生任何改动——这是面板与对话不提示的依据。
 *    唯一的例外在 `waits`（2026-11-06）：一步新变成 waiting（等你 / 等外部）单独记一份，不进 changes——
 *    它不是「计划的结构改了」（不计入「改过 N 次」、不让 plan 档停下），但对话里要能说一句「X 在等你」。
 * 5. 「调了顺序」里挑谁算被挪的：最长递增子序列同长有几种取法时，**在做的那一步优先算被挪的**——
 *    用户说「先做第 3 步」，计划从 [1,2,3,4] 变成 [1,3,2,4]，该说「把 3 提到前面」，而不是「2 挪到 4 前面」。
 * 新清单与旧清单一步都对不上 = 一张新计划（fresh），不逐条报。
 *
 * 纯模块：不 import electron / React，可被 node --test 直接加载。工具（决定要不要停下来等确认）
 * 与右栏面板（改动标记）用同一份对齐。
 */
import type { PlanItem } from "./plan.ts";

export type PlanChange =
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "reworded"; from: string; to: string }
  | {
      kind: "moved";
      text: string;
      /** 挪到了哪一步前面；null = 挪到了最后 */
      before: string | null;
      /** 往前提了（它前面的稳定步变少了）；false = 往后挪。文案据此说「提到…前面」还是「挪到…前面」 */
      earlier: boolean;
    }
  | { kind: "split"; from: string; into: string[] }
  | { kind: "merged"; from: string[]; into: string }
  /** 只出现在对话提示里（PlanDiff.waits → planNoticeOf）：一步变成了 waiting；diffPlans 的 changes 里没有它 */
  | { kind: "waiting"; text: string; waitingFor: string | null };

export interface PlanDiff {
  /** 新清单每一步对应旧清单的第几步（下标）；null = 新出现的 */
  pairs: (number | null)[];
  /**
   * 改动，按先后：新清单里的（加 / 改说法 / 挪 / 拆 / 合）按新清单的顺序，去掉的排在最后。
   * 只有 status 变时为空。
   */
  changes: PlanChange[];
  /** 旧清单里被去掉的步，及它原来排在「新清单第几步之后」（-1 = 最前）：面板在原位置画划线灰行 */
  removed: { text: string; afterNext: number }[];
  /** 拆 / 合 / 改说法而来的步的出处：新清单下标 → 旧步的文字（面板第二行写「原：…」/「从「…」拆出」） */
  origins: Map<number, { kind: "reworded" | "split"; from: string }>;
  /** 这一版新变成 waiting 的步（旧版里配得上、且当时不是 waiting），按新清单顺序；不计入 changes */
  waits: { text: string; waitingFor: string | null }[];
  /** 有旧清单、但与它一步都对不上 = 一张新计划 */
  fresh: boolean;
}

/** 配对的相似度门槛：Dice ≥ 它才算同一步改了说法 */
export const SIMILAR_AT = 0.5;
/** 拆 / 合时「文字有关系」的门槛：低一些——拆出来的每一块只是原文的一部分 */
const RELATED_AT = 0.3;

function bigrams(text: string): Map<string, number> {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")];
  const grams = new Map<string, number>();
  if (chars.length === 0) return grams;
  if (chars.length === 1) {
    grams.set(chars[0] ?? "", 1);
    return grams;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const gram = `${chars[i]}${chars[i + 1]}`;
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** 字符二元组的 Dice 系数（0–1）；任一边去掉标点空白后为空 = 0 */
export function dice(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  let sizeA = 0;
  let sizeB = 0;
  for (const count of left.values()) sizeA += count;
  for (const count of right.values()) sizeB += count;
  if (sizeA === 0 || sizeB === 0) return 0;
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (sizeA + sizeB);
}

function related(whole: string, part: string): boolean {
  const w = whole.toLowerCase();
  const p = part.toLowerCase();
  return w.includes(p) || p.includes(w) || dice(whole, part) >= RELATED_AT;
}

/**
 * 递增子序列（返回在 seq 里的下标集合）：最长的一条，同长取靠前的。
 * `weights` 给每个元素一个权重（缺省 1）：同长时总权重大的赢——元素权重略低于 1，就是「同长时让它优先被挪」；
 * 权重差不超过 0.1 × 元素数，不会盖过真正更长的序列。
 */
function longestIncreasing(seq: readonly number[], weights: readonly number[] = []): Set<number> {
  const w = (i: number): number => weights[i] ?? 1;
  const best: number[] = seq.map((_, i) => w(i));
  const from: number[] = seq.map(() => -1);
  let end = -1;
  for (let i = 0; i < seq.length; i++) {
    for (let j = 0; j < i; j++) {
      if ((seq[j] ?? 0) < (seq[i] ?? 0) && (best[j] ?? 0) + w(i) > (best[i] ?? 0) + 1e-9) {
        best[i] = (best[j] ?? 0) + w(i);
        from[i] = j;
      }
    }
    if (end === -1 || (best[i] ?? 0) > (best[end] ?? 0)) end = i;
  }
  const keep = new Set<number>();
  for (let i = end; i !== -1; i = from[i] ?? -1) keep.add(i);
  return keep;
}

export function diffPlans(prev: readonly PlanItem[] | null, next: readonly PlanItem[]): PlanDiff {
  const empty: PlanDiff = { pairs: next.map(() => null), changes: [], removed: [], origins: new Map(), waits: [], fresh: false };
  if (prev === null || prev.length === 0) return empty;

  const pairs: (number | null)[] = next.map(() => null);
  const prevTaken: boolean[] = prev.map(() => false);

  // 1. 文字完全相同的先配对（按先后各取第一个没被占的）
  next.forEach((item, i) => {
    const j = prev.findIndex((old, index) => !prevTaken[index] && old.text === item.text);
    if (j === -1) return;
    pairs[i] = j;
    prevTaken[j] = true;
  });
  // 相对顺序不再单调的：最长递增子序列之外的算「调了顺序」
  const exactNext: number[] = [];
  pairs.forEach((j, i) => {
    if (j !== null) exactNext.push(i);
  });
  // 在做的步权重略低（0.9）：同长的几种取法里，它优先被当成「挪过的」
  const stableIdx = longestIncreasing(
    exactNext.map((i) => pairs[i] ?? 0),
    exactNext.map((i) => (next[i]?.status === "in_progress" ? 0.9 : 1)),
  );
  const stable = exactNext.filter((_, k) => stableIdx.has(k));
  const movedNext = new Set(exactNext.filter((_, k) => !stableIdx.has(k)));

  // 2/3. 稳定配对切出空档，空档里按相似度配对，剩下的拆 / 合 / 加 / 去
  const origins = new Map<number, { kind: "reworded" | "split"; from: string }>();
  const addedAt = new Set<number>();
  const removedAt = new Set<number>();
  const splitAt = new Map<number, { from: string; into: number[] }>();
  const mergedAt = new Map<number, { from: number[]; into: number }>();
  const bounds: [number, number][] = [[-1, -1], ...stable.map((i): [number, number] => [i, pairs[i] ?? 0]), [next.length, prev.length]];
  for (let g = 0; g < bounds.length - 1; g++) {
    const [ia, ja] = bounds[g] ?? [-1, -1];
    const [ib, jb] = bounds[g + 1] ?? [next.length, prev.length];
    const nextIdx: number[] = [];
    for (let i = ia + 1; i < ib; i++) if (pairs[i] === null) nextIdx.push(i);
    const prevIdx: number[] = [];
    for (let j = ja + 1; j < jb; j++) if (!prevTaken[j]) prevIdx.push(j);
    // 先看是不是拆 / 合：「写测试并跑通」→「写测试」「跑通测试」若先按相似度配，会被当成一个改说法加一个新增
    if (prevIdx.length === 1 && nextIdx.length >= 2) {
      const from = prevIdx[0] ?? 0;
      const parts = nextIdx.filter((i) => related(prev[from]?.text ?? "", next[i]?.text ?? ""));
      if (parts.length >= 2) {
        splitAt.set(parts[0] ?? 0, { from: prev[from]?.text ?? "", into: parts });
        for (const i of parts) origins.set(i, { kind: "split", from: prev[from]?.text ?? "" });
        prevTaken[from] = true;
        for (const i of nextIdx) if (!parts.includes(i)) addedAt.add(i);
        continue;
      }
    }
    if (nextIdx.length === 1 && prevIdx.length >= 2) {
      const into = nextIdx[0] ?? 0;
      const parts = prevIdx.filter((j) => related(next[into]?.text ?? "", prev[j]?.text ?? ""));
      if (parts.length >= 2) {
        mergedAt.set(into, { from: parts, into });
        for (const j of parts) prevTaken[j] = true;
        for (const j of prevIdx) if (!parts.includes(j)) removedAt.add(j);
        continue;
      }
    }
    // 相似度配对：分数从高到低，一对一，且不许与已选的交叉
    const candidates = nextIdx
      .flatMap((i) => prevIdx.map((j) => ({ i, j, score: dice(next[i]?.text ?? "", prev[j]?.text ?? "") })))
      .filter((c) => c.score >= SIMILAR_AT)
      .sort((a, b) => b.score - a.score || a.i - b.i || a.j - b.j);
    const chosen: { i: number; j: number }[] = [];
    for (const c of candidates) {
      if (chosen.some((o) => o.i === c.i || o.j === c.j || (o.i < c.i) !== (o.j < c.j))) continue;
      chosen.push(c);
    }
    for (const { i, j } of chosen) {
      pairs[i] = j;
      prevTaken[j] = true;
      origins.set(i, { kind: "reworded", from: prev[j]?.text ?? "" });
    }
    const leftNext = nextIdx.filter((i) => pairs[i] === null);
    const leftPrev = prevIdx.filter((j) => !prevTaken[j]);
    for (const i of leftNext) addedAt.add(i);
    for (const j of leftPrev) removedAt.add(j);
  }

  const fresh = pairs.every((j) => j === null) && !mergedAt.size && !splitAt.size;
  if (fresh) return { ...empty, fresh: true };

  const changes: PlanChange[] = [];
  next.forEach((item, i) => {
    const origin = origins.get(i);
    if (movedNext.has(i)) {
      const j = pairs[i] ?? 0;
      const stableBefore = stable.filter((k) => k < i).length;
      const stableBeforeOld = stable.filter((k) => (pairs[k] ?? 0) < j).length;
      changes.push({ kind: "moved", text: item.text, before: next[i + 1]?.text ?? null, earlier: stableBefore < stableBeforeOld });
    }
    if (origin?.kind === "reworded" && origin.from !== item.text) {
      changes.push({ kind: "reworded", from: origin.from, to: item.text });
      return;
    }
    const split = splitAt.get(i);
    if (split !== undefined) {
      changes.push({ kind: "split", from: split.from, into: split.into.map((k) => next[k]?.text ?? "") });
      return;
    }
    const merged = mergedAt.get(i);
    if (merged !== undefined) {
      changes.push({ kind: "merged", from: merged.from.map((k) => prev[k]?.text ?? ""), into: item.text });
      return;
    }
    if (addedAt.has(i)) changes.push({ kind: "added", text: item.text });
  });
  // 去掉的：记原位置（排在新清单哪一步之后），changes 里排最后
  const removed: PlanDiff["removed"] = [];
  for (const j of [...removedAt].sort((a, b) => a - b)) {
    let afterNext = -1;
    for (let i = 0; i < next.length; i++) {
      const pj = pairs[i];
      if (pj !== null && pj !== undefined && pj < j) afterNext = Math.max(afterNext, i);
    }
    removed.push({ text: prev[j]?.text ?? "", afterNext });
    changes.push({ kind: "removed", text: prev[j]?.text ?? "" });
  }
  // 新变成 waiting 的步：旧版里配得上、当时不是 waiting（一开始就写成 waiting 的新步算「加了」，不算「变成」）
  const waits: PlanDiff["waits"] = [];
  next.forEach((item, i) => {
    const j = pairs[i];
    if (item.status !== "waiting" || j === null || j === undefined || prev[j]?.status === "waiting") return;
    waits.push({ text: item.text, waitingFor: item.waitingFor ?? null });
  });
  return { pairs, changes, removed, origins, waits, fresh: false };
}

/**
 * 按对齐结果给新清单每一步分配 id：配上的沿用旧 id，新出现的（加 / 拆出 / 合成）取新的。
 * `prevIds` 与旧清单一一对应；旧清单为 null 或一张新计划（fresh）时全部取新 id。
 */
export function assignStepIds(prevIds: readonly string[] | null, diff: PlanDiff, mint: () => string): string[] {
  return diff.pairs.map((j) => (j === null || prevIds === null ? mint() : (prevIds[j] ?? mint())));
}
