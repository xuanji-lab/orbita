import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { beltFrame, dustPoints, elevationFor, framePoint, frameViewport, FRAME_EXTENT, galaxyBox, GALAXY_MAX_FILL, layoutGalaxy, makeCamera, orbitFrame, type GalaxySpec } from "./galaxy.ts";
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

const camera = makeCamera(FRAME_EXTENT, elevationFor(galaxyBox(1400, 760, GALAXY_MAX_FILL)));
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
    const spec: GalaxySpec = { starMass: 620, planets: [], sessions: 450, dustCap: Number.POSITIVE_INFINITY };
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
  const first = moversOf(layoutGalaxy(spec), camera, vp, 0, false, 4)[0];
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

  test("单智能体首页：等你的行星永远在前层", () => {
    const waiting = moversOf(layoutGalaxy({ ...spec, planets: [{ ...planet, state: "waiting" }] }), camera, vp, 0, true, 4)[0];
    assert.ok(waiting !== undefined && waiting.alwaysNear);
    assert.equal(moverFar(waiting, (Math.PI / 2 - waiting.phase) / waiting.omega), false);
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
