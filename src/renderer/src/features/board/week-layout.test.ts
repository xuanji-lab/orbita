import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { localDayStart, type BoardCardSnapshot, type BoardWeekDay, type BoardWeekItem } from "../../../../shared/plugin-board.ts";
import {
  WEEK_CELL_GAP,
  WEEK_CELL_MIN,
  WEEK_DAY_GAP,
  cardCaption,
  clampScroll,
  clockLabel,
  dayColumnWidth,
  dayContent,
  dayPhase,
  fullyVisibleDays,
  layoutWeekColumns,
  mountedDays,
  scrollToTodayLeft,
  shiftWeek,
  todayColumnIndex,
  visibleColumnRange,
  weekCellWidth,
  weekIsBlank,
  weekRangeLabel,
  wheelScrollDelta,
  type DayCells,
} from "./week-layout.ts";

// 2026-11-02 是周一（本地时区；用本地构造器，测试与时区无关）
const MONDAY = new Date(2026, 10, 2).getTime();

function day(i: number, over: Partial<BoardWeekDay> = {}): BoardWeekDay {
  return { start: localDayStart(MONDAY, i), end: localDayStart(MONDAY, i + 1), items: [], planned: [], ...over };
}
function week(): BoardWeekDay[] {
  return Array.from({ length: 7 }, (_, i) => day(i));
}
function snapshot(id: string, size: BoardCardSnapshot["size"], index = 0): BoardCardSnapshot {
  return { id, title: id, size, index, template: "a".repeat(64), data: null, state: "empty", usingSample: false, updatedAt: null };
}
function item(at: number, cards: BoardCardSnapshot[], over: Partial<BoardWeekItem> = {}): BoardWeekItem {
  return {
    at,
    automationId: "au1",
    automationTitle: "文献追踪",
    plugin: "lit-tracker",
    pluginTitle: "文献追踪",
    sessionId: "s1",
    cards,
    runId: `r${at}`,
    status: "success",
    workspaceId: null,
    ...over,
  };
}
const cellsOf = (...values: DayCells[]): DayCells[] => values;
const VIEWPORT = 1100;

describe("weekCellWidth：格宽 = 可视宽 / 所选天数（按每列 1 格算，减天间距）", () => {
  it("3 / 5 / 7 天：越多越窄，天间距从总宽里扣", () => {
    strictEqual(weekCellWidth(1100, 5), Math.floor((1100 - 4 * WEEK_DAY_GAP) / 5));
    strictEqual(weekCellWidth(1100, 3), Math.floor((1100 - 2 * WEEK_DAY_GAP) / 3));
    strictEqual(weekCellWidth(1100, 7), Math.floor((1100 - 6 * WEEK_DAY_GAP) / 7));
    ok(weekCellWidth(1100, 3) > weekCellWidth(1100, 5) && weekCellWidth(1100, 5) > weekCellWidth(1100, 7));
  });
  it("没量到宽度 / 窗口窄到极限：回下限，不抛、不出负数", () => {
    strictEqual(weekCellWidth(0, 5), WEEK_CELL_MIN);
    strictEqual(weekCellWidth(Number.NaN, 5), WEEK_CELL_MIN);
    strictEqual(weekCellWidth(200, 7), WEEK_CELL_MIN);
  });
  it("窗口缩放时格宽跟着变（同一天数，宽度越大格越宽）", () => {
    ok(weekCellWidth(1400, 5) > weekCellWidth(900, 5));
  });
});

describe("layoutWeekColumns：每天一列，1 格或 2 格", () => {
  it("全是 1 格：7 列等宽，总宽 = 7 格 + 6 个天间距", () => {
    const cell = weekCellWidth(VIEWPORT, 5);
    const layout = layoutWeekColumns(cellsOf(1, 1, 1, 1, 1, 1, 1), cell);
    strictEqual(layout.columns.length, 7);
    strictEqual(layout.totalWidth, 7 * cell + 6 * WEEK_DAY_GAP);
    strictEqual(layout.columns[3]?.left, 3 * (cell + WEEK_DAY_GAP));
  });
  it("2 格列 = 两格加中间的格间距；后面的列整体右推", () => {
    const cell = 200;
    const layout = layoutWeekColumns(cellsOf(1, 2, 1, 1, 1, 1, 1), cell);
    strictEqual(layout.columns[1]?.width, dayColumnWidth(cell, 2));
    strictEqual(dayColumnWidth(cell, 2), 2 * cell + WEEK_CELL_GAP);
    strictEqual(layout.columns[2]?.left, cell + WEEK_DAY_GAP + 2 * cell + WEEK_CELL_GAP + WEEK_DAY_GAP);
  });
  it("没有列：总宽 0", () => {
    deepStrictEqual(layoutWeekColumns([], 200), { columns: [], totalWidth: 0 });
  });
});

describe("一屏显示的天数：没有 2 格列 = 所选天数；有 2 格列时更少", () => {
  for (const days of [3, 5, 7] as const) {
    it(`${days} 天 · 全是 1 格：一屏正好 ${days} 天`, () => {
      const layout = layoutWeekColumns(cellsOf(1, 1, 1, 1, 1, 1, 1), weekCellWidth(VIEWPORT, days));
      strictEqual(fullyVisibleDays(layout, 0, VIEWPORT), days);
    });
    it(`${days} 天 · 周一是 2 格列：一屏装下的天数少于 ${days}`, () => {
      const layout = layoutWeekColumns(cellsOf(2, 1, 1, 1, 1, 1, 1), weekCellWidth(VIEWPORT, days));
      ok(fullyVisibleDays(layout, 0, VIEWPORT) < days, `fully=${fullyVisibleDays(layout, 0, VIEWPORT)}`);
    });
  }
  it("5 天 · 两个 2 格列：一屏 3 天（宽度 5 格 + 间距装下 2 个双格列就剩不下第四天）", () => {
    const layout = layoutWeekColumns(cellsOf(2, 2, 1, 1, 1, 1, 1), weekCellWidth(VIEWPORT, 5));
    ok(fullyVisibleDays(layout, 0, VIEWPORT) <= 3);
    ok(fullyVisibleDays(layout, 0, VIEWPORT) >= 2);
  });
});

describe("scrollToTodayLeft：打开时把今天滚进视野", () => {
  const cell = weekCellWidth(VIEWPORT, 5);
  const flat = layoutWeekColumns(cellsOf(1, 1, 1, 1, 1, 1, 1), cell);

  it("今天在周首（周一）：不滚", () => {
    strictEqual(scrollToTodayLeft(flat, VIEWPORT, 0), 0);
  });
  it("今天在可视窗里（5 天档的周四，下标 3）：不滚", () => {
    strictEqual(scrollToTodayLeft(flat, VIEWPORT, 3), 0);
  });
  it("今天在可视窗外：让前一天贴左缘（周六下标 5 → 周五贴左）", () => {
    const left = scrollToTodayLeft(flat, VIEWPORT, 5);
    strictEqual(left, clampScroll(flat.columns[4]?.left ?? 0, flat.totalWidth, VIEWPORT));
    const range = visibleColumnRange(flat, left, VIEWPORT);
    ok(range !== null && range.first <= 5 && range.last >= 5);
  });
  it("edgeInset：多滚这么多，前一天再前一天正好滚出视口；今天在周尾时夹在最大滚动，不受它影响", () => {
    const wide = layoutWeekColumns(cellsOf(1, 1, 1, 1, 1, 1, 1), 300);
    const plain = scrollToTodayLeft(wide, VIEWPORT, 3);
    strictEqual(plain, wide.columns[2]?.left);
    strictEqual(scrollToTodayLeft(wide, VIEWPORT, 3, 8), plain + 8);
    strictEqual(scrollToTodayLeft(flat, VIEWPORT, 6, 8), flat.totalWidth - VIEWPORT);
    strictEqual(scrollToTodayLeft(flat, VIEWPORT, 0, 8), 0);
  });
  it("今天在周尾（周日下标 6）：夹在最大滚动，今天那列整列可见", () => {
    const left = scrollToTodayLeft(flat, VIEWPORT, 6);
    strictEqual(left, flat.totalWidth - VIEWPORT);
    const today = flat.columns[6];
    ok(today !== undefined);
    ok(today.left >= left && today.left + today.width <= left + VIEWPORT + 0.5);
  });
  it("周尾那天是 2 格列：同样整列可见", () => {
    const layout = layoutWeekColumns(cellsOf(1, 1, 1, 1, 1, 1, 2), cell);
    const left = scrollToTodayLeft(layout, VIEWPORT, 6);
    const today = layout.columns[6];
    ok(today !== undefined);
    ok(today.left >= left && today.left + today.width <= left + VIEWPORT + 0.5);
  });
  it("今天不在这一周 / 下标越界：0", () => {
    strictEqual(scrollToTodayLeft(flat, VIEWPORT, null), 0);
    strictEqual(scrollToTodayLeft(flat, VIEWPORT, 9), 0);
  });
  it("3 天档、有 2 格列、今天在周三：前一天贴左，且不越过最大滚动", () => {
    const cell3 = weekCellWidth(VIEWPORT, 3);
    const layout = layoutWeekColumns(cellsOf(1, 2, 2, 1, 1, 1, 1), cell3);
    const left = scrollToTodayLeft(layout, VIEWPORT, 2);
    ok(left <= layout.totalWidth - VIEWPORT);
    const today = layout.columns[2];
    ok(today !== undefined && today.left >= left - 0.5 && today.left + today.width <= left + VIEWPORT + 0.5);
  });
  it("内容比可视窗窄：永远 0", () => {
    const narrow = layoutWeekColumns(cellsOf(1, 1, 1), 100);
    strictEqual(scrollToTodayLeft(narrow, VIEWPORT, 2), 0);
  });
});

describe("clampScroll / visibleColumnRange / mountedDays", () => {
  const layout = layoutWeekColumns(cellsOf(1, 1, 1, 1, 1, 1, 1), weekCellWidth(VIEWPORT, 5));
  it("夹在 [0, 总宽 - 可视宽]；坏值回 0", () => {
    strictEqual(clampScroll(-50, layout.totalWidth, VIEWPORT), 0);
    strictEqual(clampScroll(99999, layout.totalWidth, VIEWPORT), layout.totalWidth - VIEWPORT);
    strictEqual(clampScroll(Number.NaN, layout.totalWidth, VIEWPORT), 0);
  });
  it("可视区间：滚到 0 看到前几列；滚到底看到最后几列", () => {
    const start = visibleColumnRange(layout, 0, VIEWPORT);
    strictEqual(start?.first, 0);
    ok((start?.last ?? 0) >= 4);
    const end = visibleColumnRange(layout, layout.totalWidth - VIEWPORT, VIEWPORT);
    strictEqual(end?.last, 6);
  });
  it("只挂可视的天各外扩一天：周一滚到 0 时挂 0..last+1，不挂最后几天", () => {
    const mounted = mountedDays(layout, 0, VIEWPORT, 1);
    ok(mounted.has(0) && mounted.has(4));
    ok(!mounted.has(6));
  });
  it("没量到可视宽：挂最前面三天，别全挂", () => {
    deepStrictEqual([...mountedDays(layout, 0, 0)], [0, 1, 2]);
  });
});

describe("wheelScrollDelta：Shift + 滚轮变横滑", () => {
  it("没按 Shift：不拦（竖向滚轮照常、触控板横滑本来就带 deltaX）", () => {
    strictEqual(wheelScrollDelta({ deltaX: 0, deltaY: 100, shiftKey: false }), null);
    strictEqual(wheelScrollDelta({ deltaX: 40, deltaY: 0, shiftKey: false }), null);
  });
  it("按了 Shift：deltaY 变横向；系统已换成 deltaX 的取 deltaX", () => {
    strictEqual(wheelScrollDelta({ deltaX: 0, deltaY: 120, shiftKey: true }), 120);
    strictEqual(wheelScrollDelta({ deltaX: -80, deltaY: 0, shiftKey: true }), -80);
    strictEqual(wheelScrollDelta({ deltaX: 5, deltaY: -90, shiftKey: true }), -90);
  });
  it("全零：null", () => {
    strictEqual(wheelScrollDelta({ deltaX: 0, deltaY: 0, shiftKey: true }), null);
  });
});

describe("dayPhase / todayColumnIndex", () => {
  const days = week();
  const wednesdayNoon = localDayStart(MONDAY, 2) + 12 * 3600_000;
  it("过去 / 今天 / 未来按本地 00:00 边界分", () => {
    strictEqual(dayPhase(days[1]!, wednesdayNoon), "past");
    strictEqual(dayPhase(days[2]!, wednesdayNoon), "today");
    strictEqual(dayPhase(days[3]!, wednesdayNoon), "future");
  });
  it("边界：恰在 00:00 属于新的一天", () => {
    strictEqual(dayPhase(days[2]!, days[2]!.start), "today");
    strictEqual(dayPhase(days[1]!, days[2]!.start), "past");
  });
  it("今天是周几；翻到别的周为 null", () => {
    strictEqual(todayColumnIndex(days, wednesdayNoon), 2);
    strictEqual(todayColumnIndex(days, localDayStart(MONDAY, 9)), null);
    strictEqual(todayColumnIndex(days, localDayStart(MONDAY, -3)), null);
  });
});

describe("dayContent：一天里画什么", () => {
  const at = localDayStart(MONDAY, 1) + 8.5 * 3600_000;
  it("有 2 格宽的卡 → 列 2 格；只有 1 格卡 → 1 格", () => {
    const wide = dayContent(day(1, { items: [item(at, [snapshot("a", "1x1"), snapshot("b", "2x2")])] }), "past");
    strictEqual(wide.cells, 2);
    const narrow = dayContent(day(1, { items: [item(at, [snapshot("a", "1x1"), snapshot("c", "1x2")])] }), "past");
    strictEqual(narrow.cells, 1);
  });
  it("卡按运行时间排，key 带运行 id + 卡 id + 序号（repeat 的各项不撞）", () => {
    const content = dayContent(
      day(1, { items: [item(at, [snapshot("p", "1x1", 0), snapshot("p", "1x1", 1)]), item(at + 1000, [snapshot("q", "1x1")])] }),
      "past",
    );
    deepStrictEqual(
      content.cards.map((card) => card.key),
      [`r${at}:p:0`, `r${at}:p:1`, `r${at + 1000}:q:0`],
    );
  });
  it("没卡的运行进 bare，不占卡位", () => {
    const content = dayContent(day(1, { items: [item(at, [])] }), "past");
    strictEqual(content.cards.length, 0);
    strictEqual(content.bare.length, 1);
    strictEqual(content.empty, null);
  });
  it("什么都没有：过去 / 今天写「没运行」，未来写「没排期」", () => {
    strictEqual(dayContent(day(0), "past").empty, "none-ran");
    strictEqual(dayContent(day(2), "today").empty, "none-ran");
    strictEqual(dayContent(day(4), "future").empty, "none-planned");
  });
  it("有排期的未来天不写空话", () => {
    const planned = { at: localDayStart(MONDAY, 4) + 8.5 * 3600_000, automationId: "au1", title: "文献追踪", plugin: "lit-tracker", workspaceId: null };
    const content = dayContent(day(4, { planned: [planned] }), "future");
    strictEqual(content.empty, null);
    strictEqual(content.planned.length, 1);
  });
  it("weekIsBlank：整周没有运行也没有排期", () => {
    strictEqual(weekIsBlank(week()), true);
    strictEqual(weekIsBlank([day(0, { items: [item(at, [])] })]), false);
  });
});

describe("标题与时间", () => {
  it("weekRangeLabel：11/02 – 11/08；跨月 / 跨年也对", () => {
    strictEqual(weekRangeLabel(MONDAY), "11/02 – 11/08");
    strictEqual(weekRangeLabel(new Date(2026, 9, 26).getTime()), "10/26 – 11/01");
    strictEqual(weekRangeLabel(new Date(2026, 11, 28).getTime()), "12/28 – 01/03");
  });
  it("shiftWeek：按日历加减整周，仍落在周一 00:00", () => {
    const next = shiftWeek(MONDAY, 1);
    strictEqual(next, new Date(2026, 10, 9).getTime());
    strictEqual(shiftWeek(next, -1), MONDAY);
    strictEqual(new Date(shiftWeek(MONDAY, -5)).getDay(), 1);
  });
  it("clockLabel 补零；卡的标题行「时间 · 插件名」，没有显示名退到插件名再退到自动化标题", () => {
    strictEqual(clockLabel(new Date(2026, 10, 2, 8, 5).getTime()), "08:05");
    const base = { at: new Date(2026, 10, 2, 8, 30).getTime(), automationTitle: "每日" };
    strictEqual(cardCaption({ ...base, pluginTitle: "文献追踪", plugin: "lit" }), "08:30 · 文献追踪");
    strictEqual(cardCaption({ ...base, pluginTitle: null, plugin: "lit" }), "08:30 · lit");
    strictEqual(cardCaption({ ...base, pluginTitle: null, plugin: null }), "08:30 · 每日");
  });
});
