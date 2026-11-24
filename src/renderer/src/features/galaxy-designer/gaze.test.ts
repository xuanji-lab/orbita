import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  BLINK_MS,
  blinkingAt,
  eyeOpenness,
  firstMind,
  nextBlinkStart,
  gazeOffset,
  GAZE_REACH_PX,
  lookChance,
  MIND,
  mulberry32,
  personaOf,
  restTilt,
  stepMind,
  tiltTarget,
  type Mind,
} from "./gaze.ts";

const TICK = 50;

interface Trace {
  mode: Mind["mode"][];
  aim: { x: number; y: number }[];
  tilt: number[];
  blink: boolean[];
  daydream: boolean[];
}

/** 一颗天体走 ms 毫秒（每拍 50ms），记下每拍的状态 */
function simulate(key: string, seed: number, ms: number, inside = true): Trace {
  const persona = personaOf(key);
  const rng = mulberry32(seed);
  const mind = firstMind(persona, rng, 0);
  const trace: Trace = { mode: [], aim: [], tilt: [], blink: [], daydream: [] };
  for (let now = 0; now <= ms; now += TICK) {
    stepMind(mind, rng, now, inside);
    trace.mode.push(mind.mode);
    trace.aim.push(mind.aim);
    trace.tilt.push(tiltTarget(mind, { x: 0, y: 0 }, null));
    trace.blink.push(blinkingAt(mind, now));
    trace.daydream.push(mind.daydream);
  }
  return trace;
}

/** 一段 trace 里连续同值的最长拍数 */
function longestRun<T>(values: T[], same: (a: T, b: T) => boolean): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    const prev = values[i - 1];
    const cur = values[i];
    run = i > 0 && prev !== undefined && cur !== undefined && same(prev, cur) ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

describe("眼睛的心思（假随机数播种）", () => {
  test("性格按 id 稳定取：同 id 每次一样；12 颗里初始倾角有左有右、幅度各不相同、好奇心散开", () => {
    assert.deepEqual(personaOf("planet:a"), personaOf("planet:a"));
    const personas = Array.from({ length: 12 }, (_, i) => personaOf(`planet:agent-${i}`));
    const sides = new Set(personas.map((p) => p.firstSide));
    assert.deepEqual([...sides].sort(), [-1, 1], "初始倾角有左有右，不全朝右");
    for (const p of personas) {
      assert.ok(p.tiltAmp >= 7 && p.tiltAmp <= 15);
      assert.ok(Math.abs(p.eyeSkew[0]) <= 2.5 && Math.abs(p.eyeSkew[1]) <= 2.5);
      assert.ok(Math.abs(restTilt(p)) >= 7 && Math.abs(restTilt(p)) <= 15);
    }
    assert.ok(new Set(personas.map((p) => p.tiltAmp.toFixed(1))).size >= 10, "幅度各不相同（12 颗里至多两两撞一次）");
    const c = personas.map((p) => p.curiosity).sort((a, b) => a - b);
    assert.ok((c.at(-1) ?? 0) - (c[0] ?? 0) > 0.3, "好奇心散开");
  });

  test("静息倾角会自己换边：左、（偶尔停在正中）、右都出现，换边间隔 3–8 秒；不看指针时也一样", () => {
    for (const [key, seed] of [["star:ws-1", 1], ["planet:p-2", 2], ["avatar:orbita", 3]] as const) {
      const t = simulate(key, seed, 120_000, false);
      const sides = new Set(t.tilt.map((v) => Math.sign(v)));
      assert.ok(sides.has(-1) && sides.has(1), `${key} 两侧都歪过`);
      assert.ok(sides.has(0), `${key} 在正中停过`);
      // 一侧连续停留不超过 tiltHold.max（+1 拍）
      const longest = longestRun(t.tilt, (a, b) => a === b) * TICK;
      assert.ok(longest <= MIND.tiltHold.max + TICK, `${key} 一侧最长停了 ${longest}ms`);
    }
  });

  test("自顾自时一直有小动作：视线不会超过 2.5 秒不换；发呆 1–2 秒、出现过但不常；会眨眼、偶尔连眨", () => {
    const t = simulate("planet:shy", 11, 300_000, false);
    assert.ok(t.mode.every((m) => m === "idle"), "指针不在窗口里：不看");
    const stillest = longestRun(t.aim, (a, b) => a === b) * TICK;
    assert.ok(stillest <= MIND.hold.max + TICK, `视线最长 ${stillest}ms 没换`);
    const xs = t.aim.map((a) => Math.sign(Math.round(a.x * 10)));
    assert.ok(xs.includes(-1) && xs.includes(1), "左右都瞟过");
    const dreamShare = t.daydream.filter(Boolean).length / t.daydream.length;
    assert.ok(dreamShare > 0.03 && dreamShare < 0.25, `发呆占 ${(dreamShare * 100).toFixed(1)}%`);
    // 眨眼：数一下「睁 → 闭」的次数与连眨（两次闭眼间隔不到 600ms）
    const starts: number[] = [];
    t.blink.forEach((b, i) => {
      if (b && !t.blink[i - 1]) starts.push(i * TICK);
    });
    const perMinute = starts.length / 5;
    assert.ok(perMinute > 8 && perMinute < 30, `每分钟眨 ${perMinute.toFixed(1)} 次`);
    const doubles = starts.filter((s, i) => i > 0 && s - (starts[i - 1] ?? -1e9) < 600).length;
    assert.ok(doubles > 0, "连眨过");
  });

  test("有自己的想法：指针一直在，也不是一直看；好奇的看得多、害羞的看得少；看完接着移开，不在原处停住", () => {
    // 找一颗好奇的、一颗害羞的
    const keys = Array.from({ length: 40 }, (_, i) => `planet:k${i}`);
    const byCuriosity = [...keys].sort((a, b) => personaOf(a).curiosity - personaOf(b).curiosity);
    const shy = byCuriosity[0] ?? "";
    const curious = byCuriosity.at(-1) ?? "";
    const share = (key: string) => {
      const t = simulate(key, 5, 600_000, true);
      return t.mode.filter((m) => m === "look").length / t.mode.length;
    };
    const shyShare = share(shy);
    const curiousShare = share(curious);
    assert.ok(shyShare > 0.04 && shyShare < 0.35, `害羞的看指针占 ${(shyShare * 100).toFixed(1)}%`);
    assert.ok(curiousShare > shyShare + 0.15 && curiousShare < 0.8, `好奇的看指针占 ${(curiousShare * 100).toFixed(1)}%`);
    assert.ok(lookChance(personaOf(curious)) > lookChance(personaOf(shy)));
    // 看完那一拍：转成 idle，而且视线瞟到了别处（|x| ≥ 0.6），不是回正中停住
    const rng = mulberry32(8);
    const mind = firstMind(personaOf(curious), rng, 0);
    let leaves = 0;
    for (let now = 0; now < 600_000; now += TICK) {
      const before = mind.mode;
      stepMind(mind, rng, now, true);
      if (before === "look" && mind.mode === "idle") {
        leaves += 1;
        assert.ok(Math.abs(mind.aim.x) >= 0.6 - 1e-9, `移开时 aim.x = ${mind.aim.x.toFixed(2)}`);
        assert.equal(mind.daydream, false);
      }
    }
    assert.ok(leaves > 20);
  });

  test("看指针有长有短：瞟一眼（0.5–1.2 秒）与盯一阵（1.5–4.5 秒）都有", () => {
    const t = simulate("planet:mid", 21, 600_000, true);
    const runs: number[] = [];
    let run = 0;
    for (const m of t.mode) {
      if (m === "look") run += 1;
      else if (run > 0) {
        runs.push(run * TICK);
        run = 0;
      }
    }
    assert.ok(runs.some((ms) => ms <= MIND.glanceAtPointer.max + TICK), "瞟一眼");
    assert.ok(runs.some((ms) => ms >= MIND.stare.min), "盯一阵");
    for (const ms of runs) assert.ok(ms <= MIND.stare.max + TICK, `看了 ${ms}ms`);
  });

  test("各天体错开：12 颗的第一段时长散开，不齐刷刷一起动", () => {
    const firsts = Array.from({ length: 12 }, (_, i) => firstMind(personaOf(`p${i}`), mulberry32(1000 + i), 0).until);
    for (const ms of firsts) assert.ok(ms >= 0 && ms <= MIND.firstMax);
    const sorted = [...firsts].sort((a, b) => a - b);
    assert.ok((sorted.at(-1) ?? 0) - (sorted[0] ?? 0) > 1200);
  });

  test("看指针时：视线朝指针、头往指针那边歪；不看时回到「当前」那一侧的静息倾角", () => {
    const persona = { ...personaOf("x"), tiltAmp: 10 };
    const look = { mode: "look" as const, aim: { x: 0, y: 0 }, tiltSide: -1 as const, persona };
    assert.deepEqual(gazeOffset(look, { x: 100, y: 100 }, { x: 100 + GAZE_REACH_PX * 3, y: 100 }), { x: 1, y: 0 });
    const near = gazeOffset(look, { x: 0, y: 0 }, { x: 0, y: -GAZE_REACH_PX / 4 });
    assert.ok(Math.abs(near.y + 0.25) < 1e-9 && Math.abs(near.x) < 1e-9);
    assert.equal(tiltTarget(look, { x: 0, y: 0 }, { x: GAZE_REACH_PX * 2, y: 0 }), 10);
    assert.equal(tiltTarget(look, { x: 0, y: 0 }, { x: -GAZE_REACH_PX * 2, y: 0 }), -10);
    const idle = { ...look, mode: "idle" as const, aim: { x: -0.3, y: 0.5 } };
    assert.deepEqual(gazeOffset(idle, { x: 0, y: 0 }, { x: 999, y: 0 }), { x: -0.3, y: 0.5 });
    assert.equal(tiltTarget(idle, { x: 0, y: 0 }, { x: 999, y: 0 }), -10, "当前在左就回左，不是固定回右");
    // 位移永远在单位圆里
    const rng = mulberry32(9);
    const mind = firstMind(personaOf("y"), rng, 0);
    for (let now = 0; now < 120_000; now += TICK) {
      stepMind(mind, rng, now, true);
      const o = gazeOffset(mind, { x: 0, y: 0 }, { x: rng() * 800 - 400, y: rng() * 800 - 400 });
      assert.ok(Math.hypot(o.x, o.y) <= 1 + 1e-9);
    }
  });

  test("眨眼按拍取样：合 → 闭 → 张，中点最闭；不用 CSS 动画（SVG 上的 CSS 动画每帧都要主线程出帧）", () => {
    const mind = { blinks: [1000], nextBlink: 5000 };
    const samples = [1000, 1050, 1100, 1150, 1200].map((t) => Number(eyeOpenness(mind, t).toFixed(2)));
    assert.deepEqual(samples, [1, 0.55, 0.1, 0.55, 1]);
    assert.equal(eyeOpenness(mind, 900), 1);
    assert.equal(nextBlinkStart(mind, 0), 1000);
    assert.equal(nextBlinkStart(mind, 1100), 5000);
    assert.ok(BLINK_MS <= 220);
    const css = readFileSync(new URL("./galaxy-designer.css", import.meta.url), "utf8");
    assert.doesNotMatch(css, /gd-blink/);
  });

  test("按拍走、不用 CSS 过渡：位移一拍走一半，倾角慢一些（源码级）", () => {
    const source = readFileSync(new URL("./gaze-runtime.ts", import.meta.url), "utf8");
    assert.match(source, /const GAZE_TICK_MS = 50;/);
    assert.match(source, /const EASE_SHARE = 0\.5;/);
    assert.match(source, /const TILT_SHARE = 0\.18;/);
    const css = readFileSync(new URL("./galaxy-designer.css", import.meta.url), "utf8");
    assert.doesNotMatch(css, /\.gd-gaze \{[^}]*transition/);
  });

  test("减少动效 / 失焦 / 隐藏 / 离电省电时停下，回静止姿势（正视、按性格歪向初始一侧）；只写 CSS transform（源码级）", () => {
    const source = readFileSync(new URL("./gaze-runtime.ts", import.meta.url), "utf8");
    assert.match(source, /prefers-reduced-motion: reduce/);
    assert.match(source, /function active\(\): boolean \{\s*return document\.visibilityState === "visible" && document\.hasFocus\(\) && !reduced\(\) && !suspended;/);
    assert.match(source, /export function setGazeSuspended\(value: boolean\): void \{[\s\S]*?if \(value\) \{\s*stop\(\);\s*resetAll\(\);/);
    assert.match(source, /if \(!active\(\)\) \{\s*resetAll\(\);/);
    assert.match(source, /entry\.cur = \{ x: 0, y: 0, tilt: restTilt\(entry\.brain\.persona\) \};/);
    assert.match(source, /entry\.eyes\.style\.transform =/);
    assert.doesNotMatch(source, /setAttribute\("transform"/);
  });
});
