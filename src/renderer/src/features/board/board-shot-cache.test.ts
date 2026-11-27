import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_SHOT_LIMIT,
  boardShotCovering,
  boardShotCovers,
  boardShotFor,
  boardShotGeometrySame,
  boardShotKey,
  boardShotRgba,
  boardShotVariantKey,
  boardShotView,
  boardShots,
  CAPTURE_IDLE_TIMEOUT_MS,
  idleAfter,
  type BoardShot,
  type BoardShotGeometry,
  type BoardShotQuery,
} from "./board-shot-cache.ts";

function shot(cacheKey: string, overrides: Partial<BoardShot> = {}): BoardShot {
  return { bitmap: {} as ImageBitmap, cacheKey, cssTop: 0, cssWidth: 752, cssHeight: 400, ratio: 2, theme: "light", capturedAt: 1_000, ...overrides };
}

function query(overrides: Partial<BoardShotQuery> = {}): BoardShotQuery {
  return { width: 752, top: 0, height: 400, ratio: 2, theme: "light", now: 2_000, ...overrides };
}

function put(value: BoardShot): string {
  const key = boardShotVariantKey(value.cacheKey, value);
  boardShots.set(key, value);
  return key;
}

function geometry(overrides: Partial<BoardShotGeometry> = {}): BoardShotGeometry {
  return { x: 332, y: 104, width: 752, height: 400, view: { top: 0, height: 400 }, scrollTop: 12_000, ...overrides };
}

test("缓存键同时含会话与工具调用，撞 toolCallId 也不互贴", () => {
  assert.notEqual(boardShotKey("session-a", "call-1"), boardShotKey("session-b", "call-1"));
  assert.notEqual(boardShotKey("session-a", "call-1"), boardShotKey("session-a", "call-2"));
  assert.equal(boardShotKey("session-a", "call-1"), "session-a:call-1");
  const key = boardShotKey("same-call", "call");
  const other = boardShotKey("other-call", "call");
  const expected = shot(key);
  const keys = [put(expected), put(shot(other, { cssWidth: 999 }))];
  assert.equal(boardShotFor(key, query()), expected);
  for (const variant of keys) boardShots.delete(variant);
});

test("整块位图要求宽度、DPR、主题对得上且上下盖得住；亚像素抖动可以", () => {
  const key = boardShotKey("fits", "call");
  const expected = shot(key);
  const variant = put(expected);
  assert.equal(boardShotFor(key, query({ width: 753.99, height: 400.99 })), expected);
  assert.equal(boardShotFor(key, query({ ratio: 1 })), undefined);
  assert.equal(boardShotFor(key, query({ theme: "black" })), undefined);
  assert.equal(boardShotCovering(key, query({ width: 754 })), undefined);
  assert.equal(boardShotCovering(key, query({ height: 402 })), undefined);
  boardShots.delete(variant);
});

test("快照不按时间过期；只有时钟倒走的未来图不贴", () => {
  const key = boardShotKey("freshness", "call");
  const expected = shot(key);
  const variant = put(expected);
  assert.equal(boardShotFor(key, query({ now: 1_000 + 365 * 24 * 60 * 60 * 1000 })), expected);
  assert.equal(boardShotFor(key, query({ now: 999 })), undefined);
  boardShots.delete(variant);
});

test("右栏开合的宽窄布局各留一张；稳定宽度精确命中，过渡宽度拿最接近的", () => {
  const key = boardShotKey("variant-test", "call");
  const wide = shot(key, { cssWidth: 840 });
  const narrow = shot(key, { cssWidth: 406 });
  const keys = [put(wide), put(narrow)];
  assert.equal(boardShotFor(key, query({ width: 840 })), wide);
  assert.equal(boardShotFor(key, query({ width: 406 })), narrow);
  // 840 能盖住 600，406 盖不住：不拉伸，贴 840 的那张，右边由外框裁掉
  assert.equal(boardShotFor(key, query({ width: 600 })), wide);
  // 两张都比 1000 窄：取更宽的，右边缺的更少
  assert.equal(boardShotFor(key, query({ width: 1000 })), wide);
  // 两张都盖得住 300：取较窄的，被裁掉的更少
  assert.equal(boardShotFor(key, query({ width: 300 })), narrow);
  for (const variant of keys) boardShots.delete(variant);
});

test("原地展开只留看得见的那一片：贴回同一片；整块图出现后优先整块", () => {
  const key = boardShotKey("expanded", "call");
  const partial = shot(key, { cssTop: 240, cssHeight: 520 });
  const full = shot(key, { cssHeight: 1_100 });
  const keys = [put(partial)];
  assert.equal(boardShotFor(key, query({ top: 240, height: 520 })), partial);
  assert.equal(boardShotFor(key, query({ top: 300, height: 300 })), partial);
  assert.equal(boardShotCovering(key, query({ top: 0, height: 600 })), undefined);
  keys.push(put(full));
  assert.equal(boardShotFor(key, query({ top: 240, height: 520 })), full);
  assert.equal(boardShotFor(key, query({ top: 0, height: 600 })), full);
  for (const variant of keys) boardShots.delete(variant);
});

test("可见区域是看板与滚动容器的交集；顶部被裁、底部被裁与一条边都算对", () => {
  assert.deepEqual(boardShotView({ top: 104, height: 400 }, { top: 52, bottom: 722 }), { top: 0, height: 400 });
  assert.deepEqual(boardShotView({ top: -200, height: 1_100 }, { top: 52, bottom: 722 }), { top: 252, height: 670 });
  assert.deepEqual(boardShotView({ top: 600, height: 500 }, { top: 52, bottom: 722 }), { top: 0, height: 122 });
  assert.equal(boardShotView({ top: 700, height: 500 }, { top: 52, bottom: 722 }), null);
  assert.equal(boardShotView({ top: -900, height: 500 }, { top: 52, bottom: 722 }), null);
});

test("一片至少覆盖到可见区域底边；顶部和底部各留 1px 亚像素余量", () => {
  assert.equal(boardShotCovers({ cssTop: 0, cssHeight: 400 }, { top: 0, height: 400 }), true);
  assert.equal(boardShotCovers({ cssTop: 100.9, cssHeight: 400 }, { top: 100, height: 400.9 }), true);
  assert.equal(boardShotCovers({ cssTop: 102, cssHeight: 400 }, { top: 100, height: 400 }), false);
  assert.equal(boardShotCovers({ cssTop: 0, cssHeight: 397 }, { top: 0, height: 400 }), false);
});

test("留图前后任一几何变化都判不稳定；亚像素抖动与相同滚动位置通过", () => {
  const base = geometry();
  assert.equal(boardShotGeometrySame(base, geometry({ x: 332.4, y: 103.6, width: 752.4, height: 400.4, scrollTop: 12_000.4, view: { top: 0.4, height: 400.4 } })), true);
  for (const changed of [
    geometry({ x: 333 }),
    geometry({ y: 105 }),
    geometry({ width: 753 }),
    geometry({ height: 401 }),
    geometry({ scrollTop: 12_001 }),
    geometry({ view: { top: 1, height: 400 } }),
    geometry({ view: { top: 0, height: 401 } }),
  ]) {
    assert.equal(boardShotGeometrySame(base, changed), false);
  }
});

test("LRU 只留最近 8 张，最久没用的先淘汰", () => {
  const keys: string[] = [];
  for (let i = 0; i < BOARD_SHOT_LIMIT + 1; i += 1) {
    keys.push(put(shot(boardShotKey(`shot-test-${i}`, "call"))));
  }
  assert.equal(boardShots.size, BOARD_SHOT_LIMIT);
  assert.equal(boardShots.get(keys[0] ?? ""), undefined);
  assert.ok(boardShots.get(keys.at(-1) ?? "") !== undefined);
  for (const key of keys) boardShots.delete(key);
});

test("预取过的布局再来时已被盖住（不再取帧）；换宽度 / 主题 / DPR / 那一片就要重新留", () => {
  const key = boardShotKey("prefetch", "call");
  const variant = put(shot(key));
  // 切走前在空闲时留过这一张：同一布局再走到留图逻辑时 covering 命中，直接跳过，不发 board:shot
  assert.notEqual(boardShotCovering(key, query()), undefined);
  // 布局一变就不算盖住：右栏开合改宽、换主题、换屏幕 DPR、原地展开后看到的是另一片
  for (const changed of [query({ width: 600 }), query({ theme: "black" }), query({ ratio: 1.5 }), query({ top: 300, height: 400 })]) {
    assert.equal(boardShotCovering(key, changed), undefined, JSON.stringify(changed));
  }
  boardShots.delete(variant);
});

test("BGRA 原始像素就地换成 RGBA；对齐与不对齐的视图结果一样", () => {
  const bgra = [10, 20, 30, 255, 200, 100, 0, 128];
  const aligned = boardShotRgba(new Uint8Array(bgra), 2, 1);
  assert.deepEqual(aligned === null ? null : [...aligned], [30, 20, 10, 255, 0, 100, 200, 128]);
  const backing = new Uint8Array(1 + bgra.length);
  backing.set(bgra, 1);
  const unaligned = boardShotRgba(new Uint8Array(backing.buffer, 1, bgra.length), 2, 1);
  assert.deepEqual(unaligned === null ? null : [...unaligned], [30, 20, 10, 255, 0, 100, 200, 128]);
});

test("像素长度与宽高对不上、宽高不是正整数都拒绝：不贴错位或局部的图", () => {
  assert.equal(boardShotRgba(new Uint8Array(4 * 4), 2, 1), null);
  assert.equal(boardShotRgba(new Uint8Array(4 * 2), 2, 2), null);
  assert.equal(boardShotRgba(new Uint8Array(0), 0, 0), null);
  assert.equal(boardShotRgba(new Uint8Array(4 * 2), 1.5, 1), null);
});

/** 手动推进的假计时器：记下排了哪些计时 / 空闲回调，按需触发 */
function fakeScheduler(withIdle = true) {
  const timers = new Map<number, () => void>();
  const idles = new Map<number, { run: () => void; timeout: number }>();
  let next = 1;
  const scheduler = {
    setTimeout: (run: () => void) => { const id = next++; timers.set(id, run); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    requestIdle: withIdle ? (run: () => void, timeout: number) => { const id = next++; idles.set(id, { run, timeout }); return id; } : undefined,
    cancelIdle: (id: number) => { idles.delete(id); },
  };
  const fireTimers = () => { for (const [id, run] of [...timers]) { timers.delete(id); run(); } };
  const fireIdles = () => { for (const [id, item] of [...idles]) { idles.delete(id); item.run(); } };
  return { scheduler, timers, idles, fireTimers, fireIdles };
}

test("留图推迟到点之后的空闲时刻：到点只排进空闲队列，空闲了才截", () => {
  const fake = fakeScheduler();
  let runs = 0;
  idleAfter(fake.scheduler, 600, () => { runs += 1; });
  assert.equal(runs, 0);
  fake.fireTimers();
  assert.equal(runs, 0, "到点还不截，等空闲");
  assert.equal([...fake.idles.values()][0]?.timeout, CAPTURE_IDLE_TIMEOUT_MS);
  fake.fireIdles();
  assert.equal(runs, 1);
});

test("切走（卸载）时取消：计时中、已排进空闲队列的都撤掉，之后一次也不截", () => {
  const early = fakeScheduler();
  let runs = 0;
  idleAfter(early.scheduler, 600, () => { runs += 1; })();
  assert.equal(early.timers.size, 0);
  early.fireTimers();
  early.fireIdles();
  const queued = fakeScheduler();
  const cancel = idleAfter(queued.scheduler, 600, () => { runs += 1; });
  queued.fireTimers();
  assert.equal(queued.idles.size, 1);
  cancel();
  assert.equal(queued.idles.size, 0);
  queued.fireIdles();
  assert.equal(runs, 0);
});

test("没有 requestIdleCallback 的环境到点直接截", () => {
  const fake = fakeScheduler(false);
  let runs = 0;
  idleAfter(fake.scheduler, 400, () => { runs += 1; });
  fake.fireTimers();
  assert.equal(runs, 1);
});
