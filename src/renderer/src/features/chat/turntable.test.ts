import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { AGENT_READABLE_MAX, GALAXY_MAX_FILL, clampZoom, framePoint, galaxyBox, orbitFrame, USER_VIEW_DEFAULT, withUserView, zoomAt, type GalaxySpec } from "./galaxy.ts";
import { GALAXY_ZOOM, parseSettings } from "../../../../shared/settings.ts";
import { moversOf } from "./galaxy-motion.ts";
import { fitScreenSafe } from "./screen-safe.ts";
import { liveProjection, type FrozenScene } from "./turntable.ts";

/** 意图系统的样子：主星 60 M⊕、三颗子智能体、两块在做事的碎石、几百条会话 */
const SPEC: GalaxySpec = {
  starMass: 600,
  sessions: 435,
  eccentricity: 0.3,
  planets: [
    { id: "a0", mass: 22, composition: "rock", orbitRadius: 19, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 30, state: null },
    { id: "a1", mass: 30, composition: "rock", orbitRadius: 31, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 150, state: null },
    { id: "a2", mass: 16, composition: "ice", orbitRadius: 43, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 260, state: null },
  ],
  rocks: [
    { id: "s0", state: "running", label: "会话 0" },
    { id: "s1", state: "waiting", label: "会话 1" },
  ],
};

function frozenAt(w: number, h: number, tilt: number, azimuth: number): FrozenScene {
  const box = galaxyBox(w, h, GALAXY_MAX_FILL);
  const scene = fitScreenSafe(SPEC, w, h, box, tilt, AGENT_READABLE_MAX, azimuth);
  return { camera: scene.camera, viewport: scene.viewport, layout: scene.layout, width: w, height: h, box };
}

describe("转台拖动中只重新投影（不跑屏幕安全布局）", () => {
  test("turntable.ts 不 import 屏幕安全布局：拖动的每一帧调不到 fitScreenSafe", () => {
    const source = readFileSync(new URL("./turntable.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /from "\.\/screen-safe|fitScreenSafe\(|placeAt\(/);
    // HomeGalaxy 里拖动那条路径（useTurntable / applyProjection）也不调它；唯一的调用在 scene 的 useMemo 里（按设置的角度）
    const view = readFileSync(new URL("./HomeGalaxy.tsx", import.meta.url), "utf8");
    assert.equal(view.match(/fitScreenSafe\(/g)?.length, 1);
    const hook = view.slice(view.indexOf("function applyProjection"), view.indexOf("function useGalaxyMotion"));
    assert.ok(hook.length > 1000, "找到拖动那一段");
    assert.doesNotMatch(hook, /fitScreenSafe/);
  });

  test("角度不变时，重新投影与屏幕安全布局给的视口、轨道矩阵相同（到 1e-9，落位时不跳）", () => {
    const close = (a: Record<string, number> | null | undefined, b: Record<string, number> | null | undefined, what: string) => {
      assert.ok(a !== null && a !== undefined && b !== null && b !== undefined, what);
      for (const key of Object.keys(b)) assert.ok(Math.abs((a[key] ?? Number.NaN) - (b[key] ?? 0)) <= 1e-9 * Math.max(1, Math.abs(b[key] ?? 0)), `${what} ${key}: ${a[key]} ≠ ${b[key]}`);
    };
    for (const [w, h] of [[1040, 722], [1000, 330], [440, 344], [336, 269]] as const) {
      for (const [tilt, azimuth] of [[40, 0], [25, 120], [55, 300]] as const) {
        const frozen = frozenAt(w, h, tilt, azimuth);
        const elevation = (frozen.camera.elevation * 180) / Math.PI;
        const live = liveProjection(frozen, elevation, azimuth);
        close({ ...live.viewport }, { ...frozen.viewport }, `${w}×${h} ${tilt}° · ${azimuth}°`);
        const movers = moversOf(frozen.layout, frozen.camera, frozen.viewport, 10, 4);
        for (const mover of movers) {
          const frame = mover.kind === "rock" ? live.rock : live.planets.get(mover.id);
          close(frame === null || frame === undefined ? null : { ...frame }, { ...mover.frame }, mover.id);
        }
        assert.deepEqual(live.far, movers[0]?.far);
      }
    }
  });

  test("连续：俯角 / 方位角每变 0.3°，行星在屏幕上只挪一点点（没有跳档）", () => {
    const frozen = frozenAt(1040, 722, 40, 0);
    const at = (tilt: number, azimuth: number) => {
      const live = liveProjection(frozen, tilt, azimuth);
      const frame = live.planets.get("a2");
      assert.ok(frame !== undefined);
      return framePoint(frame, 1.1);
    };
    let worst = 0;
    for (let k = 0; k < 120; k++) {
      const a = at(40 + (k % 20) * 0.3, k * 3);
      const b = at(40 + (k % 20) * 0.3 + 0.3, k * 3 + 0.3);
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
    }
    assert.ok(worst < 6, `0.3° 最多挪 ${worst.toFixed(2)}px`);
    assert.ok(worst > 0.05, "角度变了画面要跟着变");
  });

  test("方位角转一圈回到原处；正圆轨道转方位角只差相位（屏幕上是同一个椭圆）", () => {
    const frozen = frozenAt(1040, 722, 40, 0);
    assert.deepEqual(liveProjection(frozen, 40, 360).viewport.focal.toFixed(6), liveProjection(frozen, 40, 0).viewport.focal.toFixed(6));
    const round = { ...frozen, layout: { ...frozen.layout, ecc: 0 } };
    const a = liveProjection(round, 40, 0);
    const b = liveProjection(round, 40, 77);
    const fa = orbitFrame(31, 0, 0, a.camera, a.viewport);
    const fb = orbitFrame(31, 0, 0, b.camera, b.viewport);
    // 同一个椭圆：中心相同，两组共轭半径张成同一个椭圆（|m1|² + |m2|² 与 |m1 × m2| 都不变）
    assert.ok(Math.abs(fa.cx - fb.cx) < 1e-6 && Math.abs(fa.cy - fb.cy) < 1e-6);
    const sum = (f: typeof fa) => f.m1x ** 2 + f.m1y ** 2 + f.m2x ** 2 + f.m2y ** 2;
    const cross = (f: typeof fa) => Math.abs(f.m1x * f.m2y - f.m1y * f.m2x);
    assert.ok(Math.abs(sum(fa) - sum(fb)) < 1e-6 * sum(fa));
    assert.ok(Math.abs(cross(fa) - cross(fb)) < 1e-6 * cross(fa));
  });

  test("比例尺与视角无关：屏幕安全布局在任何俯角 / 方位上给的比例尺与主星位置都一样（默认视角定的）", () => {
    for (const [w, h] of [[1040, 722], [1000, 330], [440, 344], [336, 269], [196, 214]] as const) {
      const ref = frozenAt(w, h, 40, 0);
      for (const tilt of [10, 20, 30, 40, 50, 60]) {
        for (const azimuth of [0, 60, 150, 270]) {
          const scene = frozenAt(w, h, tilt, azimuth);
          const k = scene.viewport.focal / ref.viewport.focal;
          assert.ok(Math.abs(k - 1) < 1e-9, `${w}×${h} ${tilt}°·${azimuth}°：比例尺 ×${k.toFixed(4)}`);
          assert.ok(Math.abs(scene.viewport.cx - ref.viewport.cx) < 1e-9 && Math.abs(scene.viewport.cy - ref.viewport.cy) < 1e-9, `${w}×${h} ${tilt}°·${azimuth}°：主星挪了`);
        }
      }
    }
  });

  test("拖动中（重新投影）比例尺与主星位置不变", () => {
    const frozen = frozenAt(1040, 722, 40, 0);
    for (const [tilt, azimuth] of [[10, 0], [60, 90], [25, 300]] as const) {
      const live = liveProjection(frozen, tilt, azimuth);
      assert.equal(live.viewport.focal, frozen.viewport.focal);
      assert.ok(Math.abs(live.star.x - frozen.viewport.cx) < 1e-9 && Math.abs(live.star.y - frozen.viewport.cy) < 1e-9);
    }
  });

  test("快：一帧重新投影远小于一帧的时间（每帧主线程预算 8ms）", () => {
    const frozen = frozenAt(1040, 722, 40, 0);
    const t0 = performance.now();
    const n = 300;
    for (let i = 0; i < n; i++) liveProjection(frozen, 20 + (i % 40), i * 1.7);
    const each = (performance.now() - t0) / n;
    assert.ok(each < 2, `每帧 ${each.toFixed(3)}ms`);
  });
});

describe("滚轮 / 双指缩放", () => {
  test("以指针为中心：指针下的那一点缩放前后在屏幕上不动", () => {
    const frozen = frozenAt(1040, 722, 40, 0);
    const base = frozen.viewport;
    let view = USER_VIEW_DEFAULT;
    for (const [px, py, z] of [[300, 200, 1.6], [800, 500, 2.4], [520, 360, 0.7]] as const) {
      const before = withUserView(base, view);
      // 指针下的世界点（主星所在平面里，按比例尺换算）
      const wx = (px - before.cx) / before.focal;
      const wy = (py - before.cy) / before.focal;
      view = zoomAt(view, base, px, py, z);
      const after = withUserView(base, view);
      assert.ok(Math.abs(after.cx + wx * after.focal - px) < 1e-6 && Math.abs(after.cy + wy * after.focal - py) < 1e-6, `${px},${py} ×${z}`);
    }
  });

  test("缩放夹在 0.5×–3×，存盘两位小数读得回来", () => {
    assert.equal(clampZoom(0.1), GALAXY_ZOOM.min);
    assert.equal(clampZoom(9), GALAXY_ZOOM.max);
    assert.equal(clampZoom(Number.NaN), 1);
    assert.equal(zoomAt(USER_VIEW_DEFAULT, { cx: 0, cy: 0 }, 10, 10, 50).zoom, 3);
    for (const z of [0.5, 0.73, 1, 1.4, 2.95, 3]) {
      const saved = Math.round(clampZoom(z) * 100) / 100;
      assert.equal(parseSettings({ galaxyZoom: saved }).galaxyZoom, saved);
    }
  });

  test("缩放改的只有比例尺与主星位置：屏幕安全布局在缩放后的比例尺上排，比例尺正好是默认的 zoom 倍", () => {
    const ref = frozenAt(1040, 722, 40, 0);
    const box = galaxyBox(1040, 722, GALAXY_MAX_FILL);
    const scene = fitScreenSafe(SPEC, 1040, 722, box, 40, AGENT_READABLE_MAX, 0, { zoom: 1.5, panX: 20, panY: -10 });
    assert.ok(Math.abs(scene.viewport.focal / ref.viewport.focal - 1.5) < 1e-9);
    assert.ok(Math.abs(scene.viewport.cx - ref.viewport.cx - 20) < 1e-9 && Math.abs(scene.viewport.cy - ref.viewport.cy + 10) < 1e-9);
  });
});
