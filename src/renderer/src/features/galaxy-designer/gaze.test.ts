import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { firstGaze, gazeOffset, GAZE_REACH_PX, GAZE_TIMES, LOOK_CHANCE, mulberry32, nextGaze, type GazeState } from "./gaze.ts";

/** 让一台状态机走 n 段，记下每段的模式与时长 */
function run(seed: number, n: number, inside = true): { mode: string; ms: number }[] {
  const rng = mulberry32(seed);
  let now = 0;
  let state: GazeState = firstGaze(rng, now);
  const out: { mode: string; ms: number }[] = [{ mode: "first", ms: state.until - now }];
  for (let i = 0; i < n; i++) {
    now = state.until;
    state = nextGaze(state, rng, now, inside);
    out.push({ mode: state.mode, ms: state.until - now });
  }
  return out;
}

describe("眼睛的注意力（假随机数播种）", () => {
  test("注视 1.5–4 秒、分心 2–6 秒；注视之后一定分心", () => {
    const segs = run(42, 2000);
    for (const seg of segs.slice(1)) {
      if (seg.mode === "look") assert.ok(seg.ms >= GAZE_TIMES.look.min && seg.ms <= GAZE_TIMES.look.max, `注视 ${seg.ms}`);
      else assert.ok(seg.ms >= GAZE_TIMES.away.min && seg.ms <= GAZE_TIMES.away.max, `分心 ${seg.ms}`);
    }
    for (let i = 2; i < segs.length; i++) if (segs[i - 1]?.mode === "look") assert.equal(segs[i]?.mode, "away");
  });

  test("时间分布：注视段约占分心之后的 60%，注视总时长占三成上下（随机，但播种后可复现）", () => {
    const segs = run(7, 5000).slice(1);
    const looks = segs.filter((seg) => seg.mode === "look");
    const lookMs = looks.reduce((sum, seg) => sum + seg.ms, 0);
    const allMs = segs.reduce((sum, seg) => sum + seg.ms, 0);
    // 分心之后去注视的比例 ≈ LOOK_CHANCE
    let afterAway = 0;
    let toLook = 0;
    for (let i = 1; i < segs.length; i++) {
      if (segs[i - 1]?.mode !== "away") continue;
      afterAway += 1;
      if (segs[i]?.mode === "look") toLook += 1;
    }
    assert.ok(Math.abs(toLook / afterAway - LOOK_CHANCE) < 0.03, `分心后去注视 ${(toLook / afterAway).toFixed(3)}`);
    const share = lookMs / allMs;
    assert.ok(share > 0.2 && share < 0.4, `注视时长占 ${(share * 100).toFixed(1)}%`);
    // 平均时长在区间中点附近
    const mean = lookMs / looks.length;
    assert.ok(Math.abs(mean - (GAZE_TIMES.look.min + GAZE_TIMES.look.max) / 2) < 100, `注视平均 ${mean.toFixed(0)}ms`);
  });

  test("各天体错开：12 颗的第一段时长散开在 0–6 秒，不齐刷刷一起转", () => {
    const firsts = Array.from({ length: 12 }, (_, i) => firstGaze(mulberry32(1000 + i), 0).until);
    for (const ms of firsts) assert.ok(ms >= 0 && ms <= GAZE_TIMES.firstAwayMax);
    const sorted = [...firsts].sort((a, b) => a - b);
    assert.ok((sorted.at(-1) ?? 0) - (sorted[0] ?? 0) > 3000, `只散开了 ${((sorted.at(-1) ?? 0) - (sorted[0] ?? 0)).toFixed(0)}ms`);
    assert.equal(new Set(firsts.map((ms) => Math.round(ms))).size, 12);
  });

  test("指针离开窗口：一律分心", () => {
    for (const seg of run(3, 300, false).slice(1)) assert.equal(seg.mode, "away");
  });

  test("注视的方向在屏幕平面里朝着指针，离得远转到底、离得近转得少；分心时看 aim", () => {
    const look: GazeState = { mode: "look", until: 1, aim: { x: 0, y: 0 }, blinkAt: null };
    const far = gazeOffset(look, { x: 100, y: 100 }, { x: 100 + GAZE_REACH_PX * 3, y: 100 });
    assert.deepEqual(far, { x: 1, y: 0 });
    const near = gazeOffset(look, { x: 0, y: 0 }, { x: 0, y: -GAZE_REACH_PX / 4 });
    assert.ok(Math.abs(near.y + 0.25) < 1e-9 && Math.abs(near.x) < 1e-9);
    const away: GazeState = { mode: "away", until: 1, aim: { x: -0.3, y: 0.5 }, blinkAt: null };
    assert.deepEqual(gazeOffset(away, { x: 0, y: 0 }, { x: 999, y: 0 }), { x: -0.3, y: 0.5 });
    // 位移永远在单位圆里（乘最大位移 = 眼宽 × 0.4 之内）
    const rng = mulberry32(9);
    let state: GazeState = firstGaze(rng, 0);
    for (let i = 0; i < 500; i++) {
      state = nextGaze(state, rng, state.until, true);
      const o = gazeOffset(state, { x: 0, y: 0 }, { x: rng() * 800 - 400, y: rng() * 800 - 400 });
      assert.ok(Math.hypot(o.x, o.y) <= 1 + 1e-9);
    }
  });

  test("缓动按拍走、不瞬移：一拍 50ms 走剩下的一半；不用 CSS 过渡（过渡一跑页面每帧都要主线程出帧）（源码级）", () => {
    const source = readFileSync(new URL("./gaze-runtime.ts", import.meta.url), "utf8");
    assert.match(source, /const GAZE_TICK_MS = 50;/);
    assert.match(source, /const EASE_SHARE = 0\.5;/);
    // 走一半：从 0 到 10，三拍走到 8.75，不是一拍到位
    let x = 0;
    for (let i = 0; i < 3; i++) x += (10 - x) * 0.5;
    assert.equal(x, 8.75);
    const css = readFileSync(new URL("./galaxy-designer.css", import.meta.url), "utf8");
    assert.doesNotMatch(css, /\.gd-gaze \{[^}]*transition/);
  });

  test("减少动效 / 失焦 / 隐藏时不动、眼睛回正中；只写 CSS transform（源码级）", () => {
    const source = readFileSync(new URL("./gaze-runtime.ts", import.meta.url), "utf8");
    assert.match(source, /prefers-reduced-motion: reduce/);
    assert.match(source, /function active\(\): boolean \{\s*return document\.visibilityState === "visible" && document\.hasFocus\(\) && !reduced\(\);/);
    // 不活跃时 tick / kick 都先 resetAll（cur 归零、transform 清空）
    assert.match(source, /if \(!active\(\)\) \{\s*resetAll\(\);/);
    assert.match(source, /entry\.eyes\.style\.transform =/);
    assert.doesNotMatch(source, /setAttribute\("transform"/);
  });
});
