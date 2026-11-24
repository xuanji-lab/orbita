import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanetStore, insidePlanetDir } from "./store.ts";
import { sphereCrop } from "./sphere.ts";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "orbita-planet-"));
}

const fakeSurface = async (path: string): Promise<string | null> => (path.endsWith(".png") ? `data:${path.split("/").pop()}` : null);

describe("PlanetStore：读工作区 planet/", () => {
  it("两份文件都没有 → null（界面回退种子稿）", async () => {
    const dir = await workspace();
    assert.equal(await new PlanetStore(fakeSurface).read(dir), null);
    await rm(dir, { recursive: true });
  });

  it("插件稿 + 伴随文件：主星名字质量取插件稿，行星从伴随文件的名单与各自的插件稿来", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "planet", "agents", "rec"), { recursive: true });
    await writeFile(join(dir, "planet", "design.json"), JSON.stringify({ name: "烛霓", mass: { value: 60, unit: "M⊕" }, density: { value: 1326 }, story: "故事" }));
    await writeFile(join(dir, "planet", "agents", "rec", "design.json"), JSON.stringify({ name: "聆箴", mass: { value: 2.2, unit: "M⊕" }, density: { value: 3934 } }));
    await writeFile(
      join(dir, "planet", "galaxy.json"),
      JSON.stringify({
        version: 1,
        main: { surface: "surface.png", flip: true, name: "被插件稿盖掉" },
        planets: [{ id: "rec", design: "agents/rec/design.json", surface: "agents/rec/surface.png", orbit: 19 }, { id: "bad", surface: "../../x.png" }],
      }),
    );
    const read = await new PlanetStore(fakeSurface).read(dir);
    assert.equal(read?.main?.name, "烛霓");
    assert.equal(read?.main?.massEarth, 60);
    assert.equal(read?.main?.surface, "data:surface.png");
    assert.equal(read?.main?.flip, true);
    assert.equal(read?.main?.note, "故事");
    assert.deepEqual(
      read?.planets.map((p) => [p.id, p.name, p.massEarth, p.composition, p.orbit, p.surface]),
      [
        ["rec", "聆箴", 2.2, "rock", 19, "data:surface.png"],
        ["bad", "", null, null, null, null],
      ],
    );
    await rm(dir, { recursive: true });
  });

  it("坏 JSON 不抛：当没有，并记一条警告", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "planet"));
    await writeFile(join(dir, "planet", "design.json"), "{ 半截");
    await writeFile(join(dir, "planet", "galaxy.json"), JSON.stringify({ main: { name: "伴随", massEarth: 40 } }));
    const read = await new PlanetStore(fakeSurface).read(dir);
    assert.equal(read?.main?.name, "伴随");
    assert.equal(read?.main?.massEarth, 40);
    assert.ok(read?.warnings.some((w) => w.includes("design.json")));
    await rm(dir, { recursive: true });
  });
});

describe("PlanetStore：写回", () => {
  it("改了主星质量：插件稿 mass 改掉、其余字段原样；伴随文件记元素与轨道；再读回来是新值", async () => {
    const dir = await workspace();
    await mkdir(join(dir, "planet", "agents", "rec"), { recursive: true });
    await writeFile(join(dir, "planet", "design.json"), JSON.stringify({ name: "烛霓", mass: { value: 60, unit: "M⊕" }, density: { value: 1326 }, status: "已确认" }));
    await writeFile(join(dir, "planet", "agents", "rec", "design.json"), JSON.stringify({ name: "聆箴", mass: { value: 2.2, unit: "M⊕" } }));
    await writeFile(join(dir, "planet", "galaxy.json"), JSON.stringify({ main: { surface: "surface.png" }, planets: [{ id: "rec", design: "agents/rec/design.json" }] }));
    const store = new PlanetStore(fakeSurface);
    await store.write(dir, {
      main: { id: "main", name: "烛霓", massEarth: 75, composition: null, orbit: null, elements: { eyes: true, ring: true } },
      planets: [{ id: "rec", name: "聆箴", massEarth: 3, composition: "rock", orbit: 26, elements: { eyes: true } }],
    });
    const design = JSON.parse(await readFile(join(dir, "planet", "design.json"), "utf8")) as { mass: { value: number }; status: string };
    assert.equal(design.mass.value, 75);
    assert.equal(design.status, "已确认");
    const read = await store.read(dir);
    assert.equal(read?.main?.massEarth, 75);
    assert.equal(read?.main?.elements?.ring, true);
    assert.equal(read?.main?.surface, "data:surface.png");
    assert.equal(read?.planets[0]?.massEarth, 3);
    assert.equal(read?.planets[0]?.orbit, 26);
    await rm(dir, { recursive: true });
  });

  it("没有 planet/ 的工作区：面板一改就建出伴随文件，名字质量记在里面", async () => {
    const dir = await workspace();
    const store = new PlanetStore(fakeSurface);
    await store.write(dir, { main: { id: "main", name: "", massEarth: 62, composition: null, orbit: null, elements: { eyes: true } }, planets: [] });
    const read = await store.read(dir);
    assert.equal(read?.main?.massEarth, 62);
    await rm(dir, { recursive: true });
  });

  it("眼睛样式：写进 planet/galaxy.json，再读回来；下次写不带样式时原值保留；没设过读回 null", async () => {
    const dir = await workspace();
    const store = new PlanetStore(fakeSurface);
    const main = { id: "main", name: "", massEarth: 62, composition: null, orbit: null, elements: { eyes: true } };
    const rec = { id: "rec", name: "聆箴", massEarth: 3, composition: "rock" as const, orbit: 26, elements: { eyes: true } };
    await store.write(dir, { main: { ...main, eyeStyle: "xl-white" }, planets: [rec] });
    const raw = JSON.parse(await readFile(join(dir, "planet", "galaxy.json"), "utf8")) as { main: { eyeStyle?: string } };
    assert.equal(raw.main.eyeStyle, "xl-white");
    let read = await store.read(dir);
    assert.equal(read?.main?.eyeStyle, "xl-white");
    assert.equal(read?.planets[0]?.eyeStyle, null);
    await store.write(dir, { main, planets: [{ ...rec, eyeStyle: "m" }] });
    read = await store.read(dir);
    assert.equal(read?.main?.eyeStyle, "xl-white");
    assert.equal(read?.planets[0]?.eyeStyle, "m");
    await rm(dir, { recursive: true });
  });

  it("元素构成：写进 planet/galaxy.json 再读回；写回不带 mix 时原值保留；伴随文件没有时为 null，不从插件稿的元素项导入", async () => {
    const dir = await workspace();
    const store = new PlanetStore(fakeSurface);
    await mkdir(join(dir, "planet", "agents", "gas"), { recursive: true });
    await writeFile(
      join(dir, "planet", "agents", "gas", "design.json"),
      JSON.stringify({
        name: "银珀",
        seed: 897642,
        compositionItems: [
          { id: "H", kindKey: "element", scope: "大气", basis: "volume_fraction", share: 0.287 },
          { id: "H2", kindKey: "molecule", scope: "大气", basis: "volume_fraction", share: 0.9 },
          { id: "Fe", kindKey: "element", scope: "整体", basis: "mass_fraction", share: null },
        ],
      }),
    );
    await writeFile(join(dir, "planet", "galaxy.json"), JSON.stringify({ version: 1, main: {}, planets: [{ id: "gas", design: "agents/gas/design.json" }] }));
    let read = await store.read(dir);
    assert.equal(read?.planets[0]?.mix, null, "插件稿的元素项只是一部分，不当整体构成");
    const main = { id: "main", name: "", massEarth: 62, composition: null, orbit: null, elements: { eyes: true } };
    const mix = { seed: 7, items: [{ id: "O", kind: "element" as const, scope: "bulk" as const, basis: "mass_fraction" as const, share: 0.4, origin: "user" as const, placed: true as const }] };
    const gas = { id: "gas", name: "银珀", massEarth: 1.6, composition: "ice" as const, orbit: 30, elements: { eyes: true } };
    await store.write(dir, { main, planets: [{ ...gas, mix }] });
    const raw = JSON.parse(await readFile(join(dir, "planet", "galaxy.json"), "utf8")) as { planets: { mix?: unknown }[] };
    assert.deepEqual(raw.planets[0]?.mix, mix);
    await store.write(dir, { main, planets: [gas] });
    read = await store.read(dir);
    assert.deepEqual(read?.planets[0]?.mix, mix, "不带 mix 的写回不抹掉原来的构成");
    await rm(dir, { recursive: true });
  });

    it("路径越界判定", () => {
    assert.equal(insidePlanetDir("/w", "a/b.png"), "/w/planet/a/b.png");
    assert.equal(insidePlanetDir("/w", "../x.png"), null);
  });
});

describe("sphereCrop：从透明底里抠出球", () => {
  const paint = (w: number, h: number, cx: number, cy: number, r: number): Uint8Array => {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) out[(y * w + x) * 4 + 3] = 255;
    return out;
  };
  it("偏左下的球：裁成以球心为心、球径为边的正方形", () => {
    const box = sphereCrop(paint(100, 100, 40, 60, 30), 100, 100);
    assert.ok(Math.abs(box.x - 10) <= 1 && Math.abs(box.y - 30) <= 1 && Math.abs(box.size - 60) <= 1, JSON.stringify(box));
  });
  it("自带星环（横向伸出去）的球：按短边取，球填满正方形", () => {
    const img = paint(200, 200, 100, 100, 60);
    for (let x = 10; x < 190; x++) for (const y of [99, 100, 101]) img[(y * 200 + x) * 4 + 3] = 255;
    const box = sphereCrop(img, 200, 200);
    assert.ok(Math.abs(box.size - 120) <= 1 && Math.abs(box.x - 40) <= 1 && Math.abs(box.y - 40) <= 1, JSON.stringify(box));
  });
  it("孤立噪点不算；全透明 / 全不透明不裁", () => {
    const img = paint(100, 100, 50, 50, 20);
    img[3] = 255;
    const box = sphereCrop(img, 100, 100);
    assert.ok(box.size <= 41, JSON.stringify(box));
    assert.deepEqual(sphereCrop(new Uint8Array(400), 10, 10), { x: 0, y: 0, size: 10 });
    assert.deepEqual(sphereCrop(new Uint8Array(400).fill(255), 10, 10), { x: 0, y: 0, size: 10 });
  });
});
