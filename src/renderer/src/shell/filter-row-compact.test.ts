import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { chipCompactAt, COMPACT_ORDER, nextCompactLevel } from "./filter-row-compact.ts";

/** 默认侧栏的真实数字（中文）：全部 57 / 已完成 69 / 星标 57 / 时间范围（只有时钟 + ˅）45；图标态 24；间距 4 */
const ZH = [57, 69, 57, 45] as const;
const base = { fullWidths: ZH, compactWidth: 24, gap: 4 };

describe("chipCompactAt —— 第几档收哪几个", () => {
  it("从最右边的字 chip 起往左收，时间范围最后", () => {
    const at = (level: number): boolean[] => [0, 1, 2, 3].map((i) => chipCompactAt(level, i));
    deepStrictEqual(at(0), [false, false, false, false]);
    deepStrictEqual(at(1), [false, false, true, false]);
    deepStrictEqual(at(3), [true, true, true, false]);
    deepStrictEqual(at(4), [true, true, true, true]);
    strictEqual(COMPACT_ORDER.length, 4);
  });
});

describe("nextCompactLevel —— 放得下的最小档位", () => {
  it("默认侧栏（内容宽 264）：四个全部完整放得下", () => {
    // 57+69+57+45 + 3*4 = 240 ≤ 264
    strictEqual(nextCompactLevel({ ...base, containerWidth: 264 }), 0);
    strictEqual(nextCompactLevel({ ...base, containerWidth: 240 }), 0);
  });

  it("再窄逐个往左收，最后才收时间范围", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 239 }), 1); // 57+69+24+45+12 = 207
    strictEqual(nextCompactLevel({ ...base, containerWidth: 206 }), 2); // 57+24+24+45+12 = 162
    strictEqual(nextCompactLevel({ ...base, containerWidth: 161 }), 3); // 24*3+45+12 = 129
    strictEqual(nextCompactLevel({ ...base, containerWidth: 128 }), 4); // 24*4+12 = 108
  });

  it("全图标也放不下：停在最高档，不死循环", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 50 }), 4);
  });

  it("同一个宽度恒得同一个档（只看记住的完整宽度，不看当前态——不抖）", () => {
    for (const width of [128, 161, 200, 239, 264]) {
      strictEqual(
        nextCompactLevel({ ...base, containerWidth: width }),
        nextCompactLevel({ ...base, containerWidth: width }),
      );
    }
  });

  it("英文标签更长，同样的容器收得更多", () => {
    const en = { ...base, fullWidths: [58, 80, 78, 45] as const };
    strictEqual(nextCompactLevel({ ...base, containerWidth: 240 }), 0); // 240
    strictEqual(nextCompactLevel({ ...en, containerWidth: 240 }), 1); // level 0 = 273 > 240；level 1 = 219
  });

  it("还没量到的 chip 按图标态估，不抛", () => {
    strictEqual(nextCompactLevel({ fullWidths: [null, null, null, null], compactWidth: 24, gap: 4, containerWidth: 264 }), 0);
  });
});
