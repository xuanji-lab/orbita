import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { chipCompactAt, COMPACT_ORDER, nextCompactLevel } from "./filter-row-compact.ts";

/**
 * 「以前的会话」那一页的筛选行（2026-11-17 起只剩两格：星标 57 / 时间范围（只有时钟 + ˅）45；图标态 24；间距 4）。
 * 「全部 / 已完成」两格随手动「完成」一起去掉。
 */
const ZH = [57, 45] as const;
const base = { fullWidths: ZH, compactWidth: 24, gap: 4 };

describe("chipCompactAt —— 第几档收哪几个", () => {
  it("先收星标，时间范围最后", () => {
    const at = (level: number): boolean[] => [0, 1].map((i) => chipCompactAt(level, i));
    deepStrictEqual(at(0), [false, false]);
    deepStrictEqual(at(1), [true, false]);
    deepStrictEqual(at(2), [true, true]);
    strictEqual(COMPACT_ORDER.length, 2);
  });
});

describe("nextCompactLevel —— 放得下的最小档位", () => {
  it("默认侧栏放得下两个完整的", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 264 }), 0);
    strictEqual(nextCompactLevel({ ...base, containerWidth: 106 }), 0); // 57+45+4
  });

  it("再窄先收星标，最后才收时间范围；全图标也放不下停在最高档", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 105 }), 1); // 24+45+4 = 73
    strictEqual(nextCompactLevel({ ...base, containerWidth: 72 }), 2); // 24+24+4 = 52
    strictEqual(nextCompactLevel({ ...base, containerWidth: 20 }), 2);
  });

  it("还没量到的 chip 按图标态估，不抛", () => {
    strictEqual(nextCompactLevel({ fullWidths: [null, null], compactWidth: 24, gap: 4, containerWidth: 264 }), 0);
  });
});
