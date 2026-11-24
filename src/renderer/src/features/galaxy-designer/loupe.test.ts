import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { bodyArt, defaultDesign, displayRadius, massRange, ORBIT_RANGE, radiusOf, type CompleteDesign } from "./design.ts";
import { DETAIL_GAP, detailScale, externalTangents, LOUPE_SIDE_MIN, LOUPE_VIEW, loupeFrame, loupeLayout, MARK_GAP, type Segment } from "./loupe.ts";
import { orbitStage } from "./well.ts";

function planetDesign(patch: { mass?: number; orbitRadius?: number } = {}): CompleteDesign {
  const d = defaultDesign("ws-a", "default");
  return { ...d, editing: "planet", planet: { ...d.planet, ...patch } };
}

/** 切线条件：切点到圆心的距离 = 半径，且线段方向与半径垂直 */
function assertTangent(line: Segment, c: { x: number; y: number; r: number }, end: 1 | 2): void {
  const px = end === 1 ? line.x1 : line.x2;
  const py = end === 1 ? line.y1 : line.y2;
  assert.ok(Math.abs(Math.hypot(px - c.x, py - c.y) - c.r) < 1e-6, "切点在圆上");
  const dot = (px - c.x) * (line.x2 - line.x1) + (py - c.y) * (line.y2 - line.y1);
  assert.ok(Math.abs(dot) < 1e-6, "半径与切线垂直");
}

describe("局部放大版式（loupe）", () => {
  test("宽 ≥ 280 左右排，更窄上下排；默认面板 320（内容宽 288）是左右排", () => {
    assert.equal(loupeLayout(LOUPE_SIDE_MIN), "side");
    assert.equal(loupeLayout(LOUPE_SIDE_MIN - 1), "stack");
    assert.equal(loupeLayout(288), "side");
    assert.equal(loupeLayout(228), "stack", "面板地板 260 − 32");
    assert.equal(loupeFrame(Number.NaN).layout, "side", "量不到宽度时按默认面板算");
  });

  test("两块不重叠、拼满画框；左右排与主星页同一个高宽比", () => {
    const side = loupeFrame(300);
    assert.equal(side.scene.w + side.detail.w, side.w);
    assert.equal(side.detail.x, side.scene.w);
    assert.equal(side.h, Math.round(300 * (180 / 260)));
    const wide = loupeFrame(640);
    assert.equal(wide.h, 240, "宽面板不再长高");
    assert.ok(wide.scene.w > wide.w * 0.6, "多出来的宽度给引力场");
    const stack = loupeFrame(240);
    assert.equal(stack.scene.h + stack.detail.h, stack.h);
    assert.equal(stack.detail.y, stack.scene.h);
    assert.ok(stack.h > stack.w, "上下排比宽高");
  });

  test("外公切线：两条都切两个圆，左右排先上后下，上下排先右后左", () => {
    const a = { x: 40, y: 60, r: 6 };
    const b = { x: 220, y: 70, r: 50 };
    const lines = externalTangents(a, b);
    assert.ok(lines !== null);
    for (const line of lines) {
      assertTangent(line, a, 1);
      assertTangent(line, b, 2);
    }
    assert.ok(lines[0].y1 < a.y && lines[1].y1 > a.y, "第一根在上");
    assert.ok(lines[0].y2 < b.y - b.r * 0.9 && lines[1].y2 > b.y + b.r * 0.9, "落在大圆的上下缘附近");
    const v = externalTangents({ x: 100, y: 40, r: 5 }, { x: 110, y: 200, r: 60 });
    assert.ok(v !== null);
    assert.ok(v[0].x2 > 110 && v[1].x2 < 110, "上下排：先右后左");
  });

  test("两圆相交或相含时不画引线", () => {
    assert.equal(externalTangents({ x: 0, y: 0, r: 10 }, { x: 15, y: 0, r: 10 }), null);
    assert.equal(externalTangents({ x: 0, y: 0, r: 2 }, { x: 1, y: 0, r: 30 }), null);
    assert.equal(externalTangents({ x: 0, y: 0, r: 2 }, { x: 0, y: 0, r: 2 }), null);
  });

  test("大形象的缩放是固定的：行星质量越大，大形象越大", () => {
    const range = massRange("planet");
    const frame = loupeFrame(288);
    const sizeAt = (mass: number): number => {
      const d = planetDesign({ mass });
      const art = bodyArt(d, "planet", displayRadius(radiusOf(d, "planet")));
      return art.r * detailScale(frame.detail, art.extent);
    };
    assert.ok(sizeAt(range.max) > sizeAt(range.min) * 1.5, `${sizeAt(range.min)} → ${sizeAt(range.max)}`);
  });

  test("开了星环与卫星、预览缩放拉满，大形象也整颗装在形象那一块里", () => {
    const d0 = planetDesign({ mass: massRange("planet").max });
    const d = { ...d0, planet: { ...d0.planet, composition: "gas" as const, elements: { ...d0.planet.elements, ring: true, moons: true } } };
    for (const width of [228, 315, 568]) {
      const frame = loupeFrame(width);
      const art = bodyArt(d, "planet", displayRadius(radiusOf(d, "planet")));
      const k = detailScale(frame.detail, art.extent, 200);
      assert.ok(art.extent.x * k * 2 <= frame.detail.w && art.extent.y * k * 2 <= frame.detail.h, `宽 ${width}`);
    }
  });

  test("各种宽度、轨道与质量下：小行星落在场景块里，两根引线都在，起点在场景块、终点在形象块", () => {
    const range = massRange("planet");
    for (const width of [228, 279, 288, 420, 640]) {
      const frame = loupeFrame(width);
      for (const orbitRadius of [ORBIT_RANGE.min + 10, 24, ORBIT_RANGE.max]) {
        for (const mass of [range.min, range.max]) {
          const d = planetDesign({ mass, orbitRadius });
          const stage = orbitStage(d, 34, { box: frame.scene, ...LOUPE_VIEW[frame.layout] });
          assert.ok(stage !== null && stage.planet !== null);
          const p = stage.planet;
          const where = `宽 ${width} 轨道 ${orbitRadius} 质量 ${mass}`;
          assert.ok(p.x > frame.scene.x && p.x < frame.scene.x + frame.scene.w, `${where}：小行星 x 在场景块里`);
          assert.ok(p.y > frame.scene.y && p.y < frame.scene.y + frame.scene.h, `${where}：小行星 y 在场景块里`);
          const small = bodyArt(d, "planet", p.r);
          const art = bodyArt(d, "planet", displayRadius(radiusOf(d, "planet")));
          const k = detailScale(frame.detail, art.extent);
          const big = { x: frame.detail.x + frame.detail.w / 2, y: frame.detail.y + frame.detail.h / 2, r: art.r * k + DETAIL_GAP };
          const lines = externalTangents({ x: p.x, y: p.y, r: small.r + MARK_GAP }, big);
          assert.ok(lines !== null, `${where}：有引线`);
          for (const line of lines) {
            assert.ok(line.x1 >= frame.scene.x - 1 && line.x1 <= frame.scene.x + frame.scene.w + 1, `${where}：起点在场景块`);
            assert.ok(line.y1 >= frame.scene.y - 1 && line.y1 <= frame.scene.y + frame.scene.h + 1, `${where}：起点在场景块`);
          }
        }
      }
    }
  });

  test("轨道变远，场景里的小行星跟着挪，引线起点跟着走（椭圆有朝向，比较离主星的距离而不是只看 x）", () => {
    const frame = loupeFrame(288);
    const at = (orbitRadius: number): number => {
      const stage = orbitStage(planetDesign({ orbitRadius }), 34, { box: frame.scene, ...LOUPE_VIEW.side });
      assert.ok(stage !== null && stage.planet !== null);
      return Math.hypot(stage.planet.x - stage.star.x, stage.planet.y - stage.star.y);
    };
    assert.ok(at(ORBIT_RANGE.max) > at(24) + 10);
  });
});
