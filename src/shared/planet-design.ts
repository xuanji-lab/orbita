/**
 * 工作区的星系设计稿落盘（四层契约第 1 层）：真源放在工作区文件夹里的 `planet/`，与插件「行星造物」（planet-forge）同一份——
 * 插件写、界面读，界面里改了再写回去。
 *
 * 盘上两份文件：
 * - `planet/design.json`：插件的设计稿（build_design.py --output 写出来的格式，主星 = 这个工作区的主智能体）。
 *   界面只读其中的 name、mass、density，写回时也只改 name 与 mass（连带按密度重算 radius），其余字段原样保留；
 * - `planet/galaxy.json`：伴随文件（本文件定义，界面拥有）。插件格式里没有的东西放这里——
 *   子智能体名单（每颗行星指向它自己的一份插件格式设计稿）、无脸地表图（眼睛 / 星环 / 日冕由代码画，所以必须是无脸的）、
 *   轨道半径、元素开关、地表是否上下翻转。插件格式只描述「一颗星」，描述不了「一座星系」，所以不往插件稿里塞字段。
 * 两份都有的字段（名字、质量）以插件稿为准；没有插件稿时伴随文件自己记。
 *
 * 质量单位：盘上一律是 M⊕（插件的单位）；界面星系的质量单位 = M⊕ × 10（galaxy.ts 的 STAR_MASS 300–1000 ↔ 30–100 M⊕），换算在 renderer。
 */

export const PLANET_DIR = "planet";
export const PLANET_DESIGN_FILE = "design.json";
export const PLANET_GALAXY_FILE = "galaxy.json";
export const PLANET_GALAXY_VERSION = 1;
/** 一座星系最多读几颗子智能体（galaxy.ts 的 VISIBLE_ORBIT_CAP 是 6；多读两颗给面板，星系里照样只画 6 圈） */
export const PLANET_AGENTS_MAX = 8;

export type PlanetComposition = "rock" | "ice" | "gas";
export type PlanetElementKey = "eyes" | "ring" | "clouds" | "moons" | "corona";
export type PlanetElements = Partial<Record<PlanetElementKey, boolean>>;

/** 读回来的一颗天体（主星或一颗子智能体行星） */
export interface PlanetBody {
  /** 主星恒为 "main"；行星是伴随文件里的 id */
  id: string;
  name: string;
  /** M⊕；读不到为 null（界面回退到种子稿的质量） */
  massEarth: number | null;
  /** 行星的成分；主星恒为 null（主星成分固定） */
  composition: PlanetComposition | null;
  /** 行星的职责 / 主星的一句故事（只显示，不参与计算） */
  note: string | null;
  /** 无脸地表：主进程裁成球、缩到小图后的 data URL；没有图为 null（界面照旧代码画纹理） */
  surface: string | null;
  /** 地表上下翻转（地表上的椭圆风暴落在眼睛下方会被读成嘴，翻上去） */
  flip: boolean;
  /** 轨道半径（界面星系单位）；主星与没指定的为 null */
  orbit: number | null;
  elements: PlanetElements | null;
}

export interface WorkspacePlanets {
  main: PlanetBody | null;
  planets: PlanetBody[];
  /** 读的过程中跳过了什么（坏路径、读不出的图）：只记日志与验收用，界面不报错 */
  warnings: string[];
}

export type PlanetReadResult = { ok: true; planets: WorkspacePlanets | null } | { ok: false; error: string };

/** 界面写回的一颗天体 */
export interface PlanetWriteBody {
  id: string;
  name: string;
  massEarth: number;
  composition: PlanetComposition | null;
  orbit: number | null;
  elements: PlanetElements;
}

export interface PlanetWriteRequest {
  workspaceId: string;
  main: PlanetWriteBody | null;
  planets: PlanetWriteBody[];
}

export type PlanetWriteResult = { ok: true } | { ok: false; error: string };

// ── 伴随文件 planet/galaxy.json ─────────────────────────────────────────

export interface CompanionBody {
  /** 相对 planet/ 的路径 */
  surface?: string;
  flip?: boolean;
  elements?: PlanetElements;
  /** 没有插件稿时，名字与质量记在这里 */
  name?: string;
  massEarth?: number;
  note?: string;
}

export interface CompanionPlanet extends CompanionBody {
  id: string;
  /** 这颗行星的插件格式设计稿，相对 planet/ */
  design?: string;
  composition?: PlanetComposition;
  orbit?: number;
}

export interface GalaxyCompanion {
  version: number;
  main: CompanionBody | null;
  planets: CompanionPlanet[];
}

const ELEMENT_KEYS: readonly PlanetElementKey[] = ["eyes", "ring", "clouds", "moons", "corona"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function isComposition(value: unknown): value is PlanetComposition {
  return value === "rock" || value === "ice" || value === "gas";
}

export function parseElements(value: unknown): PlanetElements | undefined {
  if (!isRecord(value)) return undefined;
  const out: PlanetElements = {};
  for (const key of ELEMENT_KEYS) {
    const on = value[key];
    if (typeof on === "boolean") out[key] = on;
  }
  return out;
}

/**
 * 相对路径只能落在 planet/ 里面：不许绝对路径、盘符、反斜杠、`..` 段。伴随文件是普通文件，谁都能改，
 * 不让它指到工作区外面去读图（主进程再按解析后的绝对路径核一遍前缀）。
 */
export function isSafeRelative(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part !== ".." && part !== "");
}

function parseBody(raw: Record<string, unknown>): CompanionBody {
  const body: CompanionBody = {};
  const surface = str(raw["surface"]);
  if (surface !== undefined && isSafeRelative(surface)) body.surface = surface;
  if (typeof raw["flip"] === "boolean") body.flip = raw["flip"];
  const elements = parseElements(raw["elements"]);
  if (elements !== undefined) body.elements = elements;
  const name = str(raw["name"]);
  if (name !== undefined) body.name = name;
  const mass = num(raw["massEarth"]);
  if (mass !== undefined && mass > 0) body.massEarth = mass;
  const note = str(raw["note"]);
  if (note !== undefined) body.note = note;
  return body;
}

/** 盘上读回的伴随文件 → 合法内容。宽松：坏条目丢掉，id 重复的只留第一颗，超出上限截掉 */
export function parseCompanion(raw: unknown): GalaxyCompanion {
  if (!isRecord(raw)) return { version: PLANET_GALAXY_VERSION, main: null, planets: [] };
  const main = isRecord(raw["main"]) ? parseBody(raw["main"]) : null;
  const planets: CompanionPlanet[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw["planets"]) ? raw["planets"] : [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const id = str(item["id"]);
    if (id === undefined || seen.has(id) || !/^[\w-]{1,64}$/.test(id)) continue;
    seen.add(id);
    const planet: CompanionPlanet = { id, ...parseBody(item) };
    const design = str(item["design"]);
    if (design !== undefined && isSafeRelative(design)) planet.design = design;
    if (isComposition(item["composition"])) planet.composition = item["composition"];
    const orbit = num(item["orbit"]);
    if (orbit !== undefined && orbit > 0) planet.orbit = orbit;
    planets.push(planet);
    if (planets.length >= PLANET_AGENTS_MAX) break;
  }
  return { version: num(raw["version"]) ?? PLANET_GALAXY_VERSION, main, planets };
}

// ── 插件格式设计稿（planet-forge 的 design.json）─────────────────────────

/** 插件只给密度（kg/m³）：按密度粗分成分。气态巨行星 ~1300，冰质 ~2000，岩质 ≥3000 */
export function compositionFromDensity(density: number | undefined): PlanetComposition | null {
  if (density === undefined || density <= 0) return null;
  if (density < 1800) return "gas";
  if (density < 3000) return "ice";
  return "rock";
}

export interface PluginDesignFields {
  name: string | undefined;
  massEarth: number | undefined;
  density: number | undefined;
  /** 插件稿里的一句故事 */
  story: string | undefined;
}

/** 从插件设计稿里取界面要的几个字段；质量只认 M⊕ 单位（别的单位当没有） */
export function pluginDesignFields(raw: unknown): PluginDesignFields {
  if (!isRecord(raw)) return { name: undefined, massEarth: undefined, density: undefined, story: undefined };
  const mass = isRecord(raw["mass"]) ? raw["mass"] : null;
  const unit = mass === null ? undefined : str(mass["unit"]);
  const massValue = mass === null ? undefined : num(mass["value"]);
  const density = isRecord(raw["density"]) ? num(raw["density"]["value"]) : undefined;
  return {
    name: str(raw["name"]),
    massEarth: massValue !== undefined && massValue > 0 && (unit === undefined || unit === "M⊕") ? massValue : undefined,
    density,
    story: str(raw["story"]),
  };
}

export const EARTH_MASS_KG = 5.9722e24;
export const EARTH_RADIUS_KM = 6371;

function sci(value: number): string {
  const [mantissa, exponent] = value.toExponential(2).split("e");
  const sup = String(Number(exponent)).replace(/[-0-9]/g, (ch) => "⁻⁰¹²³⁴⁵⁶⁷⁸⁹"["-0123456789".indexOf(ch)] ?? ch);
  return `${mantissa}×10${sup}`;
}

function trim(value: number, digits: number): string {
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

/**
 * 界面改了名字 / 质量，写回插件稿：只动 name、mass（value / kg / display / origin / source）与按原密度重算的 radius，
 * 其余字段（构成、匹配、指纹、出图记录……）原样保留。密度读不到时不碰 radius。
 */
export function patchPluginDesign(raw: unknown, patch: { name: string; massEarth: number }, source: string): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(raw) ? { ...raw } : {};
  if (patch.name.trim() !== "") base["name"] = patch.name.trim();
  const old = isRecord(base["mass"]) ? base["mass"] : {};
  const kg = patch.massEarth * EARTH_MASS_KG;
  const same = num(old["value"]) === patch.massEarth;
  base["mass"] = same
    ? old
    : {
        ...old,
        value: patch.massEarth,
        unit: "M⊕",
        kg: Number(kg.toPrecision(6)),
        display: `${trim(patch.massEarth, 2)} M⊕（约 ${sci(kg)} kg）`,
        origin: "user",
        source,
      };
  const density = isRecord(base["density"]) ? num(base["density"]["value"]) : undefined;
  if (!same && density !== undefined && density > 0) {
    const radiusKm = Math.cbrt((3 * kg) / (4 * Math.PI * density)) / 1000;
    const oldRadius = isRecord(base["radius"]) ? base["radius"] : {};
    base["radius"] = {
      ...oldRadius,
      value: Math.round(radiusKm),
      unit: "km",
      diameterKm: Math.round(radiusKm * 2),
      display: `${Math.round(radiusKm)} km（约 ${trim(radiusKm / EARTH_RADIUS_KM, 2)} R⊕）`,
      origin: "inferred",
      source: "由密度与质量推算",
    };
  }
  return base;
}

/**
 * 界面写回时的伴随文件：保留原文件里界面不管的字段（地表路径、翻转、设计稿路径、note），
 * 用写回请求覆盖界面拥有的字段（元素、轨道、成分）。名字 / 质量：有插件稿的不记在伴随文件里（以插件稿为准），
 * 没有的记在这里。请求里没有的行星从名单里拿掉（面板删了它）。
 */
export function mergeCompanion(
  current: GalaxyCompanion,
  request: Pick<PlanetWriteRequest, "main" | "planets">,
  hasDesign: { main: boolean; planets: ReadonlySet<string> },
): GalaxyCompanion {
  const writeBody = (old: CompanionBody | null, body: PlanetWriteBody, designed: boolean): CompanionBody => {
    const next: CompanionBody = { ...(old ?? {}), elements: body.elements };
    if (designed) {
      delete next.name;
      delete next.massEarth;
    } else {
      next.name = body.name;
      next.massEarth = body.massEarth;
    }
    return next;
  };
  const main = request.main === null ? null : writeBody(current.main, request.main, hasDesign.main);
  const planets = request.planets.slice(0, PLANET_AGENTS_MAX).map((body): CompanionPlanet => {
    const old = current.planets.find((planet) => planet.id === body.id) ?? null;
    const next: CompanionPlanet = { ...(old ?? { id: body.id }), ...writeBody(old, body, hasDesign.planets.has(body.id)), id: body.id };
    if (body.composition !== null) next.composition = body.composition;
    if (body.orbit !== null) next.orbit = body.orbit;
    return next;
  });
  return { version: PLANET_GALAXY_VERSION, main, planets };
}

export function isPlanetWriteBody(raw: unknown): raw is PlanetWriteBody {
  if (!isRecord(raw)) return false;
  return (
    typeof raw["id"] === "string" &&
    /^[\w-]{1,64}$/.test(raw["id"]) &&
    typeof raw["name"] === "string" &&
    raw["name"].length <= 200 &&
    typeof raw["massEarth"] === "number" &&
    Number.isFinite(raw["massEarth"]) &&
    raw["massEarth"] > 0 &&
    (raw["composition"] === null || isComposition(raw["composition"])) &&
    (raw["orbit"] === null || (typeof raw["orbit"] === "number" && Number.isFinite(raw["orbit"]))) &&
    parseElements(raw["elements"]) !== undefined
  );
}

export function isPlanetWriteRequest(raw: unknown): raw is PlanetWriteRequest {
  if (!isRecord(raw)) return false;
  return (
    typeof raw["workspaceId"] === "string" &&
    raw["workspaceId"] !== "" &&
    (raw["main"] === null || isPlanetWriteBody(raw["main"])) &&
    Array.isArray(raw["planets"]) &&
    raw["planets"].length <= PLANET_AGENTS_MAX &&
    raw["planets"].every(isPlanetWriteBody)
  );
}
