import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { STAR_MASS } from "../chat/galaxy.ts";
import { defaultDesign, displayRadius, minOrbit, PREVIEW_FRAME, radiusOf, ZOOM_DEFAULT, type CompleteDesign } from "./design.ts";
import {
  flatStage,
  gridLines,
  ORBIT_BOX,
  orbitStage,
  SIT,
  starStage,
  WELL,
  wellBottom,
  wellDepth,
  wellScene,
  wellZ,
  type WellBox,
} from "./well.ts";

const BOX: WellBox = { x: -PREVIEW_FRAME.halfW, y: -PREVIEW_FRAME.halfH, w: PREVIEW_FRAME.halfW * 2, h: PREVIEW_FRAME.halfH * 2 };

function design(): CompleteDesign {
  return defaultDesign("ws-a", "default");
}

function withStarMass(mass: number): CompleteDesign {
  const d = design();
  return { ...d, star: { ...d.star, mass } };
}

function withOrbit(orbitRadius: number): CompleteDesign {
  const d = design();
  return { ...d, planet: { ...d.planet, orbitRadius } };
}

describe("引力井：深度与形状", () => {
  test("坑深随主星质量单调变大，区间两端是 depthMin / depthMax；越界夹住、非数字按最轻", () => {
    let last = -Infinity;
    for (let m = STAR_MASS.min; m <= STAR_MASS.max; m += 50) {
      const d = wellDepth(m);
      assert.ok(d > last, `${m}`);
      last = d;
    }
    assert.equal(wellDepth(STAR_MASS.min), WELL.depthMin);
    assert.equal(wellDepth(STAR_MASS.max), WELL.depthMax);
    assert.equal(wellDepth(5000), WELL.depthMax);
    assert.equal(wellDepth(Number.NaN), WELL.depthMin);
  });

  test("布面高度：中心最深 = −depth，往外单调回升，远处接近平面；不会高过平面", () => {
    const depth = 20;
    assert.equal(wellZ(0, depth), -depth);
    let last = -Infinity;
    for (let r = 0; r <= 300; r += 5) {
      const z = wellZ(r, depth);
      assert.ok(z >= last && z <= 0 && z >= -depth);
      last = z;
    }
    assert.ok(Math.abs(wellZ(WELL.extent * 3, depth)) < depth * 0.03);
    assert.equal(wellZ(30, 0), -0);
  });

  test("确定性：同样的质量每次画出同一张网格（不随机抖动）", () => {
    const scene = wellScene(BOX, { elevationDeg: 24, fitRadius: WELL.extent, fitW: 1, fitH: 100, originY: 0.34 });
    assert.deepEqual(gridLines(scene, 12).map((l) => l.d), gridLines(scene, 12).map((l) => l.d));
  });
});

describe("主星页：主星压在网格上", () => {
  const r = (mass: number): number => displayRadius(radiusOf(withStarMass(mass), "star"));

  test("质量越大：坑底在画面上越低、穿过中心的线下沉越多、主星也跟着往下沉", () => {
    const light = starStage(BOX, STAR_MASS.min, r(STAR_MASS.min), ZOOM_DEFAULT.star);
    const heavy = starStage(BOX, STAR_MASS.max, r(STAR_MASS.max), ZOOM_DEFAULT.star);
    assert.ok(heavy.depth > light.depth);
    assert.ok(heavy.bottom.y - light.bottom.y > 20, `坑底下降 ${heavy.bottom.y - light.bottom.y}px，要一眼看得出`);
    const centerSag = (stage: typeof light): number => Math.max(...stage.grid.filter((l) => l.key === "x0" || l.key === "y0").map((l) => l.sag));
    assert.ok(centerSag(heavy) > centerSag(light));
    assert.ok(heavy.star.y > light.star.y, "重的主星沉得更低");
    // 取景只看平面、不看坑：质量变了画面不缩放，网格的平坦远处位置不变
    const far = (stage: typeof light): string | undefined => stage.grid.find((l) => l.key === `x${WELL.step * 30}`)?.d;
    assert.equal(far(heavy), far(light));
  });

  test("网格有界：每个点都在相机前面、坐标有限；中心横线与纵线都穿过坑底", () => {
    for (const mass of [STAR_MASS.min, STAR_MASS.max]) {
      const stage = starStage(BOX, mass, r(mass), ZOOM_DEFAULT.star);
      assert.ok(stage.grid.length > 20);
      for (const line of stage.grid) {
        assert.ok(line.points.length === WELL.samples + 1);
        for (const p of line.points) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.depth > 0);
        assert.ok(line.sag >= 0 && line.sag <= stage.depth + 1e-9);
      }
      assert.ok(stage.grid.some((l) => l.key === "x0") && stage.grid.some((l) => l.key === "y0"));
    }
  });

  test("默认缩放下，最轻到最重的主星都整颗在画框里（坑底与主星上下沿都不出框）", () => {
    for (const mass of [STAR_MASS.min, 620, STAR_MASS.max]) {
      const stage = starStage(BOX, mass, r(mass), ZOOM_DEFAULT.star);
      assert.ok(stage.bottom.y < BOX.y + BOX.h, `${mass} 坑底`);
      assert.ok(stage.star.y - stage.star.r > BOX.y, `${mass} 主星上沿 ${stage.star.y - stage.star.r}`);
      assert.ok(stage.star.y + stage.star.r < BOX.y + BOX.h, `${mass} 主星下沿 ${stage.star.y + stage.star.r}`);
      assert.ok(Math.abs(stage.star.y - (stage.bottom.y - SIT * stage.star.r)) < 1e-9, "主星陷在坑里一截");
    }
  });

  test("没有主星：同一个取景下是一张平的布（每条线下沉 0）", () => {
    const flat = flatStage(BOX);
    for (const line of flat.grid) assert.equal(line.sag, 0);
    assert.deepEqual(flat.center, wellBottom(flat.scene, 0));
  });
});

describe("行星页：轨道场景", () => {
  test("头像与轨道同时在：有行星时场景里有主星、轨道、行星；轨道半径变大，轨道变宽、行星离主星更远，天体大小不变", () => {
    const near = orbitStage(withOrbit(16));
    const far = orbitStage(withOrbit(44));
    assert.ok(near !== null && far !== null && near.planet !== null && far.planet !== null);
    const span = (stage: typeof near): number => {
      const xs = stage.planet?.orbit.points.map((p) => p.x) ?? [];
      return Math.max(...xs) - Math.min(...xs);
    };
    assert.ok(span(far) > span(near) * 2);
    assert.ok(Math.abs(far.planet.x - far.star.x) > Math.abs(near.planet.x - near.star.x));
    assert.equal(near.star.r, far.star.r);
    assert.equal(near.planet.a, 16);
    assert.equal(far.planet.a, 44);
  });

  test("主星质量也改轨道场景：网格坑更深，主星画得更低", () => {
    const light = orbitStage(withStarMass(STAR_MASS.min));
    const heavy = orbitStage(withStarMass(STAR_MASS.max));
    assert.ok(light !== null && heavy !== null);
    assert.ok(heavy.depth > light.depth);
    assert.ok(heavy.star.y > light.star.y);
    assert.ok(Math.max(...heavy.grid.map((l) => l.sag)) > Math.max(...light.grid.map((l) => l.sag)));
  });

  test("轨道比最近合法轨道还近：标相撞；合法时不标", () => {
    const d = design();
    const near = minOrbit(d);
    assert.equal(orbitStage(withOrbit(near + 0.5))?.planet?.collide, false);
    assert.equal(orbitStage(withOrbit(near - 0.5))?.planet?.collide, true);
    assert.equal(orbitStage(withOrbit(Number.NaN))?.planet?.collide, true, "数字框清空也算不合法");
  });

  test("场景有界：最大合法轨道、最重的主星都装在 260 × 140 的小画布里；行星至少有几个像素大（不退成一个点）", () => {
    const d = design();
    const heavy = { ...d, star: { ...d.star, mass: STAR_MASS.max }, planet: { ...d.planet, orbitRadius: 52 } };
    const stage = orbitStage(heavy);
    assert.ok(stage !== null && stage.planet !== null);
    for (const p of stage.planet.orbit.points) {
      assert.ok(p.x >= ORBIT_BOX.x && p.x <= ORBIT_BOX.x + ORBIT_BOX.w, `x ${p.x}`);
      assert.ok(p.y >= ORBIT_BOX.y && p.y <= ORBIT_BOX.y + ORBIT_BOX.h, `y ${p.y}`);
    }
    assert.ok(stage.star.y + stage.star.r <= ORBIT_BOX.y + ORBIT_BOX.h);
    assert.ok(stage.planet.r >= 5);
  });

  test("有主星没行星：场景里只有主星，没有轨道", () => {
    const stage = orbitStage({ ...design(), planet: null });
    assert.ok(stage !== null);
    assert.equal(stage.planet, null);
  });
});
