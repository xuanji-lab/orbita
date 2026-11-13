import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { chipCompactAt, COMPACT_ORDER, nextCompactLevel } from "./filter-row-compact.ts";

/** 默认侧栏的真实数字（中文）：全部 57 / 已完成 69 / 星标 57 / 有待办 69 / 时间范围（只有时钟 + ˅）45；图标态 24；间距 4 */
const ZH = [57, 69, 57, 69, 45] as const;
const base = { fullWidths: ZH, compactWidth: 24, gap: 4 };

describe("chipCompactAt —— 第几档收哪几个", () => {
  it("从最右边的字 chip 起往左收，时间范围最后", () => {
    const at = (level: number): boolean[] => [0, 1, 2, 3, 4].map((i) => chipCompactAt(level, i));
    deepStrictEqual(at(0), [false, false, false, false, false]);
    deepStrictEqual(at(1), [false, false, false, true, false]);
    deepStrictEqual(at(2), [false, false, true, true, false]);
    deepStrictEqual(at(4), [true, true, true, true, false]);
    deepStrictEqual(at(5), [true, true, true, true, true]);
    strictEqual(COMPACT_ORDER.length, 5);
  });
});

describe("nextCompactLevel —— 放得下的最小档位", () => {
  it("放得下全部完整：0 档", () => {
    // 57+69+57+69+45 + 4*4 = 313
    strictEqual(nextCompactLevel({ ...base, containerWidth: 313 }), 0);
    strictEqual(nextCompactLevel({ ...base, containerWidth: 376 }), 0);
  });

  it("默认侧栏（内容宽 264）：收灯泡与星标两个，全部 / 已完成保留文字——正是设计稿 c 图", () => {
    // level 2：57+69+24+24+45 + 16 = 235 ≤ 264；level 1：57+69+57+24+45+16 = 268 > 264
    strictEqual(nextCompactLevel({ ...base, containerWidth: 264 }), 2);
  });

  it("再窄逐个往左收，最后才收时间范围", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 230 }), 3); // 57+24+24+24+45+16 = 190 ≤ 230；level 2 = 235 > 230
    strictEqual(nextCompactLevel({ ...base, containerWidth: 189 }), 4); // 24*4+45+16 = 157 ≤ 189；level 3 = 190 > 189
    strictEqual(nextCompactLevel({ ...base, containerWidth: 150 }), 5); // 24*5+16 = 136
  });

  it("全图标也放不下：停在最高档，不死循环", () => {
    strictEqual(nextCompactLevel({ ...base, containerWidth: 50 }), 5);
  });

  it("同一个宽度恒得同一个档（只看记住的完整宽度，不看当前态——不抖）", () => {
    for (const width of [150, 189, 200, 230, 264, 300, 313]) {
      strictEqual(
        nextCompactLevel({ ...base, containerWidth: width }),
        nextCompactLevel({ ...base, containerWidth: width }),
      );
    }
  });

  it("英文标签更长，同样的容器收得更多", () => {
    const en = { ...base, fullWidths: [58, 80, 78, 96, 45] as const };
    strictEqual(nextCompactLevel({ ...base, containerWidth: 240 }), 2); // 57+69+24+24+45+16 = 235
    strictEqual(nextCompactLevel({ ...en, containerWidth: 240 }), 3); // level 2 = 247 > 240
  });

  it("还没量到的 chip 按图标态估，不抛", () => {
    strictEqual(nextCompactLevel({ fullWidths: [null, null, null, null, null], compactWidth: 24, gap: 4, containerWidth: 264 }), 0);
  });
});
