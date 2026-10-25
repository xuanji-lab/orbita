/**
 * 分段预览的纯视图函数（`range-view.ts`）：日志判定、首屏落点、滚动位置 ↔ 行号、
 * 取窗起点、缓存进出。这些算式错了不会崩，只会「滚到中间是别处的行」或「露白」——
 * 肉眼很难发现，所以逐条钉住。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_VIRTUAL_HEIGHT,
  RANGE_WINDOW_CACHE,
  RANGE_WINDOW_STEP,
  findCachedWindow,
  initialScrollLine,
  isLogLikeName,
  lineAtScroll,
  rememberWindow,
  scrollLineForJump,
  visibleLineCount,
  windowCovers,
  windowStartFor,
  type CachedWindow,
} from "./range-view.ts";

describe("isLogLikeName", () => {
  test(".log 与名字里带 log 的都算（大小写不敏感）", () => {
    for (const name of ["main.log", "build.LOG", "npm-debug.log", "server-log.txt", "Logfile"]) {
      assert.equal(isLogLikeName(name), true, name);
    }
  });

  test("普通文本 / 代码 / 数据文件不算", () => {
    for (const name of ["notes.md", "data.csv", "app.ts", "README", "image.png"]) {
      assert.equal(isLogLikeName(name), false, name);
    }
  });
});

describe("initialScrollLine —— 首屏落点", () => {
  test("日志落在末尾（总行数 - 可见行数）", () => {
    assert.equal(initialScrollLine(1000, 20, true), 980);
  });

  test("非日志落在开头", () => {
    assert.equal(initialScrollLine(1000, 20, false), 0);
  });

  test("文件比一屏短：夹到 0", () => {
    assert.equal(initialScrollLine(10, 20, true), 0);
    assert.equal(initialScrollLine(0, 20, true), 0);
  });
});

describe("scrollLineForJump —— 开头 / 50% / 结尾", () => {
  test("三个出口各落在该在的位置", () => {
    assert.equal(scrollLineForJump(1000, 20, "head"), 0);
    assert.equal(scrollLineForJump(1000, 20, "middle"), 490);
    assert.equal(scrollLineForJump(1000, 20, "tail"), 980);
  });

  test("短文件：50% 与结尾都夹到 0，不出现负行号", () => {
    assert.equal(scrollLineForJump(5, 20, "middle"), 0);
    assert.equal(scrollLineForJump(5, 20, "tail"), 0);
    assert.equal(scrollLineForJump(0, 20, "tail"), 0);
  });

  test("跳转后的首行与跳转目标一致（显式取窗的参数由这两个纯函数算出）", () => {
    // 真机量到的行高 18.59375 px；跳转设完 scrollTop 后还要自己算一次首行，
    // 不能只等 scroll 事件（真机上程序化滚动不一定派发它）
    const rowHeight = 18.59375;
    for (const total of [300, 1_120_000, 1_800_000]) {
      for (const jump of ["head", "middle", "tail"] as const) {
        const line = scrollLineForJump(total, 34, jump);
        assert.equal(lineAtScroll(line * rowHeight, rowHeight), line, `${jump} / ${total}`);
      }
    }
  });
});

describe("lineAtScroll / visibleLineCount —— 滚动映射", () => {
  test("scrollTop 除以行高向下取整", () => {
    assert.equal(lineAtScroll(0, 18.6), 0);
    assert.equal(lineAtScroll(18.6 * 100, 18.6), 100);
    assert.equal(lineAtScroll(18.6 * 100 + 18.5, 18.6), 100);
  });

  test("负的 scrollTop（macOS 回弹）与没量出行高时都给 0", () => {
    assert.equal(lineAtScroll(-200, 18.6), 0);
    assert.equal(lineAtScroll(500, 0), 0);
  });

  test("可见行数向上取整，至少 1 行", () => {
    assert.equal(visibleLineCount(700, 18.6), 38);
    assert.equal(visibleLineCount(0, 18.6), 1);
    assert.equal(visibleLineCount(700, 0), 1);
  });
});

describe("windowStartFor —— 取窗起点", () => {
  const count = 600;
  const overscan = 200;
  const rows = 40;

  test("退 overscan 行后按 step 向下对齐", () => {
    // 1000 - 200 = 800 → 向下对齐到 600
    assert.equal(windowStartFor(1000, 100_000, count, overscan, rows), 600);
    assert.equal(windowStartFor(1000, 100_000, count, overscan, rows) % RANGE_WINDOW_STEP, 0);
  });

  test("靠近文件头：夹到 0", () => {
    assert.equal(windowStartFor(0, 100_000, count, overscan, rows), 0);
    assert.equal(windowStartFor(50, 100_000, count, overscan, rows), 0);
  });

  test("靠近文件尾：夹到「最后一窗」，末尾一定盖得住", () => {
    const start = windowStartFor(99_960, 100_000, count, overscan, rows);
    assert.equal(start, 99_400);
    assert.ok(start + count >= 100_000);
    // 同一位置重复算：结果不变（滚动停下后不会反复换窗）
    assert.equal(windowStartFor(99_960, 100_000, count, overscan, rows), start);
  });

  test("算出来的窗口一定盖住可视区（对齐不能把末尾挤出窗口）", () => {
    for (const first of [0, 1, 299, 300, 451, 999, 10_000, 99_700]) {
      const start = windowStartFor(first, 100_000, count, overscan, rows);
      assert.ok(start <= first, `起点 ${start} 不该在可视区 ${first} 之后`);
      assert.ok(start + count >= first + rows, `窗口 [${start}, ${start + count}) 该盖住第 ${first} 行起的一屏`);
    }
  });

  test("文件比一窗还短：起点 0", () => {
    assert.equal(windowStartFor(0, 300, count, overscan, rows), 0);
    assert.equal(windowStartFor(200, 300, count, overscan, rows), 0);
  });

  test("空文件：0", () => {
    assert.equal(windowStartFor(0, 0, count, overscan, rows), 0);
  });
});

describe("windowCovers / 缓存", () => {
  const win = (start: number, lines: number): CachedWindow => ({
    start,
    lines: Array.from({ length: lines }, (_, i) => `line ${start + i}`),
  });

  test("覆盖判定：整段都要落在窗口里", () => {
    const w = win(600, 600);
    assert.equal(windowCovers(w, 600, 1200), true);
    assert.equal(windowCovers(w, 900, 1200), true);
    assert.equal(windowCovers(w, 599, 700), false);
    assert.equal(windowCovers(w, 900, 1201), false);
    assert.equal(windowCovers(null, 0, 1), false);
  });

  test("缓存按最近使用排：超过上限丢最久没用过的那一窗", () => {
    const cache = new Map<number, CachedWindow>();
    for (let at = 0; at < RANGE_WINDOW_CACHE; at++) rememberWindow(cache, win(at * 600, 600));
    assert.equal(cache.size, RANGE_WINDOW_CACHE);
    rememberWindow(cache, win(RANGE_WINDOW_CACHE * 600, 600));
    assert.equal(cache.size, RANGE_WINDOW_CACHE);
    assert.equal(cache.has(0), false);
    assert.equal(cache.has(RANGE_WINDOW_CACHE * 600), true);
  });

  test("同一窗再放一次只刷新位置，不重复占位", () => {
    const cache = new Map<number, CachedWindow>();
    rememberWindow(cache, win(0, 600));
    rememberWindow(cache, win(0, 600));
    assert.equal(cache.size, 1);
  });

  test("命中缓存：盖得住才回，并把命中的窗提升为最近使用", () => {
    const cache = new Map<number, CachedWindow>();
    rememberWindow(cache, win(0, 600));
    rememberWindow(cache, win(600, 600));

    assert.deepEqual(findCachedWindow(cache, 700, 900)?.start, 600);
    assert.equal(findCachedWindow(cache, 500, 900), null); // 跨两窗，任一窗都盖不住
    // 命中过的 600 现在是最后一个（最近使用）
    assert.deepEqual([...cache.keys()], [0, 600]);
    findCachedWindow(cache, 100, 200);
    assert.deepEqual([...cache.keys()], [600, 0]);
  });
});

describe("MAX_VIRTUAL_HEIGHT", () => {
  test("1.8 M 行 × 默认行高在 Chromium 的滚动高度之内", () => {
    assert.ok(1_800_000 * 18.59375 < MAX_VIRTUAL_HEIGHT);
  });

  test("界面字号撑大行高后可能超限，组件据此给出口", () => {
    assert.ok(1_800_000 * 24 > MAX_VIRTUAL_HEIGHT);
  });
});
