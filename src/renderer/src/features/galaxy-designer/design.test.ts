import assert from "node:assert/strict";
import { EYE_STYLES } from "../../../../shared/planet-design.ts";
import { readFileSync } from "node:fs";
import { orbitStage, previewPlan } from "./well.ts";
import { describe, test } from "node:test";
import { DENSITY, MIN_CLEARANCE, PLANET_MASS, PLANET_ZONE, STAR_DENSITY, STAR_MASS, bodyRadius } from "../chat/galaxy.ts";
import { storyLineOf,
  bodyArt,
  createDesignStore,
  seededDesign,
  avatarScale,
  starExtentRatio,
  AVATAR_SCALE,
  STAR_MASS_STEPS,
  defaultDesign,
  densityOf,
  designerClick,
  designerFollow,
  designLevelOf,
  displayRadius,
  ELEMENTS_OF,
  errorsAt,
  EYE_MIN,
  eyeRimWidth,
  EYE_SIZES,
  eyeSizeOf,
  tiltedCenter,
  keepDesignerAcrossSessions,
  LONG_NAME,
  minOrbit,
  maxOrbit,
  NAME_MAX,
  parseNumberInput,
  PREVIEW_FRAME,
  RING,
  BACKDROPS,
  ZOOM_DEFAULT,
  addPlanet,
  createStar,
  fixtureDesign,
  normalizeDesign,
  previewFrame,
  radiusOf,
  ringFrontPoints,
  validateDesign,
  type CompleteDesign,
  type GalaxyDesign,
} from "./design.ts";

const WS_A = "ws-a";
const WS_B = "ws-bbbb";

/** 主星、行星都在的设计稿（不在就让测试失败） */
function complete(design: GalaxyDesign): CompleteDesign {
  const { star, planet } = design;
  assert.ok(star !== null && planet !== null, "这份设计稿应当主星、行星都在");
  return { ...design, star, planet };
}

function legal(): CompleteDesign {
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

  test("显示半径：单调、主星最小也明显大于行星最大（半径 ≥1.35 倍，面积近 2 倍）、最小的行星眼睛读得出", () => {
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
    assert.deepEqual([...ELEMENTS_OF.star], ["eyes", "ring", "corona"]);
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
      assert.equal(art.eyes, null);
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
      const elements = { eyes: (mask & 1) > 0, ring: (mask & 2) > 0, clouds: (mask & 4) > 0, moons: (mask & 8) > 0, corona: true };
      const art = bodyArt({ ...base, planet: { ...base.planet, elements } }, "planet", 30);
      assert.equal(art.eyes !== null, elements.eyes);
      assert.equal(art.ring !== null, elements.ring);
      assert.equal(art.clouds.length > 0, elements.clouds);
      assert.equal(art.moons.length > 0, elements.moons);
      assert.equal(art.corona, null);
    }
  });

  test("眼睛是两只竖向圆角胶囊：高 ≈ 宽 × 2.5（2.2–2.8）、两只一样大、整双顺时针歪约 12 度（左眼略高）、都在天体里面", () => {
    const design = legal();
    for (const r of [8, 16, 30, 80]) {
      const art = bodyArt(design, "planet", r);
      assert.ok(art.eyes !== null);
      const [left, right] = art.eyes;
      for (const eye of art.eyes) {
        const aspect = eye.h / eye.w;
        assert.ok(aspect >= 2.2 && aspect <= 2.8, `r=${r} 纵横比 ${aspect}`);
        assert.ok(eye.w >= EYE_MIN);
        const c = tiltedCenter(eye, art.eyesTilt);
        assert.ok(Math.hypot(c.x, c.y) + eye.h / 2 < r, `r=${r} 眼睛出了天体`);
      }
      assert.equal(left.w, right.w);
      assert.equal(left.h, right.h);
      assert.equal(left.x, -right.x, "没歪头时左右对称");
      assert.ok(art.eyesTilt >= 8 && art.eyesTilt <= 16, `歪头 ${art.eyesTilt} 度`);
      const lift = tiltedCenter(right, art.eyesTilt).y - tiltedCenter(left, art.eyesTilt).y;
      assert.ok(lift > 0 && lift <= 0.12 * r, `r=${r} 左眼比右眼高 ${lift}`);
    }
  });

  test("眼睛四档（s 最早的尺寸 → xl）：一档比一档大；l 档眼高约直径的 30%、两眼间距约一只眼宽；各档都守 2.2–2.8 的长宽比、在天体里、左眼略高", () => {
    const design = legal();
    const heights: number[] = [];
    for (const size of ["s", "m", "l", "xl"] as const) {
      for (const r of [8, 12, 30, 48]) {
        const art = bodyArt({ ...design, planet: { ...design.planet, eyeStyle: size } }, "planet", r);
        assert.ok(art.eyes !== null);
        const [left, right] = art.eyes;
        for (const eye of art.eyes) {
          const aspect = eye.h / eye.w;
          assert.ok(aspect >= 2.2 && aspect <= 2.8, `${size} r=${r} 纵横比 ${aspect}`);
          const c = tiltedCenter(eye, art.eyesTilt);
          // 胶囊四角（转过之后）都在天体里
          for (const [dx, dy] of [[-eye.w / 2, -eye.h / 2 + eye.w / 2], [eye.w / 2, -eye.h / 2 + eye.w / 2], [-eye.w / 2, eye.h / 2 - eye.w / 2], [eye.w / 2, eye.h / 2 - eye.w / 2]] as const) {
            assert.ok(Math.hypot(c.x + dx, c.y + dy) + eye.w / 2 < r * 0.92, `${size} r=${r} 眼睛贴到球缘`);
          }
        }
        const lift = tiltedCenter(right, art.eyesTilt).y - tiltedCenter(left, art.eyesTilt).y;
        assert.ok(lift > 0, `${size} 左眼不比右眼高`);
        if (r === 48) {
          heights.push(left.h / (2 * r));
          if (size === "l") {
            assert.ok(Math.abs(left.h / (2 * r) - 0.3) < 0.02, `l 档眼高占直径 ${(left.h / (2 * r)).toFixed(3)}`);
            const gap = right.x - left.x - left.w;
            assert.ok(Math.abs(gap / left.w - 1) < 0.15, `l 档眼距 / 眼宽 = ${(gap / left.w).toFixed(2)}`);
          }
        }
      }
    }
    for (let i = 1; i < heights.length; i++) assert.ok((heights[i] ?? 0) > (heights[i - 1] ?? 0));
    // 没设过 = 大档；亮边：s 照旧 0.45 眼宽，放大档封顶不描粗圈
    const plain = bodyArt(design, "planet", 30);
    assert.equal(plain.eyeStyle, "l");
    assert.deepEqual(plain.eyes, bodyArt({ ...design, planet: { ...design.planet, eyeStyle: "l" } }, "planet", 30).eyes);
    assert.equal(eyeRimWidth(2, 30, "s"), 0.9);
    assert.ok(eyeRimWidth(0.28 * 48, 48, "xl") <= 48 * 0.045 + 1e-9);
  });

  test("任何天体、成分、元素组合都没有嘴：形象里只有眼睛，没有 mouth / nose / blush / 四肢之类的图形", () => {
    // image 是地表贴图（无脸地表），不是五官：眼睛照旧只由 eyes 画
    const allowed = ["r", "image", "surface", "corona", "ring", "craters", "cap", "cracks", "bands", "clouds", "eyes", "eyesTilt", "eyeStyle", "moons", "extent"].sort();
    const base = defaultDesign(WS_A, "bare");
    for (let mask = 0; mask < 32; mask++) {
      const elements = { eyes: (mask & 1) > 0, ring: (mask & 2) > 0, clouds: (mask & 4) > 0, moons: (mask & 8) > 0, corona: (mask & 16) > 0 };
      for (const composition of ["rock", "ice", "gas"] as const) {
        const design = { ...base, star: { ...base.star, elements }, planet: { ...base.planet, composition, elements } };
        for (const kind of ["star", "planet"] as const) {
          const art = bodyArt(design, kind, 40);
          assert.deepEqual(Object.keys(art).sort(), allowed, `${kind} ${composition} ${mask}`);
          if (art.eyes !== null) {
            assert.equal(art.eyes.length, 2);
            for (const eye of art.eyes) assert.deepEqual(Object.keys(eye).sort(), ["h", "w", "x", "y"]);
          }
        }
      }
    }
  });

  test("画形象的组件与样式里也没有嘴：眼睛组只画 rect，源码里没有嘴 / 鼻 / 腮红 / 眉毛 / 瞳孔 / 四肢", () => {
    // 注释里写着「不画嘴」之类的说明，先剥掉注释，只查真正会渲染的代码与样式
    const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // 形象由 StarFigure.tsx 的 BodyFigure 画（面板、头像、星系共用），面板本身也一并查
    const tsx = stripComments(
      readFileSync(new URL("./StarFigure.tsx", import.meta.url), "utf8") + readFileSync(new URL("./GalaxyDesigner.tsx", import.meta.url), "utf8"),
    );
    const css = stripComments(readFileSync(new URL("./galaxy-designer.css", import.meta.url), "utf8"));
    const forbidden = /\b(mouth|smile|nose|blush|cheeks?|eyebrows?|brows?|pupils?|lashes|limbs?|arms?|legs?|antennae?)\b|嘴|鼻|腮|眉|瞳/i;
    assert.doesNotMatch(tsx, forbidden);
    assert.doesNotMatch(css, forbidden);
    const group = /className="gd-eyes"[^>]*>([\s\S]*?)<\/g>/.exec(tsx);
    assert.ok(group !== null, "找不到眼睛组");
    const inner = group[1] ?? "";
    assert.match(inner, /<rect /);
    assert.doesNotMatch(inner, /<(path|circle|ellipse|line|polyline|polygon|text)\b/);
  });

  test("眼睛近乎纯黑：明主题取主墨、两档暗主题取井色，相对亮度都 < 0.02", () => {
    const css = readFileSync(new URL("./galaxy-designer.css", import.meta.url), "utf8");
    assert.match(css, /\.gd-eye\s*\{\s*fill:\s*var\(--gd-eye\);/);
    assert.match(css, /\.gd \{[^}]*--gd-eye:\s*var\(--color-text-primary\);/);
    assert.match(css, /\[data-theme="black"\]\) \.gd \{[^}]*--gd-eye:\s*var\(--color-bg-panel\);/);
    const colors = readFileSync(new URL("../../../../../design-system/tokens/colors.css", import.meta.url), "utf8");
    const block = (selector: string): string => {
      const at = colors.indexOf(selector);
      assert.ok(at >= 0, selector);
      return colors.slice(at, colors.indexOf("}", at));
    };
    const hex = (text: string, token: string): string => {
      const m = new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`).exec(text);
      assert.ok(m !== null, token);
      return m[1] ?? "";
    };
    const luminance = (value: string): number => {
      const channel = (i: number): number => {
        const c = parseInt(value.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    const light = hex(colors, "--color-text-primary");
    const graphite = hex(block('[data-theme="graphite"]'), "--color-bg-panel");
    const black = hex(block('[data-theme="black"]'), "--color-bg-panel");
    for (const value of [light, graphite, black]) assert.ok(luminance(value) < 0.02, `${value} 亮度 ${luminance(value)}`);
  });

  test("星环前半从两眼下面绕过去：五种眼睛样式下，两眼横向范围内星环都比眼睛低", () => {
    for (const style of EYE_STYLES) {
      const geo = EYE_SIZES[eyeSizeOf(style)];
      for (const r of [16, 30, 80]) {
        const design = legal();
        const art = bodyArt({ ...design, planet: { ...design.planet, eyeStyle: style } }, "planet", r);
        assert.ok(art.eyes !== null);
        const eyesBottom = Math.max(...art.eyes.map((eye) => tiltedCenter(eye, art.eyesTilt).y + eye.h / 2));
        const front = ringFrontPoints(r, 48, geo.ringRy).filter((p) => Math.abs(p.x) <= (geo.x + geo.w) * r * 1.1);
        assert.ok(front.length > 0);
        for (const p of front) assert.ok(p.y > eyesBottom + 0.05 * r, `${style} r=${r} 环 ${p.y} 眼 ${eyesBottom}`);
      }
    }
  });

  test("纹理、云带、卫星都不压在眼睛上（五种眼睛样式）；小行星的眼睛也不小于 EYE_MIN", () => {
    const full = defaultDesign(WS_A, "full");
    const r = displayRadius(bodyRadius(PLANET_MASS.min, DENSITY.rock));
    for (const [composition, eyeStyle] of (["rock", "ice", "gas"] as const).flatMap((c) => EYE_STYLES.map((e) => [c, e] as const))) {
      const art = bodyArt({ ...full, planet: { ...full.planet, composition, mass: PLANET_MASS.min, eyeStyle } }, "planet", r);
      assert.ok(art.eyes !== null);
      // 每只眼睛 = 一条线段（胶囊的中轴，歪头后）加半宽 w/2；纹理离中轴的距离都要大于它自己的半径 + w/2
      const t = (art.eyesTilt * Math.PI) / 180;
      const segments = art.eyes.map((eye) => {
        const c = tiltedCenter(eye, art.eyesTilt);
        const half = eye.h / 2 - eye.w / 2;
        const dx = -Math.sin(t) * half;
        const dy = Math.cos(t) * half;
        return { a: { x: c.x - dx, y: c.y - dy }, b: { x: c.x + dx, y: c.y + dy }, pad: eye.w / 2 };
      });
      const distance = (p: { x: number; y: number }, seg: (typeof segments)[number]): number => {
        const vx = seg.b.x - seg.a.x;
        const vy = seg.b.y - seg.a.y;
        const k = Math.max(0, Math.min(1, ((p.x - seg.a.x) * vx + (p.y - seg.a.y) * vy) / (vx * vx + vy * vy)));
        return Math.hypot(p.x - seg.a.x - k * vx, p.y - seg.a.y - k * vy);
      };
      for (const c of art.craters) for (const seg of segments) assert.ok(distance(c, seg) > c.r + seg.pad, `crater ${JSON.stringify(c)}`);
      const top = Math.min(...segments.flatMap((seg) => [seg.a.y, seg.b.y].map((y) => y - seg.pad))) - 1;
      const bottom = Math.max(...segments.flatMap((seg) => [seg.a.y, seg.b.y].map((y) => y + seg.pad))) + 1;
      for (const band of art.bands) assert.ok(band.y + band.h < top || band.y > bottom, `band ${band.y}`);
      for (const cloud of art.clouds) assert.ok(cloud.y + cloud.h < top || cloud.y > bottom, `cloud ${cloud.y}`);
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
  test("行星默认 140%、主星默认 70%（压在网格上要露出坑四周的弯线）；三档 fixture 都按这个给", () => {
    for (const level of ["default", "bare", "full"] as const) {
      const design = defaultDesign(WS_A, level);
      assert.equal(design.planet.zoom, ZOOM_DEFAULT.planet);
      assert.equal(design.star.zoom, ZOOM_DEFAULT.star);
    }
    assert.ok(ZOOM_DEFAULT.planet > 100);
    assert.ok(ZOOM_DEFAULT.star < 100);
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
    assert.ok(art.eyes !== null);
    assert.ok(art.eyes[0].w * (ZOOM_DEFAULT.planet / 100) >= 2.5);
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
    const a = complete(store.get(WS_A));
    const b0 = store.get(WS_B);
    store.set(WS_A, { ...a, planet: { ...a.planet, mass: 33, zoom: 150 } });
    assert.equal(complete(store.get(WS_A)).planet.mass, 33);
    assert.equal(complete(store.get(WS_A)).planet.zoom, 150);
    assert.equal(complete(store.get(WS_A)).star.zoom, ZOOM_DEFAULT.star, "行星的缩放不带到主星");
    assert.equal(complete(store.get(WS_B)).planet.zoom, ZOOM_DEFAULT.planet, "A 的缩放不串到 B");
    assert.deepEqual(store.get(WS_B), b0);
    assert.deepEqual(store.reset(WS_A), defaultDesign(WS_A, "default"));
    assert.deepEqual(store.get(WS_A), defaultDesign(WS_A, "default"));
  });

  test("fixture 档从地址读：?designer=bare|full|nostar，其余是默认", () => {
    assert.equal(designLevelOf("?designer=nostar"), "nostar");
    assert.equal(designLevelOf("?designer=full"), "full");
    assert.equal(designLevelOf("?designer=bare&galaxy=full"), "bare");
    assert.equal(designLevelOf("?designer=x"), "default");
    assert.equal(designLevelOf(""), "default");
  });
});

describe("设计稿仓库：侧栏头像与页面星系跟着面板变", () => {
  test("没改过：每次返回同一个默认稿对象（快照稳定）、has 为假；改了通知订阅者、has 为真；恢复默认再通知一次；退订后不再通知", () => {
    const store = createDesignStore("default");
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    const first = store.get(WS_A);
    assert.equal(store.get(WS_A), first);
    assert.equal(store.has(WS_A), false);
    assert.ok(first.star !== null);
    store.set(WS_A, { ...first, star: { ...first.star, mass: 900 } });
    assert.equal(calls, 1);
    assert.equal(store.has(WS_A), true);
    assert.equal(store.get(WS_A).star?.mass, 900);
    assert.equal(store.has(WS_B), false);
    assert.equal(store.reset(WS_A), first);
    assert.equal(calls, 2);
    assert.equal(store.has(WS_A), false);
    off();
    store.set(WS_A, first);
    assert.equal(calls, 2);
  });
});

describe("打开面板默认是主星（主智能体本人）", () => {
  test("三档默认稿、种子稿都停在主星页；只有 addPlanet 才把页切到行星", () => {
    for (const level of ["default", "bare", "full"] as const) assert.equal(defaultDesign(WS_A, level).editing, "star");
    assert.equal(seededDesign(WS_B).editing, "star");
    assert.equal(createDesignStore("default").get(WS_A).editing, "star");
  });
});

describe("行星依赖主星（数据层不变量）", () => {
  test("nostar 档：没有主星也没有行星，停在主星页；没有任何参数错误", () => {
    const empty = fixtureDesign(WS_A, "nostar");
    assert.equal(empty.star, null);
    assert.equal(empty.planet, null);
    assert.equal(empty.editing, "star");
    assert.deepEqual(validateDesign(empty), []);
    assert.deepEqual(previewPlan(empty), ["flat-well"]);
    assert.deepEqual(previewPlan({ ...empty, editing: "planet" }), ["flat-well"], "行星页也只有平网格，没有头像");
  });

  test("没有主星时加行星被拒绝（不只是按钮置灰）；先创建主星再加就行", () => {
    const empty = fixtureDesign(WS_A, "nostar");
    assert.deepEqual(addPlanet(empty, WS_A), { ok: false, reason: "no-star" });
    const withStar = createStar(empty);
    assert.notEqual(withStar.star, null);
    assert.equal(withStar.planet, null, "创建主星不会顺手塞一颗行星");
    assert.equal(withStar.editing, "star");
    const added = addPlanet(withStar, WS_A);
    assert.ok(added.ok);
    assert.notEqual(added.design.planet, null);
    assert.equal(added.design.editing, "planet");
    assert.deepEqual(validateDesign(added.design), []);
    assert.equal(createStar(added.design).star, added.design.star, "已有主星时 createStar 不换掉它");
  });

  test("有行星没主星的数据：validateDesign 报 planet-without-star，normalizeDesign 与仓库都把行星拿掉", () => {
    const broken: GalaxyDesign = { ...legal(), star: null };
    assert.ok(validateDesign(broken).some((error) => error.kind === "planet-without-star"));
    assert.equal(normalizeDesign(broken).planet, null);
    const ok = legal();
    assert.equal(normalizeDesign(ok), ok, "合规的原样返回");
    const store = createDesignStore("default");
    store.set(WS_A, broken);
    assert.equal(store.get(WS_A).planet, null);
    assert.equal(store.get(WS_A).star, null);
  });

  test("主星页 / 行星页两态：有主星时主星页画网格 + 主星，行星页同时有大头像与轨道；有主星没行星时只有轨道场景", () => {
    const design = legal();
    assert.deepEqual(previewPlan({ ...design, editing: "star" }), ["well", "star"]);
    assert.deepEqual(previewPlan({ ...design, editing: "planet" }), ["avatar", "orbit-scene", "orbit"]);
    assert.deepEqual(previewPlan({ ...design, editing: "planet", planet: null }), ["orbit-scene"]);
    assert.equal(orbitStage({ ...design, star: null, planet: null }), null);
  });

  test("没有主星时半径、轨道上下限都是 NaN（面板显示「—」），bodyArt 不画不存在的天体", () => {
    const empty = fixtureDesign(WS_A, "nostar");
    assert.ok(Number.isNaN(radiusOf(empty, "star")));
    assert.ok(Number.isNaN(minOrbit(empty)));
    assert.throws(() => bodyArt(empty, "planet", 20));
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

  test("主槽换工作区：面板开着就跟过去；关着不动；换到无工作区的任务收起", () => {
    const open = { panel: "galaxy" as const, target: WS_A };
    assert.deepEqual(designerFollow(open, WS_B), { panel: "galaxy", target: WS_B });
    assert.deepEqual(designerFollow(open, null), { panel: null, target: WS_A }, "换到星际空间：收起");
    assert.equal(designerFollow(open, WS_A), open);
    const closed = { panel: null, target: WS_A };
    assert.equal(designerFollow(closed, WS_B), closed);
    const files = { panel: "files" as const, target: WS_A };
    assert.equal(designerFollow(files, WS_B), files);
  });

  test("切会话：设计面板开着、目标会话没记过面板就留着；记过别的面板照记忆换", () => {
    assert.equal(keepDesignerAcrossSessions("galaxy", null), "galaxy");
    assert.equal(keepDesignerAcrossSessions("galaxy", "files"), "files");
    assert.equal(keepDesignerAcrossSessions("orchestra", null), "orchestra", "编排面板也是工作区级：点开树上的会话不收掉它");
    assert.equal(keepDesignerAcrossSessions("orchestra", "review"), "review");
    assert.equal(keepDesignerAcrossSessions("files", null), null);
    assert.equal(keepDesignerAcrossSessions("files", null), null);
    assert.equal(keepDesignerAcrossSessions(null, "review"), "review");
  });
});

describe("seededDesign —— 没设计过的工作区的种子默认（头像各不相同）", () => {
  const ids = Array.from({ length: 500 }, (_, i) => `ws-${i}-${(i * 2654435761) % 99991}`);

  test("同一个 id 永远同一套；不同 id 之间有差异", () => {
    assert.deepEqual(seededDesign(ids[0] ?? ""), seededDesign(ids[0] ?? ""));
    const looks = new Set(ids.map((id) => JSON.stringify([seededDesign(id).star.mass, seededDesign(id).star.elements])));
    assert.ok(looks.size >= 24, `500 个 id 只有 ${looks.size} 种外观`);
    // 12 个工作区：大多数互不相同（散开，不要求全不同）
    const twelve = new Set(ids.slice(0, 12).map((id) => JSON.stringify(seededDesign(id).star)));
    assert.ok(twelve.size >= 9, `12 个里只有 ${twelve.size} 种`);
  });

  test("不违反引力语法与面板校验：质量在区间内、主星远大于行星、轨道合法、眼睛恒开、不带名字", () => {
    for (const id of ids) {
      for (const level of ["default", "bare"] as const) {
        const design = seededDesign(id, level);
        if (level === "default") assert.deepEqual(validateDesign(design), [], id);
        assert.ok(design.star.mass >= STAR_MASS.min && design.star.mass <= STAR_MASS.max);
        assert.ok(design.planet.mass >= PLANET_MASS.min && design.planet.mass <= PLANET_MASS.max);
        assert.ok(radiusOf(design, "star") > radiusOf(design, "planet") * 1.5, id);
        assert.equal(design.star.name, "");
        if (level === "default") assert.equal(design.star.elements.eyes, true);
      }
    }
  });

  test("质量只取 STAR_MASS_STEPS 档整百；星环 / 日冕两个开关都会出现开与关", () => {
    const masses = new Set(ids.map((id) => seededDesign(id).star.mass));
    assert.equal(masses.size, STAR_MASS_STEPS);
    for (const key of ["ring", "corona"] as const) {
      const states = new Set(ids.map((id) => seededDesign(id).star.elements[key]));
      assert.equal(states.size, 2, key);
    }
  });

  test("仓库开了 seeded：没改过的工作区返回种子稿（快照稳定）；恢复默认回到种子稿；没开 seeded 仍是原默认稿", () => {
    const store = createDesignStore("default", { seeded: true });
    const first = store.get(WS_A);
    assert.equal(store.get(WS_A), first);
    assert.deepEqual(first, seededDesign(WS_A, "default"));
    store.set(WS_A, { ...first, star: { ...first.star, mass: 300 } });
    assert.equal(store.has(WS_A), true);
    assert.deepEqual(store.reset(WS_A), seededDesign(WS_A, "default"));
    assert.deepEqual(createDesignStore("default").get(WS_A), defaultDesign(WS_A, "default"));
  });

  test("seeded 可以是函数：refresh 丢掉缓存的默认稿并通知，之后按新的开关取；设计过的稿不受影响", () => {
    let on = true;
    const store = createDesignStore("default", { seeded: () => on });
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    assert.deepEqual(store.get(WS_A), seededDesign(WS_A, "default"));
    const starB = store.get(WS_B).star;
    assert.ok(starB !== null);
    store.set(WS_B, { ...store.get(WS_B), star: { ...starB, mass: 999 } });
    on = false;
    store.refresh();
    assert.equal(calls, 2);
    assert.deepEqual(store.get(WS_A), defaultDesign(WS_A, "default"));
    assert.equal(store.get(WS_B).star?.mass, 999);
  });
});

describe("avatarScale —— 头像大小跟质量走", () => {
  test("单调、两端取 AVATAR_SCALE 的 min / max、区间外夹住", () => {
    assert.equal(avatarScale(STAR_MASS.min), AVATAR_SCALE.min);
    assert.equal(avatarScale(STAR_MASS.max), AVATAR_SCALE.max);
    assert.equal(avatarScale(1), AVATAR_SCALE.min);
    assert.equal(avatarScale(99999), AVATAR_SCALE.max);
    let prev = 0;
    for (let m = STAR_MASS.min; m <= STAR_MASS.max; m += 50) {
      const v = avatarScale(m);
      assert.ok(v >= prev);
      prev = v;
    }
  });
});

describe("starExtentRatio —— 主星外缘", () => {
  test("元素都关 = 1；日冕 1.32；星环 RING.rx（取最大）", () => {
    const d = defaultDesign(WS_A, "default");
    const off = { ...d, star: { ...d.star, elements: { ...d.star.elements, ring: false, corona: false } } };
    assert.equal(starExtentRatio(off), 1);
    assert.equal(starExtentRatio({ ...off, star: { ...off.star, elements: { ...off.star.elements, corona: true } } }), 1.32);
    assert.equal(starExtentRatio({ ...off, star: { ...off.star, elements: { ...off.star.elements, ring: true, corona: true } } }), RING.rx);
  });
});

describe("storyLineOf —— 设计面板里的故事只留第一句", () => {
  test("破折号之后的展开不要，取第一个句号前", () => {
    assert.equal(storyLineOf("烛霓的橙红云带里流转着霓虹风暴——任何一句含混的意图飘进它的大气，都会被拆开。第二句。"), "烛霓的橙红云带里流转着霓虹风暴");
    assert.equal(storyLineOf("一颗安静的冰质卫星。它记得每一件交过的活。"), "一颗安静的冰质卫星。");
    assert.equal(storyLineOf("  没有标点  "), "没有标点");
    assert.equal(storyLineOf(""), "");
  });
});
