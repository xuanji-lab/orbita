/**
 * 7 天用量格派生数据的测试（shell/usage-week.ts）。
 *
 * 用固定日期构造（不走系统「现在」）钉死三件事：右端是今天、星期索引对得上、
 * 档位边界恰在 1/3 与 2/3。时区相关断言只涉及「本地日历回退」，构造全用
 * 本地时间的 new Date(y, m, d)，与实现同一口径，不受机器时区影响。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { effectivePin, petAnchor, petLeft, petPrefAfterCellClick, petPrefAfterHide, usageTier, usageWeekCells, weekdayIndex } from "./usage-week.ts";

/** 2026-10-12 是周一：一周七天恰好周一→周日，星期索引最好对 */
const MONDAY = new Date(2026, 9, 12, 15, 30, 0);

describe("usageWeekCells —— 从今天往回数 7 天", () => {
  test("右端是今天，左端是 6 天前；缺的天补 0", () => {
    const cells = usageWeekCells(MONDAY, new Map());
    assert.equal(cells.length, 7);
    assert.deepEqual(
      cells.map((c) => c.date),
      ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12"],
    );
    assert.deepEqual(cells.map((c) => c.isToday), [false, false, false, false, false, false, true]);
    assert.ok(cells.every((c) => c.tokens === 0 && c.tier === 0));
  });

  test("星期索引：0 = 周一 … 6 = 周日（标签表按这个序）", () => {
    const cells = usageWeekCells(MONDAY, new Map());
    assert.deepEqual(
      cells.map((c) => c.weekday),
      [1, 2, 3, 4, 5, 6, 0], // 周一往回一周：从上周二到今天（周一）
    );
    // 周日开头的周（2026-10-11 是周日）：左端是上周一，整周恰好周一→周日
    const sunday = new Date(2026, 9, 11, 23, 0, 0);
    assert.deepEqual(
      usageWeekCells(sunday, new Map()).map((c) => c.weekday),
      [0, 1, 2, 3, 4, 5, 6],
    );
  });

  test("跨月回退按本地日历（10-02 往回一周落在 9 月）", () => {
    const cells = usageWeekCells(new Date(2026, 9, 2, 9, 0, 0), new Map());
    assert.equal(cells[0]?.date, "2026-09-26");
    assert.equal(cells[6]?.date, "2026-10-02");
  });

  test("totals 里只有两天的账，其余天是 0；tier 以 7 天最大值为参照", () => {
    const cells = usageWeekCells(MONDAY, new Map([["2026-10-08", 900], ["2026-10-12", 300]]));
    const byDate = new Map(cells.map((c) => [c.date, c]));
    assert.deepEqual(byDate.get("2026-10-08"), {
      date: "2026-10-08",
      weekday: 3, // 周四
      isToday: false,
      tokens: 900,
      tier: 3,
    });
    // 300 / 900 = 1/3：低档
    assert.equal(byDate.get("2026-10-12")?.tier, 1);
    assert.equal(byDate.get("2026-10-07")?.tokens, 0);
    assert.equal(byDate.get("2026-10-07")?.tier, 0);
  });
});

describe("usageTier —— 档位边界", () => {
  test("0 / 低 / 中 / 高的边界恰在 1/3 与 2/3", () => {
    assert.equal(usageTier(0, 300), 0);
    assert.equal(usageTier(1, 300), 1);
    assert.equal(usageTier(100, 300), 1); // 恰 1/3 是低
    assert.equal(usageTier(101, 300), 2);
    assert.equal(usageTier(200, 300), 2); // 恰 2/3 是中
    assert.equal(usageTier(201, 300), 3);
    assert.equal(usageTier(300, 300), 3);
  });

  test("整周没用量（max=0）：没有参照系，一律 0", () => {
    assert.equal(usageTier(0, 0), 0);
    assert.equal(usageTier(5, 0), 0);
  });
});

describe("杂项", () => {
  test("weekdayIndex 是周一基（周日是 6）", () => {
    assert.equal(weekdayIndex(new Date(2026, 9, 12)), 0); // 周一
    assert.equal(weekdayIndex(new Date(2026, 9, 18)), 6); // 周日
  });

  test("petLeft：云心始终对准格子中心（SVG 宽 80，左缘 = 中心 - 40）", () => {
    assert.equal(petLeft(0) + 40, 12);
    assert.equal(petLeft(3) + 40, 108);
    assert.equal(petLeft(6) + 40, 204); // 今天
  });
});

describe("星云摆放偏好（按日期钉 / 收起）", () => {
  const cells = usageWeekCells(new Date(2026, 9, 12, 15), new Map([["2026-10-08", 5]]));
  // cells[0] = 10-06 … cells[6] = 10-12（今天）

  test("没钉 / 钉的日期滑出窗口 / 钉今天：停在今天", () => {
    assert.equal(petAnchor(cells, undefined), 6);
    assert.equal(petAnchor(cells, { pinnedDate: "2026-09-30" }), 6);
    assert.equal(effectivePin(cells, { pinnedDate: "2026-09-30" }), undefined);
    assert.equal(effectivePin(cells, { pinnedDate: "2026-10-12" }), undefined);
  });

  test("钉的日期还在窗口里：停在那格", () => {
    assert.equal(petAnchor(cells, { pinnedDate: "2026-10-08" }), 2);
    assert.equal(effectivePin(cells, { pinnedDate: "2026-10-08" }), "2026-10-08");
  });

  test("点格子：钉 → 再点同格解钉 → 点今天解钉", () => {
    const pinned = petPrefAfterCellClick(cells, undefined, 2);
    assert.deepEqual(pinned, { pinnedDate: "2026-10-08" });
    assert.deepEqual(petPrefAfterCellClick(cells, pinned, 2), {});
    assert.deepEqual(petPrefAfterCellClick(cells, pinned, 6), {});
    assert.deepEqual(petPrefAfterCellClick(cells, pinned, 4), { pinnedDate: "2026-10-10" });
  });

  test("点星云收起（保留钉的日期）；收起后点格子从那格出来", () => {
    const hidden = petPrefAfterHide({ pinnedDate: "2026-10-08" });
    assert.deepEqual(hidden, { pinnedDate: "2026-10-08", hidden: true });
    assert.deepEqual(petPrefAfterCellClick(cells, hidden, 0), { pinnedDate: "2026-10-06" });
    assert.deepEqual(petPrefAfterCellClick(cells, hidden, 6), {});
  });
});
