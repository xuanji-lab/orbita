import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  angularSpeed,
  CAMERA_ELEVATION_DEG,
  ELEVATION_MAX,
  DENSITY,
  drawFrame,
  beltFrame,
  beltGrowthOf,
  beltOuterOf,
  BELT_FULL_AT,
  BELT_MAX_WIDTH,
  BELT_OVERSHOOT,
  capturedIds,
  dustLookOf,
  dustPoints,
  DUST_CLICK_MAX,
  DEBRIS_PX,
  ROCK_PX,
  emptyHintAt,
  truncateLabel,
  WAITING_SCALE,
  type PlanetItem,
  DUST_CAP,
  EXPECTED_ID,
  FRAME_EXTENT,
  frameViewport,
  GALAXY_MARGIN,
  GALAXY_MAX,
  galaxyFixtureOf,
  galaxySpecOf,
  layoutGalaxy,
  makeCamera,
  MIN_CLEARANCE,
  motionAllowed,
  orbitArcs,
  orbitPoint,
  PLANET_ZONE,
  PLANET_MASS,
  planetRadius,
  project,
  STAR_MASS,
  VISIBLE_ORBIT_CAP,
  starRadius,
  type DrawItem,
  type GalaxySpec,
  type PlanetSpec,
  readablePlanetPx,
  PLANET_READABLE_MAX,
  PLANET_READABLE_MIN,
  PLANET_READABLE_GAP,
  galaxyBox,
  elevationFor,
  GALAXY_MAX_FILL,
} from "./galaxy.ts";
import { ORBIT_STEP } from "./galaxy-data.ts";

function planet(id: string, orbitRadius: number, extra: Partial<PlanetSpec> = {}): PlanetSpec {
  return { id, mass: 4, composition: "rock", orbitRadius, inclinationDeg: 0, nodeDeg: 0, phaseDeg: 0, ...extra };
}

describe("天体规则：主星最大、质量区间不重叠、成分只改密度", () => {
  test("任何行星（最轻密度、最大质量）都明显小于最小的主星", () => {
    assert.ok(PLANET_MASS.max < STAR_MASS.min);
    const biggestPlanet = Math.max(
      ...(["rock", "ice", "gas"] as const).map((composition) => planetRadius({ mass: PLANET_MASS.max, composition })),
    );
    assert.ok(biggestPlanet < starRadius(STAR_MASS.min) * 0.6, `${biggestPlanet} vs ${starRadius(STAR_MASS.min)}`);
  });

  test("同质量下密度越小半径越大；越界质量被夹回区间", () => {
    assert.ok(planetRadius({ mass: 10, composition: "gas" }) > planetRadius({ mass: 10, composition: "rock" }));
    assert.ok(DENSITY.gas < DENSITY.ice && DENSITY.ice < DENSITY.rock);
    assert.equal(planetRadius({ mass: 9999, composition: "gas" }), planetRadius({ mass: PLANET_MASS.max, composition: "gas" }));
    assert.equal(starRadius(1), starRadius(STAR_MASS.min));
  });
});

describe("轨道：半径独立指定、不相撞、开普勒角速度", () => {
  test("给得合规的轨道半径原样保留", () => {
    const layout = layoutGalaxy({ starMass: 600, planets: [planet("a", 20), planet("b", 40)], sessions: 0 });
    assert.deepEqual(layout.planets.map((p) => p.orbitRadius), [20, 40]);
    assert.deepEqual(layout.adjusted, []);
  });

  test("挤在一起 / 贴着主星的轨道被向外推，相邻表面至少留 MIN_CLEARANCE", () => {
    const layout = layoutGalaxy({
      starMass: 600,
      planets: [planet("far", 11, { composition: "gas", mass: 30 }), planet("near", 1), planet("same", 11)],
      sessions: 0,
    });
    assert.deepEqual(layout.planets.map((p) => p.id), ["near", "far", "same"]);
    assert.ok(layout.adjusted.includes("near"));
    const first = layout.planets[0];
    assert.ok(first !== undefined && first.orbitRadius - first.radius - layout.starRadius >= MIN_CLEARANCE - 1e-9);
    for (let i = 1; i < layout.planets.length; i++) {
      const inner = layout.planets[i - 1];
      const outer = layout.planets[i];
      assert.ok(inner !== undefined && outer !== undefined);
      // 半径差 ≥ 两半径之和 + 间距 ⇒ 无论倾角，两条轨道上任意两点都碰不到
      assert.ok(outer.orbitRadius - inner.orbitRadius >= inner.radius + outer.radius + MIN_CLEARANCE - 1e-9);
    }
  });

  test("开普勒第三定律：ω²a³ 为常数，内圈快于外圈", () => {
    const k = (a: number) => angularSpeed(a) ** 2 * a ** 3;
    assert.ok(Math.abs(k(10) - k(80)) / k(10) < 1e-9);
    assert.ok(angularSpeed(15) > angularSpeed(60));
  });
});

describe("量：行星封顶、星屑聚合", () => {
  test("可见轨道最多 6 圈：超出的行星计进 hidden、不画；星屑颗粒封顶 60", () => {
    assert.equal(VISIBLE_ORBIT_CAP, 6);
    assert.equal(DUST_CAP, 60);
    const many: PlanetSpec[] = Array.from({ length: 15 }, (_, i) => planet(`p${i}`, 15 + i * 12));
    const layout = layoutGalaxy({ starMass: 800, planets: many, sessions: 2000 });
    assert.equal(layout.planets.length, VISIBLE_ORBIT_CAP);
    assert.equal(layout.hidden, 15 - VISIBLE_ORBIT_CAP);
    // 留下的是最内的 6 颗
    assert.deepEqual(layout.planets.map((p) => p.id), ["p0", "p1", "p2", "p3", "p4", "p5"]);
    assert.equal(layout.belt?.particles.length, DUST_CAP);
    assert.equal(layout.belt?.count, 2000);
  });

  test("轨道整体超出行星区时按同一比例收进来：相对远近不变，天体半径不缩", () => {
    const wide = layoutGalaxy({ starMass: 600, planets: [planet("a", 40), planet("b", 80), planet("c", 160)], sessions: 0 });
    assert.ok(wide.orbitScale < 1);
    const [a, b, c] = wide.planets;
    assert.ok(a !== undefined && b !== undefined && c !== undefined);
    assert.ok(Math.abs(b.orbitRadius / a.orbitRadius - 2) < 1e-9 && Math.abs(c.orbitRadius / b.orbitRadius - 2) < 1e-9);
    assert.ok(c.orbitRadius + c.radius <= PLANET_ZONE + 1e-9);
    assert.equal(a.radius, planetRadius({ mass: 4, composition: "rock" }));
    const narrow = layoutGalaxy({ starMass: 600, planets: [planet("a", 20)], sessions: 0 });
    assert.equal(narrow.orbitScale, 1);
  });

  test("没有会话就没有碎石带；少量会话一条一粒；量越大越浓但有上限", () => {
    assert.equal(layoutGalaxy({ starMass: 600, planets: [], sessions: 0 }).belt, null);
    assert.equal(layoutGalaxy({ starMass: 600, planets: [], sessions: 5 }).belt?.particles.length, 5);
    const a = layoutGalaxy({ starMass: 600, planets: [], sessions: 10 }).belt?.alpha ?? 0;
    const b = layoutGalaxy({ starMass: 600, planets: [], sessions: 2000 }).belt?.alpha ?? 0;
    const c = layoutGalaxy({ starMass: 600, planets: [], sessions: 200000 }).belt?.alpha ?? 0;
    assert.ok(a < b && b <= c && c <= 0.72);
  });

  test("碎石带在最外的行星轨道之外，不压行星；三档外缘都不超出统一画框", () => {
    const layout = layoutGalaxy(galaxySpecOf("full"));
    const last = layout.planets[layout.planets.length - 1];
    assert.ok(last !== undefined && layout.belt !== null);
    assert.ok(layout.belt.inner > last.orbitRadius + last.radius);
    assert.equal(layout.extent, layout.belt.outer);
    for (const fixture of ["empty", "typical", "full"] as const) {
      assert.ok(layoutGalaxy(galaxySpecOf(fixture)).extent <= FRAME_EXTENT * BELT_OVERSHOOT + 1e-9, fixture);
    }
  });

  test("空星系有一圈预期落位轨道（画得出弧段）；有行星时没有", () => {
    const empty = layoutGalaxy(galaxySpecOf("empty"));
    assert.ok(empty.expectedOrbit !== null && empty.expectedOrbit > empty.starRadius + MIN_CLEARANCE);
    const camera = makeCamera(FRAME_EXTENT);
    const arcs = orbitArcs(empty, camera, frameViewport(camera, 900, 240));
    assert.ok(arcs.length > 0 && arcs.every((arc) => arc.expected && arc.planetId === EXPECTED_ID));
    const typical = layoutGalaxy(galaxySpecOf("typical"));
    assert.equal(typical.expectedOrbit, null);
    assert.ok(orbitArcs(typical, camera, frameViewport(camera, 900, 240)).every((arc) => !arc.expected));
  });
});

describe("透视投影", () => {
  const camera = makeCamera(100);

  test("原点投到正中；近侧（y<0）在下方、离相机更近；左右对称", () => {
    const center = project({ x: 0, y: 0, z: 0 }, camera);
    assert.ok(Math.abs(center.sx) < 1e-12 && Math.abs(center.sy) < 1e-12);
    const near = project({ x: 0, y: -50, z: 0 }, camera);
    const far = project({ x: 0, y: 50, z: 0 }, camera);
    assert.ok(near.sy > 0 && far.sy < 0);
    assert.ok(near.depth < center.depth && center.depth < far.depth);
    const left = project({ x: -40, y: 0, z: 0 }, camera);
    const right = project({ x: 40, y: 0, z: 0 }, camera);
    assert.ok(Math.abs(left.sx + right.sx) < 1e-12);
  });

  test("透视而非压扁：同一圆轨道，近侧投影的半宽大于远侧（不是对称的平面椭圆）", () => {
    const nearEdge = project({ x: 50, y: -50 * 0.01, z: 0 }, camera);
    const nearLeft = project(orbitPoint(50, 0, 0, -Math.PI / 2 - 0.3), camera);
    const farLeft = project(orbitPoint(50, 0, 0, Math.PI / 2 + 0.3), camera);
    assert.ok(nearEdge.sx > 0);
    // 关于 x 轴对称的两点：近的那个离中线更远（放大）、下沉的距离大于远的那个上浮的距离
    assert.ok(Math.abs(nearLeft.sx) > Math.abs(farLeft.sx));
    assert.ok(Math.abs(nearLeft.sy) > Math.abs(farLeft.sy));
  });

  test("倾角让轨道离开主星赤道面", () => {
    const flat = orbitPoint(30, 0, 0, Math.PI / 2);
    const tilted = orbitPoint(30, 5 * (Math.PI / 180), 0, Math.PI / 2);
    assert.equal(flat.z, 0);
    assert.ok(tilted.z > 0);
    assert.ok(Math.abs(Math.hypot(tilted.x, tilted.y, tilted.z) - 30) < 1e-9);
  });

  /** 某块画布上三档的主星（像素半径、圆心），并检查整座星系落在 galaxyBox 里 */
  function starsIn(width: number, height: number) {
    const cam = makeCamera(FRAME_EXTENT);
    const vp = frameViewport(cam, width, height);
    const box = galaxyBox(width, height);
    const boxLeft = (width - box.width) / 2;
    const boxTop = (height - box.height) / 2;
    return (["empty", "typical", "full"] as const).map((fixture) => {
      const layout = layoutGalaxy(galaxySpecOf(fixture));
      const items = drawFrame(layout, cam, vp, orbitArcs(layout, cam, vp), 7);
      // 行星区落在框里；碎石带外沿可以伸进框外的边距（BELT_OVERSHOOT），但不出画布（也就顶不到输入框）
      const planetEdge = layout.planets.reduce((edge, planet) => Math.max(edge, planet.orbitRadius + planet.radius), 0);
      for (let i = 0; i < 72; i++) {
        for (const [a, left, top, right, bottom] of [
          [planetEdge, boxLeft, boxTop, boxLeft + box.width, boxTop + box.height],
          [layout.extent, 0, 0, width, height],
        ] as const) {
          const p = project(orbitPoint(a, 0, 0, (i / 72) * Math.PI * 2), cam);
          const x = vp.cx + vp.focal * p.sx;
          const y = vp.cy + vp.focal * p.sy;
          assert.ok(x >= left - 1 && x <= right + 1, `${width}x${height} ${fixture} a=${a} x ${x}`);
          assert.ok(y >= top - 1 && y <= bottom + 1, `${width}x${height} ${fixture} a=${a} y ${y}`);
        }
      }
      const star = items.find((item) => item.kind === "star");
      assert.ok(star?.kind === "star");
      return star;
    });
  }

  test("响应式统一视口：任一画布尺寸下，三档主星像素半径与圆心完全一致；行星区不越出 galaxyBox、碎石带不出画布", () => {
    for (const [width, height] of [
      [900, 240],
      [1150, 420],
      [712, 300],
      [1900, 900],
    ] as const) {
      const [empty, typical, full] = starsIn(width, height);
      assert.ok(empty !== undefined && typical !== undefined && full !== undefined);
      for (const other of [empty, full]) {
        assert.ok(Math.abs(other.r - typical.r) < 1e-9, `${width}x${height} r`);
        assert.ok(Math.abs(other.x - typical.x) < 1e-9 && Math.abs(other.y - typical.y) < 1e-9, `${width}x${height} c`);
      }
      // 水平居中在画布正中
      assert.ok(Math.abs(typical.x - width / 2) < 1e-6);
    }
  });

  test("主星随画布放大而放大、随画布缩小而缩小；内容多少不影响；巨型画布封顶", () => {
    const small = starsIn(712, 300)[1];
    const medium = starsIn(1150, 420)[1];
    const huge = starsIn(4000, 2000)[1];
    const capped = starsIn(GALAXY_MAX.width + GALAXY_MARGIN * 2 + 600, GALAXY_MAX.height + GALAXY_MARGIN * 2 + 600)[1];
    assert.ok(small !== undefined && medium !== undefined && huge !== undefined && capped !== undefined);
    assert.ok(medium.r > small.r * 1.2, `${small.r} → ${medium.r}`);
    // 超过 GALAXY_MAX 之后不再变大
    assert.ok(Math.abs(huge.r - capped.r) < 1e-9);
    assert.deepEqual(galaxyBox(4000, 2000), { width: GALAXY_MAX.width, height: GALAXY_MAX.height });
    assert.deepEqual(galaxyBox(900, 240), { width: 900 - GALAXY_MARGIN * 2, height: 240 - GALAXY_MARGIN * 2 });
    // 主星始终明显大于最大的行星（同一块画布、同一焦距）
    const layout = layoutGalaxy(galaxySpecOf("full"));
    const biggest = Math.max(...layout.planets.map((p) => p.radius));
    assert.ok(layout.starRadius > biggest * 2);
  });
});

describe("画面上轨道不交叉", () => {
  /** 以主星的投影为原点，沿每个方位角量每一圈轨道投影到画面上的距离；外圈必须处处在内圈之外 */
  function screenRadii(spec: GalaxySpec, elevation = CAMERA_ELEVATION_DEG): number[][] {
    const layout = layoutGalaxy(spec);
    const camera = makeCamera(FRAME_EXTENT, elevation);
    const center = project({ x: 0, y: 0, z: 0 }, camera);
    const bins = 180;
    return layout.planets.map((p) => {
      const best: number[] = new Array<number>(bins).fill(NaN);
      const err: number[] = new Array<number>(bins).fill(Infinity);
      for (let k = 0; k < 4000; k++) {
        const q = project(orbitPoint(p.orbitRadius, p.inclination, p.node, (k / 4000) * Math.PI * 2), camera);
        const dx = q.sx - center.sx;
        const dy = q.sy - center.sy;
        const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2);
        const bin = Math.round((angle / (Math.PI * 2)) * bins) % bins;
        const e = Math.abs(angle - (bin / bins) * Math.PI * 2);
        if (e < (err[bin] ?? Infinity)) {
          err[bin] = e;
          best[bin] = Math.hypot(dx, dy);
        }
      }
      return best;
    });
  }

  test("平常 / 满载 / 倾角给得很大的星系：沿任何方向外圈都在内圈之外", () => {
    const steep: GalaxySpec = {
      starMass: 600,
      planets: [15, 22, 29, 36, 43].map((a, i) => planet(`s${i}`, a, { inclinationDeg: i % 2 === 0 ? 8 : -8, nodeDeg: i * 70 })),
      sessions: 0,
    };
    // 工作区页的画框更「方」时俯角抬到 ELEVATION_MAX：同样一圈套一圈
    for (const elevation of [CAMERA_ELEVATION_DEG, ELEVATION_MAX]) {
      for (const spec of [galaxySpecOf("typical"), galaxySpecOf("full"), steep]) {
        const radii = screenRadii(spec, elevation);
        for (let o = 1; o < radii.length; o++) {
          const inner = radii[o - 1] ?? [];
          const outer = radii[o] ?? [];
          for (let b = 0; b < outer.length; b++) {
            assert.ok((outer[b] ?? 0) > (inner[b] ?? 0), `${elevation}° orbit ${o} bin ${b}`);
          }
        }
      }
    }
  });

  test("俯角随画框形状：扁带子保持 20°，越方越高，封顶 ELEVATION_MAX；单调", () => {
    assert.equal(elevationFor({ width: 1200, height: 240 }), CAMERA_ELEVATION_DEG);
    assert.equal(elevationFor({ width: 800, height: 800 }), ELEVATION_MAX);
    const mid = elevationFor({ width: 1200, height: 640 });
    assert.ok(mid > CAMERA_ELEVATION_DEG && mid < ELEVATION_MAX, String(mid));
    let prev = 0;
    for (let h = 100; h <= 1200; h += 50) {
      const e = elevationFor({ width: 1200, height: h });
      assert.ok(e >= prev);
      prev = e;
    }
  });
});

describe("画框封顶：默认带子 vs 工作区页（fill）", () => {
  test("默认封顶高度 460 与原型一致；fill 放宽到 720、宽度不变；小画布两者相同", () => {
    assert.deepEqual(galaxyBox(4000, 2000), { width: GALAXY_MAX.width, height: 460 });
    assert.deepEqual(galaxyBox(4000, 2000, GALAXY_MAX_FILL), { width: GALAXY_MAX_FILL.width, height: 720 });
    assert.deepEqual(galaxyBox(900, 240, GALAXY_MAX_FILL), galaxyBox(900, 240));
  });
});

describe("等你的行星：前置、放大；名字、碎石与「+N」", () => {
  const camera = makeCamera(FRAME_EXTENT);
  const vp = frameViewport(camera, 1000, 600);
  const spec = (states: (PlanetSpec["state"])[], extra: Partial<GalaxySpec> = {}): GalaxySpec => ({
    starMass: 620,
    planets: states.map((state, i) => planet(`p${i}`, 14 + i * 9, { state, label: `任务 ${i}`, phaseDeg: i * 40 })),
    sessions: 0,
    ...extra,
  });
  const frameAt = (layout: ReturnType<typeof layoutGalaxy>, t: number) => drawFrame(layout, camera, vp, orbitArcs(layout, camera, vp), t);

  test("等你的行星在任何时刻都画在主星之后（盖在主星上），并放大 WAITING_SCALE 倍；别的状态不变", () => {
    const layout = layoutGalaxy(spec(["waiting", "running", null]));
    for (const t of [0, 40, 95, 180, 400]) {
      const items = frameAt(layout, t);
      const starIndex = items.findIndex((item) => item.kind === "star");
      const waiting = items.findIndex((item) => item.kind === "planet" && item.state === "waiting");
      assert.ok(waiting > starIndex, `t=${t}：等你的行星必须在绘制表里排在主星之后`);
    }
    const items = frameAt(layout, 0);
    const byState = (state: string | null) => items.find((item): item is PlanetItem => item.kind === "planet" && item.state === state);
    const plain = frameAt(layoutGalaxy(spec([null, "running", null])), 0).find((item): item is PlanetItem => item.kind === "planet" && item.planetId === "p0");
    assert.ok(Math.abs((byState("waiting")?.r ?? 0) / (plain?.r ?? 1) - WAITING_SCALE) < 1e-6);
  });

  test("轨道与行星一一对应：有几颗行星画几圈，不画空轨道（空星系只有一圈预期虚线）", () => {
    const layout = layoutGalaxy(spec(["waiting", null, null, "running"]));
    const rings = new Set(orbitArcs(layout, camera, vp).map((arc) => arc.planetId));
    assert.deepEqual([...rings].sort(), layout.planets.map((p) => p.id).sort());
    const empty = layoutGalaxy({ starMass: 620, planets: [], sessions: 0 });
    assert.deepEqual([...new Set(orbitArcs(empty, camera, vp).map((arc) => arc.planetId))], [EXPECTED_ID]);
  });

  test("碎石：工作区页每条会话一颗（不封顶）；单智能体原型带子缺省仍封顶 DUST_CAP", () => {
    const all = layoutGalaxy(spec(["running"], { sessions: 2000, dustCap: Number.POSITIVE_INFINITY }));
    assert.equal(all.belt?.particles.length, 2000);
    assert.equal(all.belt?.count, 2000);
    // 根会话拎成的碎石块不再画成碎石带里的一颗；子会话碎石块不在 sessions 里
    const lifted = layoutGalaxy({ ...spec([]), sessions: 10, dustCap: Number.POSITIVE_INFINITY, rocks: [{ id: "a", state: "running", label: "A" }, { id: "b", state: "waiting", label: "B", child: true }] });
    assert.equal(lifted.belt?.particles.length, 9);
    assert.equal(layoutGalaxy(spec([], { sessions: 2000 })).belt?.particles.length, DUST_CAP);
  });

  test("主星带星环 / 日冕时第一圈轨道被推到外缘之外（行星不从星环里穿过）", () => {
    const plain = layoutGalaxy({ starMass: 1000, planets: [planet("a", 12)], sessions: 0 });
    const ringed = layoutGalaxy({ starMass: 1000, planets: [planet("a", 12)], sessions: 0, starExtent: starRadius(1000) * 1.7 });
    const first = ringed.planets[0];
    assert.ok(first !== undefined && first.orbitRadius >= starRadius(1000) * 1.7 + first.radius + MIN_CLEARANCE - 1e-9);
    assert.ok((first?.orbitRadius ?? 0) > (plain.planets[0]?.orbitRadius ?? 0));
    assert.deepEqual(ringed.adjusted, ["a"]);
  });

  test("空星系的提示位置在预期轨道下方；有行星或碎石就不出", () => {
    const empty = layoutGalaxy({ starMass: 620, planets: [], sessions: 0 });
    const at = emptyHintAt(empty, camera, vp);
    assert.ok(at !== null && at.y > vp.cy);
    assert.equal(emptyHintAt(layoutGalaxy(spec(["running"])), camera, vp), null);
    assert.equal(emptyHintAt(layoutGalaxy({ starMass: 620, planets: [], sessions: 3 }), camera, vp), null);
  });

  test("名字截断：短名原样；超过 14 个字截成 13 个字 + 省略号（锁定框引线与悬停名字共用）", () => {
    assert.equal(truncateLabel("短名"), "短名");
    assert.equal([...truncateLabel("一二三四五六七八九十一二三四五六七八")].length, 14);
    assert.ok(truncateLabel("一二三四五六七八九十一二三四五六七八").endsWith("…"));
  });
});

describe("行星表情可读（星系规则：大小差距缩小到行星表情可读，同时主星明显最大）", () => {
  // 与 HomeGalaxy 的工作区页同一套取景：画框按画布形状抬俯角
  const scene = (w: number, h: number) => {
    const box = galaxyBox(w, h, GALAXY_MAX_FILL);
    const camera = makeCamera(FRAME_EXTENT, elevationFor(box));
    return { camera, vp: frameViewport(camera, w, h, box) };
  };
  test("最小可读半径夹在 [MIN, MAX]，且不超过相邻轨道间距的 GAP 倍（窄右栏里放大的行星不压隔壁轨道）", () => {
    for (const [w, h] of [[300, 360], [360, 480], [440, 560], [1000, 600], [1400, 720]] as const) {
      const { camera, vp } = scene(w, h);
      const px = readablePlanetPx(camera, vp, ORBIT_STEP);
      const stepPx = (vp.focal * ORBIT_STEP) / project({ x: 0, y: 0, z: 0 }, camera).depth;
      assert.ok(px >= PLANET_READABLE_MIN && px <= PLANET_READABLE_MAX, `${w}×${h}: ${px}`);
      assert.ok(px <= Math.max(PLANET_READABLE_MIN, PLANET_READABLE_GAP * stepPx) + 1e-9);
    }
  });
  test("三档（空 / 平常 / 满载）、宽窄画布：行星都放大到可读半径以上，主星仍是最大的那颗（≥ 最大行星 1.5 倍，等你放大后也是）", () => {
    for (const fixture of ["empty", "typical", "full"] as const) {
      for (const [w, h] of [[360, 480], [1000, 600]] as const) {
        const { camera, vp } = scene(w, h);
        const layout = layoutGalaxy({ ...galaxySpecOf(fixture), planets: galaxySpecOf(fixture).planets.map((p, i) => (i === 0 ? { ...p, state: "waiting" as const } : p)) });
        const min = readablePlanetPx(camera, vp, ORBIT_STEP);
        const items = drawFrame(layout, camera, vp, orbitArcs(layout, camera, vp), 3.2, min);
        const star = items.find((item) => item.kind === "star");
        const planets = items.filter((item) => item.kind === "planet");
        for (const planet of planets) assert.ok(planet.r >= min - 1e-9);
        const biggest = Math.max(0, ...planets.map((planet) => planet.r));
        assert.ok(star !== undefined && star.r >= biggest * 1.5, `${fixture} ${w}×${h}: 主星 ${star?.r} 行星 ${biggest}`);
      }
    }
  });
  test("不给下限（单智能体首页）时行星照物理半径画，一个像素都不变", () => {
    const { camera, vp } = scene(1000, 600);
    const layout = layoutGalaxy(galaxySpecOf("typical"));
    const arcs = orbitArcs(layout, camera, vp);
    assert.deepEqual(drawFrame(layout, camera, vp, arcs, 1.5), drawFrame(layout, camera, vp, arcs, 1.5, 0));
  });
});

describe("按深度排序与遮挡", () => {
  function frameAt(spec: GalaxySpec, t: number): DrawItem[] {
    const layout = layoutGalaxy(spec);
    const camera = makeCamera(FRAME_EXTENT);
    const vp = frameViewport(camera, 900, 240);
    return drawFrame(layout, camera, vp, orbitArcs(layout, camera, vp), t);
  }
  const indexOf = (items: DrawItem[], key: string) => items.findIndex((item) => item.key === key);

  test("绘制表从远到近单调", () => {
    const items = frameAt(galaxySpecOf("full"), 12.3);
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1];
      const cur = items[i];
      assert.ok(prev !== undefined && cur !== undefined && prev.depth >= cur.depth);
    }
  });

  test("行星在主星背后时先画（被主星挡），在前面时后画（挡主星）", () => {
    // 相位 90° = 轨道面 +y = 远侧；270° = 近侧
    const behind = frameAt({ starMass: 600, planets: [planet("x", 20, { phaseDeg: 90 })], sessions: 0 }, 0);
    assert.ok(indexOf(behind, "planet-x") < indexOf(behind, "star"));
    const front = frameAt({ starMass: 600, planets: [planet("x", 20, { phaseDeg: 270 })], sessions: 0 }, 0);
    assert.ok(indexOf(front, "planet-x") > indexOf(front, "star"));
  });

  test("轨道远半圈在主星之后画、近半圈在之前画（分段遮挡）", () => {
    const items = frameAt({ starMass: 600, planets: [planet("x", 30, { phaseDeg: 0 })], sessions: 0 }, 0);
    const star = indexOf(items, "star");
    // 第 4 段（67.5°–90°）在远侧，第 12 段（270°–292.5°）在近侧
    assert.ok(indexOf(items, "orbit-x-4") < star);
    assert.ok(indexOf(items, "orbit-x-12") > star);
  });

  test("行星压在自家轨道线上：相邻的自家轨道段都先于行星画", () => {
    for (const phaseDeg of [0, 45, 100, 200, 300]) {
      const items = frameAt({ starMass: 600, planets: [planet("x", 30, { phaseDeg })], sessions: 0 }, 0);
      const home = Math.floor((phaseDeg / 360) * 16);
      const p = indexOf(items, "planet-x");
      for (const k of [home, (home + 1) % 16, (home + 15) % 16]) {
        assert.ok(indexOf(items, `orbit-x-${k}`) < p, `phase ${phaseDeg} arc ${k}`);
      }
    }
  });

  test("碎石带按主星前后分两半：远半圈（主星背后）的在主星中心之上，近半圈的在之下", () => {
    const layout = layoutGalaxy({ ...galaxySpecOf("full"), dustCap: Number.POSITIVE_INFINITY });
    const camera = makeCamera(FRAME_EXTENT);
    const vp = frameViewport(camera, 900, 240);
    assert.ok(layout.belt !== null);
    // 分界线 = 碎石带那一圈的中线（合成器按这条线裁开两份）
    const midY = beltFrame(layout.belt, camera, vp).cy;
    const points = dustPoints(layout.belt, camera, vp, 3);
    assert.ok(points.some((p) => p.far) && points.some((p) => !p.far));
    for (const p of points) assert.ok(p.far ? p.y < midY + 1e-6 : p.y > midY - 1e-6, `${p.id} far=${p.far} y=${p.y}`);
  });
});

describe("星系随会话长大（2026-11-24 用户：「这个星系它一直在捕捉新的东西，在长大」）", () => {
  const agentsOf = (sessions: number): GalaxySpec => ({
    starMass: 620,
    planets: [planet("a", 19), planet("b", 31), planet("c", 43)],
    sessions,
    dustCap: Number.POSITIVE_INFINITY,
  });
  const counts = [0, 1, 2, 3, 5, 10, 40, 100, 450, 1000, 2000, BELT_FULL_AT, 10_000, 1_000_000];

  test("会话数 → 碎石带宽度与外沿半径：单调不减、有上限（到 BELT_FULL_AT 条最宽，再多不再变宽；外沿不超过画框的 BELT_OVERSHOOT 倍）", () => {
    let prevGrowth = 0;
    let prevOuter = 0;
    let prevWidth = 0;
    for (const n of counts) {
      const growth = beltGrowthOf(n);
      assert.ok(growth >= prevGrowth && growth <= 1, `${n}: ${growth}`);
      prevGrowth = growth;
      const belt = layoutGalaxy(agentsOf(n)).belt;
      if (n === 0) {
        assert.equal(belt, null);
        continue;
      }
      assert.ok(belt !== null);
      assert.ok(belt.outer >= prevOuter - 1e-9, `${n}: 外沿 ${belt.outer} < ${prevOuter}`);
      assert.ok(belt.outer - belt.inner >= prevWidth - 1e-9, `${n}: 宽度变窄了`);
      assert.ok(belt.outer <= Math.min(belt.inner + BELT_MAX_WIDTH, FRAME_EXTENT * BELT_OVERSHOOT) + 1e-9, `${n}: 外沿 ${belt.outer} 超了上限`);
      prevOuter = belt.outer;
      prevWidth = belt.outer - belt.inner;
    }
    assert.equal(beltGrowthOf(BELT_FULL_AT), 1);
    assert.equal(beltGrowthOf(10 * BELT_FULL_AT), 1);
    assert.equal(beltOuterOf(30, BELT_FULL_AT), 30 + BELT_MAX_WIDTH);
    assert.equal(beltOuterOf(64, 10 * BELT_FULL_AT), FRAME_EXTENT * BELT_OVERSHOOT);
  });

  test("看得出在长大：3 条 → 40 条 → 450 条，带宽每一档都明显变宽（≥ 1.3 倍）", () => {
    const width = (n: number) => {
      const belt = layoutGalaxy(agentsOf(n)).belt;
      return belt === null ? 0 : belt.outer - belt.inner;
    };
    assert.ok(width(40) >= width(3) * 1.3, `${width(3)} → ${width(40)}`);
    assert.ok(width(450) >= width(40) * 1.3, `${width(40)} → ${width(450)}`);
  });

  test("同一条会话：方位角永远不变；越老越靠外圈，新会话进来时老会话只往外沉、不往里跳", () => {
    const seeds = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${n - 1 - i}` })); // 新的在前：s(n-1) 最新
    const at = (n: number) => new Map((layoutGalaxy({ ...agentsOf(n), dust: seeds(n) }).belt?.particles ?? []).map((p) => [p.id, p]));
    const small = at(40);
    const big = at(41);
    for (const [id, p] of small) {
      const q = big.get(id);
      assert.ok(q !== undefined);
      assert.equal(q.theta0, p.theta0, `${id} 的方位角变了`);
      // 名次往后挪一位、带子变宽：只会更靠外
      assert.ok(q.r >= p.r - 1e-9, `${id}: ${p.r} → ${q.r}`);
    }
    // 最老的在外、最新的在内（抖动只在一小段里）
    const list = [...big.values()];
    const newest = list.slice(0, 5).reduce((sum, p) => sum + p.r, 0) / 5;
    const oldest = list.slice(-5).reduce((sum, p) => sum + p.r, 0) / 5;
    assert.ok(oldest > newest);
  });

  test("几百上千颗时变成更小更淡的尘埃；永远小于在做事的碎石块与最小的行星；量大单颗不可点", () => {
    let prev = dustLookOf(1);
    for (const n of [3, 40, 450, 3000]) {
      const look = dustLookOf(n);
      assert.ok(look.px <= prev.px && look.alpha <= prev.alpha, `${n}`);
      assert.ok(look.px < ROCK_PX && look.px < PLANET_READABLE_MIN);
      prev = look;
    }
    assert.ok(dustLookOf(450).px < dustLookOf(3).px * 0.6);
    assert.ok(dustLookOf(3, true).px <= DEBRIS_PX[1]);
    assert.ok(DUST_CLICK_MAX >= 40 && DUST_CLICK_MAX < 450);
  });

  test("新会话「被捕获」只在新增时触发：第一次画不算；顺序变了、减少了、从碎石块落回碎石带都不算", () => {
    assert.deepEqual(capturedIds(null, ["a", "b"]), []);
    assert.deepEqual(capturedIds(new Set(["a", "b"]), ["c", "a", "b"]), ["c"]);
    assert.deepEqual(capturedIds(new Set(["a", "b", "c"]), ["b", "a"]), []);
    assert.deepEqual(capturedIds(new Set(["a", "b"]), ["b", "a"]), []);
  });
});

describe("动效生命周期", () => {
  const running = { hasFocus: true, visibilityState: "visible" as const, onScreen: true, reducedMotion: false };

  test("四个条件都满足才跑；任何一个不满足就停", () => {
    assert.equal(motionAllowed(running), true);
    assert.equal(motionAllowed({ ...running, visibilityState: "hidden" }), false);
    assert.equal(motionAllowed({ ...running, hasFocus: false }), false);
    assert.equal(motionAllowed({ ...running, onScreen: false }), false);
    assert.equal(motionAllowed({ ...running, reducedMotion: true }), false);
  });

});

describe("原型 fixture 参数", () => {
  test("?galaxy= 三档生效，其它值不认", () => {
    assert.equal(galaxyFixtureOf("?galaxy=full"), "full");
    assert.equal(galaxyFixtureOf("?a=1&galaxy=empty"), "empty");
    assert.equal(galaxyFixtureOf("?galaxy=typical"), "typical");
    assert.equal(galaxyFixtureOf("?galaxy=huge"), null);
    assert.equal(galaxyFixtureOf(""), null);
  });

  test("三档：空只有主星 + 预期轨道；平常 4 颗行星 + 少量星屑；满载 12 颗只画 6 圈 + 聚合碎石带", () => {
    const empty = layoutGalaxy(galaxySpecOf("empty"));
    assert.equal(empty.planets.length, 0);
    assert.equal(empty.belt, null);
    assert.ok(empty.expectedOrbit !== null);
    const typical = layoutGalaxy(galaxySpecOf("typical"));
    assert.equal(typical.planets.length, 4);
    assert.equal(typical.hidden, 0);
    assert.equal(typical.orbitScale, 1);
    assert.ok((typical.belt?.particles.length ?? 0) > 0 && (typical.belt?.particles.length ?? 0) < 40);
    assert.deepEqual(typical.adjusted, []);
    const fullSpec = galaxySpecOf("full");
    assert.equal(fullSpec.planets.length, 12);
    assert.equal(fullSpec.sessions, 2000);
    // 三档主星同一质量：主星大小只由质量定
    assert.equal(fullSpec.starMass, galaxySpecOf("typical").starMass);
    assert.equal(galaxySpecOf("empty").starMass, galaxySpecOf("typical").starMass);
    const full = layoutGalaxy(fullSpec);
    assert.equal(full.planets.length, VISIBLE_ORBIT_CAP);
    assert.equal(full.hidden, 12 - VISIBLE_ORBIT_CAP);
    assert.equal(full.belt?.particles.length, DUST_CAP);
    assert.equal(full.belt?.count, 2000);
    assert.ok(full.orbitScale < 1);
  });
});
