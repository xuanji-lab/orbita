import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DENSITY, planetRadius } from "../chat/galaxy.ts";
import { agentInputsOf, defaultDesign, mixOf, planetsWriteOf, radiusOf, withMix } from "./design.ts";
import { ELEMENTS, ELEMENT_BY_SYMBOL } from "./elements.ts";
import {
  classOfDensity,
  clearShare,
  colorNameOf,
  defaultPlacement,
  legacyMix,
  mixColor,
  mixPhysics,
  placeItem,
  planetDensity,
  reseed,
  resolveMix,
  setShare,
  shuffleMix,
  starDefaultMix,
  templateMix,
  toggleElement,
  type BodyClass,
} from "./mix.ts";
import type { PlanetMix } from "@shared/planet-design";

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

describe("元素目录", () => {
  test("符号唯一、原子序数递增、族 1–18、周期 1–6；常见元素都有一句科普", () => {
    const symbols = new Set(ELEMENTS.map((e) => e.symbol));
    assert.equal(symbols.size, ELEMENTS.length);
    for (let i = 1; i < ELEMENTS.length; i++) assert.ok((ELEMENTS[i]?.z ?? 0) > (ELEMENTS[i - 1]?.z ?? 0));
    for (const e of ELEMENTS) {
      assert.ok(e.group >= 1 && e.group <= 18 && e.period >= 1 && e.period <= 6, e.symbol);
      if (e.common) assert.ok(typeof e.note === "string" && e.note.length > 0, `${e.symbol} 缺科普`);
    }
    assert.equal(ELEMENT_BY_SYMBOL.get("Fe")?.zh, "铁");
    assert.equal(ELEMENT_BY_SYMBOL.get("Ne")?.phase, "gas");
  });
});

describe("旧稿映射与密度推算", () => {
  test("三类旧稿映射成的构成，推出来的密度与原来的 5.5 / 2 / 1.3 g/cm³ 相差 < 0.5%，归类不变", () => {
    for (const cls of ["rock", "ice", "gas"] as const) {
      const physics = mixPhysics(legacyMix(cls, 1));
      assert.ok(physics !== null);
      assert.ok(near(physics.density, DENSITY[cls], DENSITY[cls] * 0.005), `${cls}: ${physics.density}`);
      assert.equal(classOfDensity(physics.density), cls);
      const sum = Object.values(physics.reservoirs).reduce((s, v) => s + v, 0);
      assert.ok(near(sum, 1, 1e-9));
    }
  });

  test("加铁变重、加氢变轻：密度随构成单调地走", () => {
    const rock = legacyMix("rock", 1);
    const base = mixPhysics(rock)?.density ?? 0;
    const iron = setShare(rock, 0, 0.6);
    assert.ok((mixPhysics(iron)?.density ?? 0) > base);
    const wet = toggleElement(rock, "H", "rock", 24);
    const h = wet.items.findIndex((item) => item.id === "H");
    assert.ok((mixPhysics(setShare(wet, h, 0.3))?.density ?? 99) < base);
  });

  test("没有整体·质量这一组时不推密度，按成分类别取", () => {
    const air: PlanetMix = { seed: 1, items: [{ id: "N", kind: "element", scope: "atmosphere", basis: "volume_fraction", share: 0.78, origin: "user" }] };
    assert.equal(mixPhysics(air), null);
    assert.equal(planetDensity({ composition: "ice", mix: air }), DENSITY.ice);
    assert.equal(planetDensity({ composition: "ice" }), DENSITY.ice);
  });
});

describe("滑块：同一层同一口径里联动，合计 ≤ 100%", () => {
  test("拖一项到 80%：同组其他定了数的按比例让，别的组不动；拖的那项变「你定的」", () => {
    let mix = legacyMix("rock", 1);
    mix = toggleElement(mix, "N", "rock", 24);
    const n = mix.items.findIndex((item) => item.id === "N");
    mix = placeItem(mix, n, "atmosphere", "volume_fraction");
    mix = setShare(mix, n, 0.78);
    const next = setShare(mix, 0, 0.8);
    const groups = resolveMix(next).groups;
    const bulk = groups.find((g) => g.key === "bulk|mass_fraction");
    assert.ok(bulk !== undefined && near(bulk.setTotal, 1, 1e-9));
    assert.ok(near(bulk.items[0]?.value ?? 0, 0.8, 1e-9));
    assert.equal(next.items[0]?.origin, "user");
    assert.equal(next.items[1]?.origin, "default", "被挤的项来源不变");
    const air = groups.find((g) => g.key === "atmosphere|volume_fraction");
    assert.ok(near(air?.items[0]?.value ?? 0, 0.78, 1e-9), "大气组不受整体组影响");
    for (const g of groups) assert.ok(g.items.reduce((s, item) => s + item.value, 0) <= 1 + 1e-9);
  });

  test("留空和 0% 是两回事：0 就是 0；留空按种子分剩下的，同种子同结果，换一版换结果", () => {
    let mix: PlanetMix = { seed: 42, items: [] };
    for (const symbol of ["Fe", "Si", "O"]) mix = toggleElement(mix, symbol, "rock", 24);
    mix = setShare(mix, 0, 0.5);
    mix = setShare(mix, 1, 0);
    const a = resolveMix(mix).items;
    assert.equal(a[1]?.value, 0);
    assert.equal(a[1]?.source, "user");
    assert.ok(near(a[2]?.value ?? 0, 0.5, 1e-9), "唯一的留空项拿走剩下的 50%");
    assert.equal(a[2]?.source, "random");
    mix = toggleElement(mix, "Mg", "rock", 24);
    const one = resolveMix(mix).items.map((item) => item.value);
    assert.deepEqual(resolveMix(mix).items.map((item) => item.value), one, "同一个种子同一个结果");
    const two = resolveMix(reseed(mix)).items.map((item) => item.value);
    assert.notDeepEqual(two, one, "换一版：留空项重新分");
    assert.deepEqual(two.slice(0, 2), one.slice(0, 2), "定了数的不动");
    const cleared = resolveMix(clearShare(mix, 1)).items[1];
    assert.equal(cleared?.source, "random");
  });

  test("没有留空项时剩下的记为「其余」，不硬凑到 100%", () => {
    let mix: PlanetMix = { seed: 1, items: [] };
    mix = toggleElement(mix, "Fe", "rock", 24);
    mix = setShare(mix, 0, 0.3);
    const group = resolveMix(mix).groups[0];
    assert.ok(group !== undefined && near(group.rest, 0.7, 1e-9));
  });
});

describe("默认放法、增删、换层", () => {
  test("惰性气体进大气·体积；气态行星的氢碳氮氧进大气·体积；其余整体·质量", () => {
    assert.deepEqual(defaultPlacement("Ar", "rock"), { scope: "atmosphere", basis: "volume_fraction" });
    assert.deepEqual(defaultPlacement("H", "gas"), { scope: "atmosphere", basis: "volume_fraction" });
    assert.deepEqual(defaultPlacement("H", "rock"), { scope: "bulk", basis: "mass_fraction" });
    assert.deepEqual(defaultPlacement("Fe", "gas"), { scope: "bulk", basis: "mass_fraction" });
  });

  test("周期表点一下加、再点一下拿掉；上限挡住；换到已有同一元素的组不换", () => {
    let mix: PlanetMix = { seed: 1, items: [] };
    mix = toggleElement(mix, "Fe", "rock", 2);
    mix = toggleElement(mix, "O", "rock", 2);
    assert.equal(toggleElement(mix, "Si", "rock", 2).items.length, 2);
    assert.equal(toggleElement(mix, "Fe", "rock", 2).items.length, 1);
    assert.equal(toggleElement(mix, "Xx", "rock", 9).items.length, 2, "不认识的符号不加");
    const moved = placeItem(mix, 0, "surface", "volume_fraction");
    assert.equal(moved.items[0]?.placed, true);
  });
});

describe("颜色提示", () => {
  test("铁锈色的表面读成红，硫黄读成黄，只有整体里的硅酸盐读成灰", () => {
    const surface = (id: string): PlanetMix => ({ seed: 1, items: [{ id, kind: "element", scope: "surface", basis: "volume_fraction", share: 0.6, origin: "user" }] });
    const fe = mixColor(surface("Fe"));
    const s = mixColor(surface("S"));
    assert.ok(fe !== null && s !== null);
    assert.equal(colorNameOf(fe), "red");
    assert.equal(colorNameOf(s), "yellow");
    const si: PlanetMix = { seed: 1, items: [{ id: "Si", kind: "element", scope: "bulk", basis: "mass_fraction", share: 1, origin: "user" }] };
    const grey = mixColor(si);
    assert.ok(grey !== null && ["gray", "pale", "orange"].includes(colorNameOf(grey)));
    assert.equal(mixColor({ seed: 1, items: [] }), null);
  });
});

describe("接到质量 + 成分 → 半径这条路上", () => {
  test("旧稿（没有构成）半径一点不变；改了构成，类别与半径跟着密度走，写回带上构成，星系也拿到密度", () => {
    const d = defaultDesign("ws-a", "default");
    const planet = { ...d.planet, composition: "rock" as const };
    assert.equal(radiusOf({ ...d, planet }, "planet"), planetRadius(planet));
    assert.equal(agentInputsOf([planet])[0]?.density, undefined, "旧稿不带密度");
    // 换成以氢氦为主：密度掉到 1.3 附近，归成气态，半径变大
    let mix = mixOf(planet);
    for (const id of ["Fe", "O", "Si", "Mg", "S", "Ni", "Ca", "Al"]) mix = toggleElement(mix, id, "rock", 24);
    for (const id of ["H", "He"]) mix = toggleElement(mix, id, "rock", 24);
    mix = placeItem(mix, 1, "bulk", "mass_fraction");
    mix = setShare(setShare(mix, 0, 0.75), 1, 0.25);
    const gassy = withMix(planet, mix);
    assert.equal(gassy.composition, "gas");
    assert.ok(radiusOf({ ...d, planet: gassy }, "planet") > radiusOf({ ...d, planet }, "planet") * 1.4);
    assert.ok(near(agentInputsOf([gassy])[0]?.density ?? 0, 1.3, 0.05));
    const request = planetsWriteOf("ws-a", { ...d, planet: gassy, planets: [gassy], planetIndex: 0 });
    assert.deepEqual(request.planets[0]?.mix, mix);
  });
});

describe("随机一版（shuffle）", () => {
  const sums = (mix: PlanetMix): number[] => resolveMix(mix).groups.map((g) => g.items.reduce((s, item) => s + (item.share ?? 0), 0));
  const bulkOf = (mix: PlanetMix): Map<string, number> =>
    new Map(mix.items.filter((item) => item.scope === "bulk" && item.basis === "mass_fraction").map((item) => [item.id, item.share ?? 0]));

  test("同种子同结果；每点一次换种子、换一版；种子由上一个推出来", () => {
    const base = legacyMix("rock", 123);
    const a = shuffleMix(base, "rock");
    const b = shuffleMix(base, "rock");
    assert.deepEqual(a, b);
    const c = shuffleMix(a, "rock");
    assert.notEqual(c.seed, a.seed);
    assert.notDeepEqual(c.items, a.items);
  });

  test("每种天体类型的结果合理，每组合计 ≤ 100%（且主组接近 100%），值的来源都是「随机」", () => {
    for (const cls of ["rock", "ice", "gas", "star"] as BodyClass[]) {
      for (let seed = 1; seed <= 40; seed++) {
        const items = templateMix(cls, seed * 7919);
        const mix: PlanetMix = { seed, items };
        for (const total of sums(mix)) assert.ok(total <= 1 + 1e-9 && total > 0.99, `${cls} ${seed}: ${total}`);
        assert.ok(items.every((item) => item.origin === "random" && item.share !== null));
        const bulk = bulkOf(mix);
        const top = [...bulk.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([id]) => id).sort();
        if (cls === "gas" || cls === "star") assert.deepEqual(top, ["H", "He"], `${cls} 以 H、He 为主`);
        if (cls === "rock") {
          assert.ok(["Fe", "O"].includes(top[0] ?? "") && ["Fe", "O"].includes(top[1] ?? ""), `岩质以 O、Fe 打头：${top}`);
          for (const id of ["Si", "Mg"]) assert.ok((bulk.get(id) ?? 0) > 0.1, `岩质有 ${id}`);
        }
        if (cls === "ice") {
          assert.equal([...bulk.entries()].sort((x, y) => y[1] - x[1])[0]?.[0], "O");
          for (const id of ["H", "C", "N"]) assert.ok((bulk.get(id) ?? 0) > 0, `冰质含 ${id}`);
        }
        const physics = mixPhysics(mix);
        if (cls !== "star") assert.equal(classOfDensity(physics?.density ?? 0), cls, `${cls} 推出来的密度归回同一类`);
      }
    }
  });

  test("你定的值原样保留（连层与口径），其余随机；同组合计仍 ≤ 100%；按住 ⌥ 全部重来", () => {
    let mix = legacyMix("rock", 5);
    mix = setShare(mix, 0, 0.5); // Fe 50%，你定的
    mix = toggleElement(mix, "Xe", "rock", 24); // 加了没定数
    const next = shuffleMix(mix, "rock");
    const fe = next.items.find((item) => item.id === "Fe" && item.scope === "bulk");
    assert.deepEqual(fe, mix.items[0]);
    assert.ok(next.items.some((item) => item.id === "Xe" && item.origin === "random" && item.share !== null), "加了没定数的元素留着、给一个随机值");
    for (const total of sums(next)) assert.ok(total <= 1 + 1e-9);
    assert.ok(next.items.filter((item) => item !== fe).every((item) => item.origin === "random"));
    const all = shuffleMix(mix, "rock", "all");
    assert.ok(all.items.every((item) => item.origin === "random"));
    assert.ok(!all.items.some((item) => item.id === "Xe"));
  });

  test("主星默认构成以 H、He 为主", () => {
    const top = [...bulkOf(starDefaultMix(1)).entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([id]) => id);
    assert.deepEqual(top, ["H", "He"]);
  });
});
