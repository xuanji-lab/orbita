/**
 * 工作区星系设计稿的读写（不碰 electron，可直测）：真源是工作区文件夹里的 planet/（与插件 planet-forge 同一份）。
 * 格式与合并规则见 shared/planet-design.ts。地表图交给注入的 loadSurface（ipc.ts 用 nativeImage 裁球、缩小、转 data URL）。
 */
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import {
  compositionFromDensity,
  mergeCompanion,
  parseCompanion,
  patchPluginDesign,
  pluginDesignFields,
  PLANET_DESIGN_FILE,
  PLANET_DIR,
  PLANET_GALAXY_FILE,
  type GalaxyCompanion,
  type PlanetBody,
  type PlanetWriteRequest,
  type WorkspacePlanets,
} from "../../shared/planet-design.ts";

/** 写回插件稿时记在 mass.source 里的来源 */
export const WRITE_SOURCE = "星系设计面板";

async function readJson(path: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // 半截 / 坏 JSON：当没有，回退种子稿（不抛给界面）
    return null;
  }
}

/** planet/ 下的相对路径 → 绝对路径；解析后跑出 planet/ 的返回 null */
export function insidePlanetDir(workspacePath: string, relative: string): string | null {
  const root = resolve(workspacePath, PLANET_DIR);
  const full = resolve(root, relative);
  return full.startsWith(root + sep) ? full : null;
}

export class PlanetStore {
  private readonly loadSurface: (path: string) => Promise<string | null>;

  constructor(loadSurface: (path: string) => Promise<string | null>) {
    this.loadSurface = loadSurface;
  }

  /** 读一个工作区的星系设计稿；planet/ 下两份文件都没有 → null（界面回退到按工作区 id 取的种子稿） */
  async read(workspacePath: string): Promise<WorkspacePlanets | null> {
    const dir = join(workspacePath, PLANET_DIR);
    const designRaw = await readJson(join(dir, PLANET_DESIGN_FILE));
    const companionRaw = await readJson(join(dir, PLANET_GALAXY_FILE));
    if (designRaw === undefined && companionRaw === undefined) return null;
    const warnings: string[] = [];
    if (designRaw === null) warnings.push(`${PLANET_DESIGN_FILE}: 不是合法 JSON`);
    if (companionRaw === null) warnings.push(`${PLANET_GALAXY_FILE}: 不是合法 JSON`);
    const companion = parseCompanion(companionRaw ?? null);
    const surfaceOf = async (relative: string | undefined, who: string): Promise<string | null> => {
      if (relative === undefined) return null;
      const full = insidePlanetDir(workspacePath, relative);
      if (full === null) {
        warnings.push(`${who}: 地表路径越界 ${relative}`);
        return null;
      }
      const src = await this.loadSurface(full);
      if (src === null) warnings.push(`${who}: 地表图读不出 ${relative}`);
      return src;
    };
    let main: PlanetBody | null = null;
    const fields = pluginDesignFields(designRaw ?? null);
    if ((designRaw !== undefined && designRaw !== null) || companion.main !== null) {
      main = {
        id: "main",
        name: fields.name ?? companion.main?.name ?? "",
        massEarth: fields.massEarth ?? companion.main?.massEarth ?? null,
        composition: null,
        note: fields.story ?? companion.main?.note ?? null,
        surface: await surfaceOf(companion.main?.surface, "主星"),
        flip: companion.main?.flip === true,
        orbit: null,
        elements: companion.main?.elements ?? null,
        eyeStyle: companion.main?.eyeStyle ?? null,
        mix: companion.main?.mix ?? null,
      };
    }
    const planets: PlanetBody[] = [];
    for (const item of companion.planets) {
      const designPath = item.design === undefined ? null : insidePlanetDir(workspacePath, item.design);
      if (item.design !== undefined && designPath === null) warnings.push(`${item.id}: 设计稿路径越界 ${item.design}`);
      const sub = designPath === null ? undefined : await readJson(designPath);
      const subFields = pluginDesignFields(sub ?? null);
      planets.push({
        id: item.id,
        name: subFields.name ?? item.name ?? "",
        massEarth: subFields.massEarth ?? item.massEarth ?? null,
        composition: item.composition ?? compositionFromDensity(subFields.density),
        note: item.note ?? null,
        surface: await surfaceOf(item.surface, item.id),
        flip: item.flip === true,
        orbit: item.orbit ?? null,
        elements: item.elements ?? null,
        eyeStyle: item.eyeStyle ?? null,
        mix: item.mix ?? null,
      });
    }
    return { main, planets, warnings };
  }

  /**
   * 写回：插件稿（主星的 planet/design.json、每颗行星伴随文件里登记的 design）只改名字与质量；
   * 伴随文件按 mergeCompanion 合并后整份原子写。插件稿坏了（不是合法 JSON）不覆盖它，名字质量改记在伴随文件里。
   */
  async write(workspacePath: string, request: Pick<PlanetWriteRequest, "main" | "planets">): Promise<void> {
    const dir = join(workspacePath, PLANET_DIR);
    const companionPath = join(dir, PLANET_GALAXY_FILE);
    const current: GalaxyCompanion = parseCompanion((await readJson(companionPath)) ?? null);
    let mainDesigned = false;
    if (request.main !== null) {
      const designPath = join(dir, PLANET_DESIGN_FILE);
      const raw = await readJson(designPath);
      if (raw !== undefined && raw !== null) {
        await writeJsonAtomic(designPath, patchPluginDesign(raw, { name: request.main.name, massEarth: request.main.massEarth }, WRITE_SOURCE));
        mainDesigned = true;
      }
    }
    const designed = new Set<string>();
    for (const body of request.planets) {
      const relative = current.planets.find((planet) => planet.id === body.id)?.design;
      const full = relative === undefined ? null : insidePlanetDir(workspacePath, relative);
      if (full === null) continue;
      const raw = await readJson(full);
      if (raw === undefined || raw === null) continue;
      await writeJsonAtomic(full, patchPluginDesign(raw, { name: body.name, massEarth: body.massEarth }, WRITE_SOURCE));
      designed.add(body.id);
    }
    await writeJsonAtomic(companionPath, mergeCompanion(current, request, { main: mainDesigned, planets: designed }));
  }
}
