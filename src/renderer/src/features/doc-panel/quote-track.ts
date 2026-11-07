/**
 * 引用的位置追踪（CodeMirror 扩展）：划选时登记被选区间，之后每一次改动（用户打字、agent 的外部合并）
 * 都把区间映射到新位置。发送时按它就能准确说出「用户划选的那一处现在在哪」——
 * 上下文比对（shared/quote-anchor.ts）在「恰好在原句上方复制出一模一样的一句」时是对称的、分不出谁是谁，
 * 位置映射不会：插入点在区间起点时起点向后推（assoc = 1），原句仍是原句。
 * 追踪不到（编辑器已换文档、区间里的字被改过）时退回上下文重新定位。
 */
import { ChangeSet, type Extension, StateEffect, StateField } from "@codemirror/state";
import { diffToChanges } from "./doc-merge.ts";

interface Tracked {
  from: number;
  to: number;
}

export const trackRange = StateEffect.define<{ id: string; from: number; to: number }>();

/** 最多同时追踪多少个区间：只会是「输入框里的引用」那么多，老的丢掉 */
const MAX_TRACKED = 24;

export const quoteTrackField = StateField.define<ReadonlyMap<string, Tracked>>({
  create: () => new Map(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) {
      const mapped = new Map<string, Tracked>();
      for (const [id, range] of value) {
        mapped.set(id, { from: tr.changes.mapPos(range.from, 1), to: Math.max(tr.changes.mapPos(range.from, 1), tr.changes.mapPos(range.to, -1)) });
      }
      next = mapped;
    }
    for (const effect of tr.effects) {
      if (!effect.is(trackRange)) continue;
      const copy = new Map(next);
      copy.set(effect.value.id, { from: effect.value.from, to: effect.value.to });
      while (copy.size > MAX_TRACKED) copy.delete(copy.keys().next().value as string);
      next = copy;
    }
    return next;
  },
});

export function quoteTracker(): Extension {
  return quoteTrackField;
}

/** 一个区间在编辑器之外的快照：卸载时存、重新挂载时取 */
export interface TrackedSnapshot {
  /** 存的时候编辑器里的全文（重新打开时盘上可能已被 agent 改过：拿它和现在的文字做差异，把区间映射过去） */
  text: string;
  ranges: Record<string, { from: number; to: number }>;
}

/**
 * 面板之上的存储（模块级，按文件路径）。编辑器实例会随面板关闭 / 切页签卸载，追踪的区间不能跟着没了——
 * 否则退回上下文打分，在「紧贴着复制出一模一样的一句」时会偏向复制出来的那句，agent 静默改错位置
 * （2026-11-07 第二次独立验收 m3f / m3g）。
 */
const store = new Map<string, TrackedSnapshot>();
/** 最多记多少份文档的追踪：超出丢最早的 */
const MAX_FILES = 20;

export function saveTracked(path: string, snapshot: TrackedSnapshot): void {
  if (Object.keys(snapshot.ranges).length === 0) {
    store.delete(path);
    return;
  }
  store.delete(path);
  store.set(path, snapshot);
  while (store.size > MAX_FILES) store.delete(store.keys().next().value as string);
}

export function loadTracked(path: string): TrackedSnapshot | null {
  return store.get(path) ?? null;
}

export function clearTrackedStore(): void {
  store.clear();
}

/** 把旧全文里的区间映射到新全文（盘上在关面板期间被改过时用）。映射规则同编辑器里的 `quoteTrackField` */
export function mapRanges(
  oldText: string,
  newText: string,
  ranges: Record<string, { from: number; to: number }>,
): Record<string, { from: number; to: number }> {
  if (oldText === newText) return { ...ranges };
  const set = ChangeSet.of(diffToChanges(oldText, newText), oldText.length);
  const out: Record<string, { from: number; to: number }> = {};
  for (const [id, range] of Object.entries(ranges)) {
    const from = set.mapPos(range.from, 1);
    out[id] = { from, to: Math.max(from, set.mapPos(range.to, -1)) };
  }
  return out;
}

let anchorSeq = 0;
/** 全局唯一的锚点 id（编辑器重挂载后计数不归零，不会和存下来的旧 id 撞） */
export function newAnchorId(): string {
  anchorSeq += 1;
  return `q${Date.now().toString(36)}-${anchorSeq}`;
}
