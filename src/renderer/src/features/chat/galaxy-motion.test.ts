import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { beltFrame, dustPoints, eccentricAnomaly, orbitPoint, ORCH_TILT_DEG, framePoint, frameViewport, FRAME_EXTENT, galaxyBox, GALAXY_MAX_FILL, layoutGalaxy, makeCamera, orbitFrame, type GalaxySpec } from "./galaxy.ts";
import {
  FAR_MARGIN,
  R0,
  applyMatrix,
  captureOffsets,
  dustDiskPoint,
  inverseLinear,
  moverFar,
  moversOf,
  msToNextSide,
  multiply,
  orbitMatrix,
  periodMs,
  rotation,
  spinFrames,
  spinKeyframes,
  keyframeAt,
  KEPLER_FRAMES,
  type Matrix2D,
  type Mover,
} from "./galaxy-motion.ts";

const translate = (x: number, y: number): Matrix2D => ({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

/** 一段关键帧在 t 秒处的角度（线性、无限循环），与 Web Animations 的取值一致 */
function angleAt(frames: { from: number; to: number }, omega: number, tSec: number): number {
  const period = periodMs(omega);
  const progress = ((tSec * 1000) % period) / period;
  return frames.from + (frames.to - frames.from) * progress;
}

const camera = makeCamera(FRAME_EXTENT, ORCH_TILT_DEG);
const vp = frameViewport(camera, 1400, 760, galaxyBox(1400, 760, GALAXY_MAX_FILL));

describe("合成器的那串 transform 正好把星体送到 framePoint（行星永远压在 orbitArcs 画的线上）", () => {
  test("M · R(−θ) · T(R0) · R(+θ) · M⁻¹ 对星体只是平移，平移量 = framePoint(θ)；星体不转、不变形", () => {
    for (const [a, inclination, node] of [[19, 0, 0], [43, 0, 0], [30, 0.12, 1.1]] as const) {
      const frame = orbitFrame(a, inclination, node, camera, vp);
      const m = orbitMatrix(frame);
      const omega = 0.07;
      const phase = 1.3;
      for (const t of [0, 3.7, 40, 123.4]) {
        const out = angleAt(spinFrames(phase, -1), omega, t);
        const back = angleAt(spinFrames(phase, 1), omega, t);
        const chain = [m, rotation(out), translate(R0, 0), rotation(back), inverseLinear(m)].reduce(multiply);
        const expected = framePoint(frame, phase + omega * t);
        assert.ok(Math.abs(chain.e - expected.x) < 1e-6 && Math.abs(chain.f - expected.y) < 1e-6, `a=${a} t=${t}`);
        // 线性部分是单位阵：眼睛朝上，球是圆的
        assert.ok(Math.abs(chain.a - 1) < 1e-9 && Math.abs(chain.d - 1) < 1e-9 && Math.abs(chain.b) < 1e-9 && Math.abs(chain.c) < 1e-9);
      }
    }
  });

  test("碎石带：M · R(−ω·t) · 静止的碎石 = dustPoints（测试里检查碰撞的就是屏幕上真实的位置）", () => {
    const spec: GalaxySpec = { starMass: 620, planets: [], sessions: 450 };
    const belt = layoutGalaxy(spec).belt;
    assert.ok(belt !== null);
    const frame = beltFrame(belt, camera, vp);
    const m = orbitMatrix(frame);
    for (const t of [0, 17, 230]) {
      const spin = angleAt({ from: 0, to: -360 }, belt.omega, t);
      const expected = dustPoints(belt, camera, vp, t);
      belt.particles.slice(0, 40).forEach((particle, i) => {
        const disk = dustDiskPoint(belt, particle.r, particle.theta0);
        const screen = applyMatrix(multiply(m, rotation(spin)), disk.x, disk.y);
        const want = expected[i];
        assert.ok(want !== undefined && Math.abs(screen.x - want.x) < 1e-6 && Math.abs(screen.y - want.y) < 1e-6, `${particle.id} t=${t}`);
      });
    }
  });
});

describe("换层：过了左右两点（再往远侧收 FAR_MARGIN）才从主星背后挪到前面", () => {
  const planet = { id: "x", mass: 4, composition: "rock" as const, orbitRadius: 25, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 0 };
  const spec: GalaxySpec = { starMass: 620, planets: [planet], sessions: 0 };
  const first = moversOf(layoutGalaxy(spec), camera, vp, 0, 4)[0];
  if (first === undefined) throw new Error("没有行星");
  const mover: Mover = first;

  test("θ ∈ (FAR_MARGIN, π − FAR_MARGIN) 才在远层；到点时间算得准（过点前一刻与后一刻层不同）", () => {
    for (const t of [0, 5, 31.4, 77, 200]) {
      const dt: number = msToNextSide(mover, t) / 1000;
      assert.ok(dt > 0 && dt <= periodMs(mover.omega) / 1000);
      assert.notEqual(moverFar(mover, t + dt - 0.01), moverFar(mover, t + dt + 0.01), `t=${t}`);
      assert.equal(moverFar(mover, t + dt * 0.5), moverFar(mover, t), `t=${t}：到点之前不该换`);
    }
    const thetaAt = (theta: number) => (theta - mover.phase) / mover.omega;
    assert.equal(moverFar(mover, thetaAt(Math.PI / 2)), true);
    assert.equal(moverFar(mover, thetaAt(FAR_MARGIN * 0.5)), false);
    assert.equal(moverFar(mover, thetaAt(-Math.PI / 2)), false);
  });

});

describe("捕获的螺线", () => {
  test("从外面、透明开始，落到自己的位置（最后一帧位移为 0、不透明）；一路离圆心越来越近", () => {
    const offsets = captureOffsets(R0, 0);
    const first = offsets[0];
    const last = offsets[offsets.length - 1];
    assert.ok(first !== undefined && last !== undefined);
    assert.equal(first.opacity, 0);
    assert.ok(Math.hypot(R0 + first.dx, first.dy) > R0 * 1.5);
    assert.ok(Math.abs(last.dx) < 1e-9 && Math.abs(last.dy) < 1e-9 && last.opacity === 1);
    let prev = Infinity;
    for (const o of offsets) {
      const r = Math.hypot(R0 + o.dx, o.dy);
      assert.ok(r <= prev + 1e-9);
      prev = r;
    }
  });
});

describe("开普勒椭圆：合成器按平近点角等分的关键帧转，近日点快、远日点慢，一圈的周期不变", () => {
  test("关键帧插值出的角度与开普勒方程的解相差 < 0.2°（e = 0.45 最坏），点永远在椭圆上（= framePoint(E)）", () => {
    for (const ecc of [0.15, 0.3, 0.45]) {
      const frame = orbitFrame(31, 0, 0, camera, vp, ecc);
      const m = orbitMatrix(frame);
      const omega = 0.09;
      const phase = 2.1;
      const out = spinKeyframes(phase, ecc, -1);
      const back = spinKeyframes(phase, ecc, 1);
      assert.equal(out.length, KEPLER_FRAMES + 1);
      let worst = 0;
      for (let t = 0; t < periodMs(omega) / 1000; t += 0.37) {
        const progress = ((t * 1000) % periodMs(omega)) / periodMs(omega);
        const outDeg = keyframeAt(out, progress);
        const backDeg = keyframeAt(back, progress);
        const exact = eccentricAnomaly(phase + omega * t, ecc);
        const err = Math.abs((((backDeg * Math.PI) / 180 - exact + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
        worst = Math.max(worst, err);
        const chain = [m, rotation(outDeg), translate(R0, 0), rotation(backDeg), inverseLinear(m)].reduce(multiply);
        const onCurve = framePoint(frame, (backDeg * Math.PI) / 180);
        assert.ok(Math.abs(chain.e - onCurve.x) < 1e-6 && Math.abs(chain.f - onCurve.y) < 1e-6);
        assert.ok(Math.abs(chain.a - 1) < 1e-9 && Math.abs(chain.d - 1) < 1e-9);
      }
      assert.ok((worst * 180) / Math.PI < 0.2, `e=${ecc} 最大误差 ${((worst * 180) / Math.PI).toFixed(3)}°`);
    }
  });

  test("面积速度恒定：相等时间里扫过的面积（相对主星 = 焦点）相等；近日点那一段比远日点快", () => {
    const ecc = 0.3;
    const a = 30;
    const omega = 0.05;
    const pos = (t: number) => orbitPoint(a, 0, 0, eccentricAnomaly(omega * t, ecc), ecc);
    const period = (Math.PI * 2) / omega;
    const areas: number[] = [];
    const steps = 12;
    for (let k = 0; k < steps; k++) {
      let area = 0;
      for (let i = 0; i < 200; i++) {
        const p = pos(((k + i / 200) * period) / steps);
        const q = pos(((k + (i + 1) / 200) * period) / steps);
        area += (p.x * q.y - q.x * p.y) / 2;
      }
      areas.push(area);
    }
    const mean = areas.reduce((x, y) => x + y, 0) / steps;
    for (const area of areas) assert.ok(Math.abs(area - mean) / mean < 1e-3);
    const speed = (t: number) => Math.hypot(pos(t + 0.01).x - pos(t).x, pos(t + 0.01).y - pos(t).y);
    assert.ok(speed(0) > speed(period / 2) * 1.6, "近日点不比远日点快");
    // 主星在焦点上：近日点距离 a(1 − e)、远日点 a(1 + e)
    assert.ok(Math.abs(Math.hypot(pos(0).x, pos(0).y) - a * (1 - ecc)) < 1e-9);
    assert.ok(Math.abs(Math.hypot(pos(period / 2).x, pos(period / 2).y) - a * (1 + ecc)) < 1e-6);
  });

  test("换层按轨道上的位置（偏近点角）算，到点时间换成平近点角后照样准", () => {
    const planet = { id: "x", mass: 4, composition: "rock" as const, orbitRadius: 25, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 40 };
    const spec: GalaxySpec = { starMass: 620, planets: [planet], sessions: 0, eccentricity: 0.45 };
    const first = moversOf(layoutGalaxy(spec), camera, vp, 0, 4)[0];
    if (first === undefined) throw new Error("没有行星");
    assert.equal(first.ecc, 0.45);
    for (const t of [0, 5, 31.4, 77, 200]) {
      const dt: number = msToNextSide(first, t) / 1000;
      assert.notEqual(moverFar(first, t + dt - 0.01), moverFar(first, t + dt + 0.01), `t=${t}`);
      assert.equal(moverFar(first, t + dt * 0.5), moverFar(first, t));
    }
  });
});
