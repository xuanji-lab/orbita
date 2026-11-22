import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { chipCompactAt, COMPACT_ORDER, nextCompactLevel } from "./filter-row-compact.ts";

/** 默认侧栏的真实数字（中文）：全部 57 / 星标 57 / 时间范围（只有时钟 + ˅）45；图标态 24；间距 4 */
const ZH = [57, 57, 45] as const;
const base = { fullWidths: ZH, compactWidth: 24, gap: 4 };

describe("chipCompactAt —— 第几档收哪几个", () => {
  it("从最右边的字 chip 起往左收，时间范围最后", () => {
    const at = (level: number): boolean[] => [0, 1, 2].map((i) => chipCompactAt(level, i));
    deepStrictEqual(at(0), [false, false, false]);
    deepStrictEqual(at(1), [false, true, false]);
    deepStrictEqual(at(2), [true, true, false]);
    deepStrictEqual(at(3), [true, true, true]);
    strictEqual(COMPACT_ORDER.length, 3);
  });
});

describe("nextCompactLevel —— 放得下的最小档位", () => {
  it("放得下全部完整：0 档（默认侧栏内容宽 264 也是）", () => {
    // 57+57+45 + 2*4 = 167
    strictEqual(nextCompactLevel({ ...base, containerWidth: 167 }), 0);
    strictEqual(nextCompactLevel({ ...base, containerWidth: 264 }), 0);
  });

  it("再窄逐个往左收，最后才收时间范围", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 150 }), 1); // 57+24+45+8 = 134 ≤ 150；level 0 = 167 > 150
    strictEqual(nextCompactLevel({ ...base, containerWidth: 120 }), 2); // 24+24+45+8 = 101 ≤ 120；level 1 = 134 > 120
    strictEqual(nextCompactLevel({ ...base, containerWidth: 90 }), 3); // 24*3+8 = 80 ≤ 90；level 2 = 101 > 90
  });

  it("全图标也放不下：停在最高档，不死循环", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 50 }), 3);
  });

  it("同一个宽度恒得同一个档（只看记住的完整宽度，不看当前态——不抖）", () => {
    for (const width of [90, 120, 150, 167, 264]) {
      strictEqual(
        nextCompactLevel({ ...base, containerWidth: width }),
        nextCompactLevel({ ...base, containerWidth: width }),
      );
    }
  });

  it("英文标签更长，同样的容器收得更多", () => {
    const en = { ...base, fullWidths: [58, 78, 45] as const };
    strictEqual(nextCompactLevel({ ...base, containerWidth: 170 }), 0); // 167
    strictEqual(nextCompactLevel({ ...en, containerWidth: 170 }), 1); // level 0 = 189 > 170
  });

  it("还没量到的 chip 按图标态估，不抛", () => {
    strictEqual(nextCompactLevel({ fullWidths: [null, null, null], compactWidth: 24, gap: 4, containerWidth: 264 }), 0);
  });
});
