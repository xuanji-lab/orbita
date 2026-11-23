import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { DENSITY, MIN_CLEARANCE, PLANET_MASS, PLANET_ZONE, STAR_DENSITY, STAR_MASS, bodyRadius } from "../chat/galaxy.ts";
import {
  bodyArt,
  createDesignStore,
  defaultDesign,
  densityOf,
  designerClick,
  designerFollow,
  designLevelOf,
  displayRadius,
  ELEMENTS_OF,
  errorsAt,
  EYE_MIN,
  FACE,
  keepDesignerAcrossSessions,
  LONG_NAME,
  minOrbit,
  maxOrbit,
  NAME_MAX,
  parseNumberInput,
  PREVIEW_FRAME,
  BACKDROPS,
  ZOOM_DEFAULT,
  previewFrame,
  radiusOf,
  ringFrontPoints,
  validateDesign,
  type GalaxyDesign,
} from "./design.ts";

const WS_A = "ws-a";
const WS_B = "ws-bbbb";

function legal(): GalaxyDesign {
  return defaultDesign(WS_A, "default");
}

describe("参数约束", () => {
  test("主星与行星的质量区间不重叠，行星上限远低于主星下限", () => {
    assert.ok(PLANET_MASS.max < STAR_MASS.min / 5);
  });

  test("默认档三种工作区预设都合法", () => {
    for (const id of ["a", "b", "c", "d", "e", WS_A, WS_B]) {
      assert.deepEqual(validateDesign(defaultDesign(id, "default")), [], id);
      assert.deepEqual(validateDesign(defaultDesign(id, "bare")), [], id);
    }
  });

  test("行星质量越界：报错、值原样留着（不夹）", () => {
    const design = legal();
    const bad = { ...design, planet: { ...design.planet, mass: 120 } };
    const errors = validateDesign(bad);
    assert.equal(errors.length, 1);
    assert.deepEqual(errors[0], { kind: "mass-range", body: "planet", min: PLANET_MASS.min, max: PLANET_MASS.max, value: 120 });
    assert.equal(bad.planet.mass, 120);
    assert.equal(errorsAt(errors, "planet", "mass").length, 1);
    assert.equal(errorsAt(errors, "star", "mass").length, 0);
  });

  test("主星质量低于下限（落进行星区间）也报错；输入框清空（NaN）同样报错", () => {
    const design = legal();
    assert.equal(validateDesign({ ...design, star: { ...design.star, mass: 40 } })[0]?.kind, "mass-range");
    assert.equal(validateDesign({ ...design, star: { ...design.star, mass: Number.NaN } })[0]?.kind, "mass-range");
  });

  test("轨道太近 = 相撞：下限是两颗半径和 + 间距；错同时挂在轨道行与主星质量行", () => {
    const design = legal();
    const near = minOrbit(design);
    assert.ok(Math.abs(near - (radiusOf(design, "star") + radiusOf(design, "planet") + MIN_CLEARANCE)) < 1e-9);
    const atLimit = { ...design, planet: { ...design.planet, orbitRadius: near } };
    assert.deepEqual(validateDesign(atLimit), []);
    const inside = { ...design, planet: { ...design.planet, orbitRadius: near - 0.01 } };
    const errors = validateDesign(inside);
    assert.equal(errors[0]?.kind, "orbit-collision");
    assert.equal(errorsAt(errors, "planet", "orbit").length, 1);
    assert.equal(errorsAt(errors, "star", "mass").length, 1);
  });

  test("非法组合：每个值都在区间里，但加大主星质量后合法轨道变成相撞", () => {
    const design = { ...legal(), planet: { ...legal().planet, orbitRadius: 13 } };
    assert.deepEqual(validateDesign(design), []);
    const heavier = { ...design, star: { ...design.star, mass: STAR_MASS.max } };
    assert.equal(validateDesign(heavier)[0]?.kind, "orbit-collision");
  });

  test("轨道超出行星区报错；名字超长报错", () => {
    const design = legal();
    assert.equal(validateDesign({ ...design, planet: { ...design.planet, orbitRadius: PLANET_ZONE + 1 } })[0]?.kind, "orbit-far");
    assert.ok(maxOrbit(design) < PLANET_ZONE);
    const named = { ...design, planet: { ...design.planet, name: "九".repeat(NAME_MAX + 1) } };
    assert.deepEqual(validateDesign(named), [{ kind: "name-long", body: "planet", max: NAME_MAX, length: NAME_MAX + 1 }]);
    assert.deepEqual(validateDesign({ ...design, planet: { ...design.planet, name: "九".repeat(NAME_MAX) } }), []);
  });

  test("满载档：元素全开、质量顶到上沿、名字超长、轨道相撞——错误都报出来", () => {
    const full = defaultDesign(WS_A, "full");
    assert.equal(full.star.mass, STAR_MASS.max);
    assert.equal(full.planet.mass, PLANET_MASS.max);
    const kinds = validateDesign(full).map((error) => error.kind).sort();
    assert.deepEqual(kinds, ["name-long", "name-long", "orbit-collision"]);
    assert.ok([...LONG_NAME].length > NAME_MAX);
  });

  test("数字框：空串与非数字是 NaN，不悄悄回退成 0", () => {
    assert.ok(Number.isNaN(parseNumberInput("")));
    assert.ok(Number.isNaN(parseNumberInput("abc")));
    assert.equal(parseNumberInput(" 12.5 "), 12.5);
  });
});

describe("半径计算", () => {
  test("质量 + 成分定半径：同 galaxy.ts 的 (质量 / 密度)^(1/3)；主星密度固定", () => {
    const design = legal();
    const rock = { ...design, planet: { ...design.planet, mass: 8, composition: "rock" as const } };
    assert.equal(radiusOf(rock, "planet"), bodyRadius(8, DENSITY.rock));
    assert.equal(radiusOf(design, "star"), bodyRadius(620, STAR_DENSITY));
    assert.equal(densityOf("star", "gas"), STAR_DENSITY);
    assert.equal(densityOf("planet", "ice"), DENSITY.ice);
  });

  test("同质量下密度越小越大：气态 > 冰质 > 岩石", () => {
    const design = legal();
    const at = (composition: "rock" | "ice" | "gas") => radiusOf({ ...design, planet: { ...design.planet, mass: 10, composition } }, "planet");
    assert.ok(at("gas") > at("ice") && at("ice") > at("rock"));
  });

  test("轨道半径不影响天体半径", () => {
    const design = legal();
    const far = { ...design, planet: { ...design.planet, orbitRadius: 40 } };
    assert.equal(radiusOf(far, "planet"), radiusOf(design, "planet"));
  });

  test("显示半径：单调、主星最小也明显大于行星最大（半径 ≥1.35 倍，面积近 2 倍）、最小的行星脸读得出", () => {
    const starMin = displayRadius(bodyRadius(STAR_MASS.min, STAR_DENSITY));
    const planetMax = displayRadius(bodyRadius(PLANET_MASS.max, DENSITY.gas));
    const planetMin = displayRadius(bodyRadius(PLANET_MASS.min, DENSITY.rock));
    assert.ok(starMin / planetMax >= 1.35, `${starMin} / ${planetMax}`);
    assert.ok(planetMin >= 18, `planet min ${planetMin}`);
    assert.ok(displayRadius(2) > displayRadius(1));
    // 差距被压小了：真实半径比 > 显示半径比
    assert.ok(bodyRadius(STAR_MASS.min, STAR_DENSITY) / bodyRadius(PLANET_MASS.max, DENSITY.gas) > starMin / planetMax);
  });
});

describe("元素组合与 2D 形象", () => {
  test("主星没有卫星与云带，行星没有日冕：开关打开也不画", () => {
    assert.deepEqual([...ELEMENTS_OF.star], ["face", "ring", "corona"]);
    const full = defaultDesign(WS_A, "full");
    const star = bodyArt({ ...full, editing: "star" }, "star", 60);
    assert.equal(star.moons.length, 0);
    assert.equal(star.clouds.length, 0);
    assert.notEqual(star.corona, null);
    const planet = bodyArt(full, "planet", 40);
    assert.equal(planet.corona, null);
    assert.equal(planet.moons.length, 2);
    assert.equal(planet.clouds.length, 2);
  });

  test("空元素档：只剩成分自带的纹理", () => {
    const bare = defaultDesign(WS_A, "bare");
    for (const composition of ["rock", "ice", "gas"] as const) {
      const art = bodyArt({ ...bare, planet: { ...bare.planet, composition } }, "planet", 40);
      assert.equal(art.face, null);
      assert.equal(art.ring, null);
      assert.equal(art.clouds.length, 0);
      assert.equal(art.moons.length, 0);
      assert.equal(art.surface, composition);
    }
    const art = (composition: "rock" | "ice" | "gas") => bodyArt({ ...bare, planet: { ...bare.planet, composition } }, "planet", 40);
    assert.ok(art("rock").craters.length > 0 && art("rock").bands.length === 0);
    assert.ok(art("gas").bands.length > 0 && art("gas").craters.length === 0);
    assert.ok(art("ice").cap !== null && art("ice").cracks.length > 0);
  });

  test("任意元素组合：开哪个画哪个，互不牵连（2^4 种行星组合）", () => {
    const base = defaultDesign(WS_A, "bare");
    for (let mask = 0; mask < 16; mask++) {
      const elements = { face: (mask & 1) > 0, ring: (mask & 2) > 0, clouds: (mask & 4) > 0, moons: (mask & 8) > 0, corona: true };
      const art = bodyArt({ ...base, planet: { ...base.planet, elements } }, "planet", 30);
      assert.equal(art.face !== null, elements.face);
      assert.equal(art.ring !== null, elements.ring);
      assert.equal(art.clouds.length > 0, elements.clouds);
      assert.equal(art.moons.length > 0, elements.moons);
      assert.equal(art.corona, null);
    }
  });

  test("星环前半从脸下面绕过去：嘴的横向范围内，星环比嘴低", () => {
    for (const r of [16, 30, 80]) {
      const mouthBottom = (FACE.mouthY + FACE.mouthDip / 2) * r;
      const front = ringFrontPoints(r).filter((p) => Math.abs(p.x) <= (FACE.mouthX + 0.1) * r);
      assert.ok(front.length > 0);
      for (const p of front) assert.ok(p.y > mouthBottom + 0.05 * r, `r=${r} 环 ${p.y} 嘴 ${mouthBottom}`);
    }
  });

  test("纹理、云带、卫星都不压在脸上；小行星的眼睛也不小于 EYE_MIN", () => {
    const full = defaultDesign(WS_A, "full");
    const r = displayRadius(bodyRadius(PLANET_MASS.min, DENSITY.rock));
    for (const composition of ["rock", "ice", "gas"] as const) {
      const art = bodyArt({ ...full, planet: { ...full.planet, composition, mass: PLANET_MASS.min } }, "planet", r);
      assert.ok(art.face !== null);
      for (const eye of art.face.eyes) assert.ok(eye.r >= EYE_MIN);
      const faceTop = (FACE.eyeY - FACE.eyeR) * r - 1;
      const faceBottom = (FACE.mouthY + FACE.mouthDip) * r + 1;
      const faceX = (FACE.eyeX + FACE.eyeR) * r;
      for (const c of art.craters) {
        const overlapX = Math.abs(c.x) - c.r < faceX;
        const overlapY = c.y + c.r > faceTop && c.y - c.r < faceBottom;
        assert.ok(!(overlapX && overlapY), `crater ${JSON.stringify(c)}`);
      }
      for (const band of art.bands) assert.ok(band.y + band.h < faceTop || band.y > faceBottom, `band ${band.y}`);
      for (const cloud of art.clouds) assert.ok(cloud.y + cloud.h < faceTop || cloud.y > faceBottom, `cloud ${cloud.y}`);
      for (const moon of art.moons) assert.ok(Math.hypot(moon.x, moon.y) - moon.r > r, "卫星在天体外");
    }
  });

  test("外框随元素变：星环把宽度撑到 1.7r 以外", () => {
    const bare = defaultDesign(WS_A, "bare");
    const ringed = { ...bare, planet: { ...bare.planet, elements: { ...bare.planet.elements, ring: true } } };
    assert.equal(bodyArt(bare, "planet", 40).extent.x, 40);
    assert.ok(bodyArt(ringed, "planet", 40).extent.x > 1.7 * 40);
  });
});

describe("预览画框", () => {
  test("平常的行星用固定画框（质量变了在同一个框里变大变小），满载主星 + 日冕 + 星环放大画框装下", () => {
    const design = legal();
    const small = bodyArt(design, "planet", displayRadius(radiusOf(design, "planet")));
    assert.deepEqual(previewFrame(small), { ...PREVIEW_FRAME, scale: 1 });
    const full = defaultDesign(WS_A, "full");
    const star = bodyArt({ ...full, editing: "star" }, "star", displayRadius(radiusOf(full, "star")));
    const frame = previewFrame(star);
    assert.ok(frame.scale > 1);
    assert.ok(frame.halfW >= star.extent.x && frame.halfH >= star.extent.y);
    assert.ok(Math.abs(frame.halfW / frame.halfH - PREVIEW_FRAME.halfW / PREVIEW_FRAME.halfH) < 1e-9, "比例不变");
  });
});

describe("默认预览缩放", () => {
  test("行星默认 140%、主星默认 100%；三档 fixture 都按这个给", () => {
    for (const level of ["default", "bare", "full"] as const) {
      const design = defaultDesign(WS_A, level);
      assert.equal(design.planet.zoom, ZOOM_DEFAULT.planet);
      assert.equal(design.star.zoom, ZOOM_DEFAULT.star);
    }
    assert.ok(ZOOM_DEFAULT.planet > 100);
  });

  test("默认缩放下任何合法行星（最重、最松的成分、元素全开）都装得进固定画框，不溢出", () => {
    const full = defaultDesign(WS_A, "full");
    for (const composition of ["rock", "ice", "gas"] as const) {
      for (const mass of [PLANET_MASS.min, 6, 14, PLANET_MASS.max]) {
        const design = { ...full, planet: { ...full.planet, composition, mass } };
        const art = bodyArt(design, "planet", displayRadius(radiusOf(design, "planet")));
        const k = ZOOM_DEFAULT.planet / 100;
        assert.equal(previewFrame(art).scale, 1, `${composition} ${mass} 不该撑大画框`);
        assert.ok(art.extent.x * k <= PREVIEW_FRAME.halfW && art.extent.y * k <= PREVIEW_FRAME.halfH, `${composition} ${mass}: ${art.extent.x * k} × ${art.extent.y * k}`);
      }
    }
  });

  test("默认缩放后最小的行星眼睛也够大（屏上 ≥ 2.5 个单位）；缩放不改半径读数", () => {
    const design = { ...legal(), planet: { ...legal().planet, mass: PLANET_MASS.min, composition: "rock" as const } };
    const art = bodyArt(design, "planet", displayRadius(radiusOf(design, "planet")));
    assert.ok(art.face !== null);
    assert.ok(art.face.eyes[0].r * (ZOOM_DEFAULT.planet / 100) >= 2.5);
    const zoomed = { ...design, planet: { ...design.planet, zoom: 200 } };
    assert.equal(radiusOf(zoomed, "planet"), radiusOf(design, "planet"));
  });
});

describe("预览背景与出错的输入框（样式约束）", () => {
  const css = readFileSync(new URL("./galaxy-designer.css", import.meta.url), "utf8");

  test("四档背景都是中性 token，不借 --color-nebula（它只给用量）", () => {
    assert.deepEqual([...BACKDROPS], ["well", "shell", "muted", "deep"]);
    assert.doesNotMatch(css, /--color-nebula/);
    for (const backdrop of BACKDROPS.filter((b) => b !== "well")) assert.match(css, new RegExp(`data-backdrop="${backdrop}"`));
  });

  test("出错的框聚焦时边框、焦点环、描边都是 danger，不被 accent 盖掉", () => {
    const rule = /\.gd \.gd-number\[aria-invalid\]:focus,\s*\.gd \.gd-name\[aria-invalid\]:focus\s*\{([^}]*)\}/.exec(css);
    assert.ok(rule !== null, "缺出错聚焦态的规则");
    const body = rule[1] ?? "";
    assert.match(body, /border-color:\s*var\(--color-danger\)/);
    assert.match(body, /box-shadow:[^;]*--color-danger/);
    assert.match(body, /outline-color:\s*var\(--color-danger\)/);
    assert.doesNotMatch(body, /--color-accent/);
  });
});

describe("每个工作区一份设计稿", () => {
  test("不同工作区的 fixture 可以不同，同一个工作区每次一样", () => {
    const ids = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    const compositions = new Set(ids.map((id) => defaultDesign(id, "default").planet.composition));
    assert.ok(compositions.size > 1);
    assert.deepEqual(defaultDesign("alpha", "default"), defaultDesign("alpha", "default"));
  });

  test("改 A 不串到 B；关了再开（再 get）还在；恢复默认回到 fixture", () => {
    const store = createDesignStore("default");
    const a = store.get(WS_A);
    const b0 = store.get(WS_B);
    store.set(WS_A, { ...a, planet: { ...a.planet, mass: 33, zoom: 150 } });
    assert.equal(store.get(WS_A).planet.mass, 33);
    assert.equal(store.get(WS_A).planet.zoom, 150);
    assert.equal(store.get(WS_A).star.zoom, ZOOM_DEFAULT.star, "行星的缩放不带到主星");
    assert.equal(store.get(WS_B).planet.zoom, ZOOM_DEFAULT.planet, "A 的缩放不串到 B");
    assert.deepEqual(store.get(WS_B), b0);
    assert.deepEqual(store.reset(WS_A), defaultDesign(WS_A, "default"));
    assert.deepEqual(store.get(WS_A), defaultDesign(WS_A, "default"));
  });

  test("fixture 档从地址读：?designer=bare|full，其余是默认", () => {
    assert.equal(designLevelOf("?designer=full"), "full");
    assert.equal(designLevelOf("?designer=bare&galaxy=full"), "bare");
    assert.equal(designLevelOf("?designer=x"), "default");
    assert.equal(designLevelOf(""), "default");
  });
});

describe("面板开合与切工作区", () => {
  test("点 DIY：关着 → 打开这个工作区；开着同一个 → 收起；开着别的 → 换过去", () => {
    assert.deepEqual(designerClick({ panel: null, target: null }, WS_A), { panel: "galaxy", target: WS_A });
    assert.deepEqual(designerClick({ panel: "galaxy", target: WS_A }, WS_A), { panel: null, target: WS_A });
    assert.deepEqual(designerClick({ panel: "galaxy", target: WS_A }, WS_B), { panel: "galaxy", target: WS_B });
    // 别的面板开着（文件）：换成设计面板
    assert.deepEqual(designerClick({ panel: "files", target: WS_A }, WS_A), { panel: "galaxy", target: WS_A });
  });

  test("主槽换工作区：面板开着就跟过去；关着不动；换到无工作区的任务不跟", () => {
    const open = { panel: "galaxy" as const, target: WS_A };
    assert.deepEqual(designerFollow(open, WS_B), { panel: "galaxy", target: WS_B });
    assert.equal(designerFollow(open, null), open);
    assert.equal(designerFollow(open, WS_A), open);
    const closed = { panel: null, target: WS_A };
    assert.equal(designerFollow(closed, WS_B), closed);
    const files = { panel: "files" as const, target: WS_A };
    assert.equal(designerFollow(files, WS_B), files);
  });

  test("切会话：设计面板开着、目标会话没记过面板就留着；记过别的面板照记忆换", () => {
    assert.equal(keepDesignerAcrossSessions("galaxy", null), "galaxy");
    assert.equal(keepDesignerAcrossSessions("galaxy", "files"), "files");
    assert.equal(keepDesignerAcrossSessions("files", null), null);
    assert.equal(keepDesignerAcrossSessions(null, "review"), "review");
  });
});
