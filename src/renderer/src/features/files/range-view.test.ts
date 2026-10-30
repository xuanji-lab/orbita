/**
 * 分段预览的纯视图函数（`range-view.ts`）：日志判定、滚动位置 ↔ 行号（含行块上方的
 * 提示带 + 内边距）、能浏览多少行、取窗起点、缓存进出。这些算式错了不会崩，只会
 * 「滚到中间是别处的行」「结尾差几行」或「露白」——肉眼很难发现，所以逐条钉住。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  RANGE_WINDOW_CACHE,
  RANGE_WINDOW_STEP,
  findCachedWindow,
  isLogLikeName,
  lineAtScroll,
  maxBrowsableLines,
  rememberWindow,
  middleLine,
  scrollTopForLine,
  visibleLineCount,
  windowCovers,
  windowStartFor,
  type CachedWindow,
} from "./range-view.ts";

describe("isLogLikeName —— 按 .log 扩展名，不按名字里有没有 log 四个字母", () => {
  test(".log（大小写不敏感）与轮转出来的 .log.1 / .log.日期 算日志", () => {
    for (const name of [
      "main.log",
      "build.LOG",
      "npm-debug.log",
      ".log",
      "app.log.1",
      "app.log.12",
      "server.log.2026-10-30",
      "/Users/me/Library/Logs/orbita/main.log",
    ]) {
      assert.equal(isLogLikeName(name), true, name);
    }
  });

  test("名字里碰巧带 log 的不算：changelog / dialog / catalog / login / blog", () => {
    // 原来是 /log/i：这些全中，默认被扔到文件末尾，用户以为文件被截了
    for (const name of [
      "CHANGELOG.md",
      "changelog.txt",
      "dialog.txt",
      "catalog.csv",
      "login.py",
      "blog-export.json",
      "server-log.txt",
      "Logfile",
      "log",
      "logs",
    ]) {
      assert.equal(isLogLikeName(name), false, name);
    }
  });

  test("普通文本 / 代码 / 数据文件不算；.log 之后跟压缩后缀的也不算（那是二进制）", () => {
    for (const name of ["notes.md", "data.csv", "app.ts", "README", "image.png", "app.log.gz", "app.logx", "app.log.bak.zip"]) {
      assert.equal(isLogLikeName(name), false, name);
    }
  });
});

describe("middleLine —— 50%", () => {
  test("中间一屏居中：全文中点落在视口正中", () => {
    assert.equal(middleLine(1000, 20), 490);
    assert.equal(middleLine(1_200_001, 31), 600_000 - 15);
  });

  test("短文件：夹到 0，不出现负行号", () => {
    assert.equal(middleLine(5, 20), 0);
    assert.equal(middleLine(0, 20), 0);
  });

  test("跳转后的首行与跳转目标一致（显式取窗的参数由这几个纯函数算出）", () => {
    // 真机量到的行高 18.59375 px；跳转设完 scrollTop 后还要自己算一次首行，
    // 不能只等 scroll 事件（真机上程序化滚动不一定派发它）。行块上方有提示带 + 内边距（contentTop）
    const rowHeight = 18.59375;
    for (const contentTop of [0, 114, 126.5]) {
      for (const total of [300, 1_120_000, 1_800_000]) {
        const line = middleLine(total, 34);
        const scrollTop = scrollTopForLine(line, rowHeight, contentTop);
        assert.equal(lineAtScroll(scrollTop, rowHeight, contentTop), line, `${total} / ${contentTop}`);
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

  test("行块上方有提示带 + 内边距：扣掉 contentTop 再算（原来没扣，「结尾」差 5 行才到底）", () => {
    // 114 px / 18.59 ≈ 6.1 行：不扣的话滚到第 N 行会被认成第 N + 6 行
    assert.equal(lineAtScroll(114 + 18.6 * 100, 18.6, 114), 100);
    assert.equal(lineAtScroll(114 + 18.6 * 100 + 18.5, 18.6, 114), 100);
    // 还在提示带里（还没滚到行块）：第 0 行
    assert.equal(lineAtScroll(60, 18.6, 114), 0);
  });

  test("scrollTopForLine 与 lineAtScroll 互逆", () => {
    assert.equal(scrollTopForLine(0, 18.6, 114), 114);
    assert.ok(Math.abs(scrollTopForLine(100, 18.6, 114) - (114 + 1860)) < 1e-9);
    for (const line of [0, 1, 999, 1_000_000]) {
      assert.equal(lineAtScroll(scrollTopForLine(line, 18.59375, 126), 18.59375, 126), line);
    }
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

describe("maxBrowsableLines —— 运行时量出的滚动高度上限 ÷ 行高", () => {
  const rowHeight = 18.59375;

  test("Mac 实测 16,777,216 px：约 90 万行（原来写死 33.5M，放行到 180 万行，后一半滚不到）", () => {
    const max = maxBrowsableLines(16_777_216, rowHeight);
    assert.ok(max > 900_000 && max < 903_000, `max=${max}`);
    // 上限以内：总高度 + 边距不超过实测上限
    assert.ok(max * rowHeight <= 16_777_216 - 1024); // 至少留 1 KB 给行块上下的内边距与提示带
    // 120 万行超限，80 万行不超
    assert.ok(1_200_000 > max);
    assert.ok(800_000 < max);
  });

  test("页面放大两档（DPR × 1.2²）上限变小，缩小则变大：同一份行数可能从能看变成看不了", () => {
    const base = maxBrowsableLines(16_777_216, rowHeight);
    const zoomedIn = maxBrowsableLines(Math.floor(16_777_216 / 1.44), rowHeight);
    const zoomedOut = maxBrowsableLines(Math.floor(16_777_216 * 2), rowHeight);
    assert.ok(zoomedIn < base && base < zoomedOut);
    assert.ok(Math.abs(zoomedIn / base - 1 / 1.44) < 0.01);
  });

  test("行高被界面字号撑大：同样的上限能看的行数相应变少", () => {
    assert.ok(maxBrowsableLines(16_777_216, 24) < maxBrowsableLines(16_777_216, 18));
  });

  test("没量出行高 / 上限异常：给 0（组件据此不渲染行块），不给 Infinity / 负数", () => {
    assert.equal(maxBrowsableLines(16_777_216, 0), 0);
    assert.equal(maxBrowsableLines(0, 18.6), 0);
    assert.equal(maxBrowsableLines(500, 18.6), 0); // 比边距还小
    assert.equal(maxBrowsableLines(Number.NaN, 18.6), 0);
  });
});
