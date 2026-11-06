/**
 * 引用的位置追踪（CodeMirror 扩展）：划选时登记被选区间，之后每一次改动（用户打字、agent 的外部合并）
 * 都把区间映射到新位置。发送时按它就能准确说出「用户划选的那一处现在在哪」——
 * 上下文比对（shared/quote-anchor.ts）在「恰好在原句上方复制出一模一样的一句」时是对称的、分不出谁是谁，
 * 位置映射不会：插入点在区间起点时起点向后推（assoc = 1），原句仍是原句。
 * 追踪不到（编辑器已换文档、区间里的字被改过）时退回上下文重新定位。
 */
import { type Extension, StateEffect, StateField } from "@codemirror/state";

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
