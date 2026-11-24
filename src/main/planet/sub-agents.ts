/**
 * 子智能体档案的增改删（不碰 electron，可直测）。档案在 <工作区>/planet/agents/<id>/agent.json，名单在 planet/galaxy.json，
 * 格式与校验见 shared/sub-agent.ts。面板（subagent:* IPC）与聊天里的工具（subAgentRequest）都走这一个类，写的是同一份。
 *
 * 写一律在 withPlanetLock 里「读—改—写」，与面板的去抖写回（PlanetStore.write）串行，谁也不会拿一份旧名单盖掉对方。
 */
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, rename, stat } from "node:fs/promises";
import { extname, isAbsolute, join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import {
  parseCompanion,
  pluginDesignFields,
  PLANET_AGENTS_MAX,
  PLANET_DESIGN_FILE,
  PLANET_DIR,
  PLANET_GALAXY_FILE,
  type CompanionPlanet,
  type GalaxyCompanion,
} from "../../shared/planet-design.ts";
import {
  checkCreate,
  checkUpdate,
  defaultSubAgentOrbit,
  SUB_AGENT_VERSION,
  SUB_AGENTS_DIR,
  type Checked,
  type SubAgentContext,
  type SubAgentListItem,
  type SubAgentProfile,
  type SubAgentSource,
} from "../../shared/sub-agent.ts";
import { insidePlanetDir, profilePath, readJson, readProfile, withPlanetLock } from "./store.ts";

/** 拷进来的地表图最大多大（Qwen 的 1024 PNG 一两 MB；再大多半拷错了文件） */
export const SURFACE_MAX_BYTES = 20 * 1024 * 1024;
/** 删掉的子智能体挪到这里（可恢复），不直接 rm：档案与地表图是用户和主智能体一起磨出来的 */
export const DELETED_DIR = ".deleted";

/** 没给轨道的第 i 颗的默认轨道：与界面 design.ts 的 defaultAgentOrbit 同一个起点与步长 */
function indexOrbit(index: number): number {
  return 19 + 12 * index;
}

interface Galaxy {
  companion: GalaxyCompanion;
  context: SubAgentContext;
  /** 每颗行星的名字（档案 > 插件稿 > 伴随文件）与档案 */
  agents: { planet: CompanionPlanet; name: string; profile: SubAgentProfile | null; massEarth: number | null }[];
}

export class SubAgentStore {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: { now?: () => number; newId?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `agent-${randomUUID().slice(0, 8)}`);
  }

  /** 读一座星系的现状：伴随文件、主星名字与质量、每颗行星的名字与档案（不读地表图，便宜） */
  private async galaxy(workspacePath: string): Promise<Galaxy> {
    const dir = join(workspacePath, PLANET_DIR);
    const companion = parseCompanion((await readJson(join(dir, PLANET_GALAXY_FILE))) ?? null);
    const mainFields = pluginDesignFields((await readJson(join(dir, PLANET_DESIGN_FILE))) ?? null);
    const agents: Galaxy["agents"] = [];
    for (const planet of companion.planets) {
      const designPath = planet.design === undefined ? null : insidePlanetDir(workspacePath, planet.design);
      const fields = pluginDesignFields(designPath === null ? null : ((await readJson(designPath)) ?? null));
      const profile = (await readProfile(workspacePath, planet.id)) ?? null;
      agents.push({ planet, profile, name: profile?.name ?? fields.name ?? planet.name ?? "", massEarth: fields.massEarth ?? planet.massEarth ?? null });
    }
    return {
      companion,
      agents,
      context: {
        mainName: mainFields.name ?? companion.main?.name ?? null,
        starMassEarth: mainFields.massEarth ?? companion.main?.massEarth ?? null,
        agents: agents.map((agent) => ({ id: agent.planet.id, name: agent.name })),
        max: PLANET_AGENTS_MAX,
      },
    };
  }

  async list(workspacePath: string): Promise<SubAgentListItem[]> {
    const { agents } = await this.galaxy(workspacePath);
    return agents.map((agent) => ({
      id: agent.planet.id,
      name: agent.name,
      role: agent.profile?.role ?? null,
      modelId: agent.profile?.modelId ?? null,
      massEarth: agent.massEarth,
      hasSurface: agent.planet.surface !== undefined,
    }));
  }

  /** 名单上的一颗的档案（指名派活用）：不在名单上、没档案、档案坏了都是 null */
  async profile(workspacePath: string, id: string): Promise<SubAgentProfile | null> {
    const { agents } = await this.galaxy(workspacePath);
    return agents.find((agent) => agent.planet.id === id)?.profile ?? null;
  }

  /** 拷地表图进 planet/agents/<id>/，回相对 planet/ 的路径 */
  private async copySurface(workspacePath: string, id: string, source: string): Promise<Checked<string>> {
    if (!isAbsolute(source)) return { ok: false, error: "surfacePath 要是绝对路径。" };
    let size: number;
    try {
      const info = await stat(source);
      if (!info.isFile()) return { ok: false, error: `surfacePath 不是文件：${source}` };
      size = info.size;
    } catch {
      return { ok: false, error: `surfacePath 读不到：${source}` };
    }
    if (size > SURFACE_MAX_BYTES) return { ok: false, error: `地表图太大（${Math.round(size / 1024 / 1024)} MB），最多 20 MB。` };
    const relative = `${SUB_AGENTS_DIR}/${id}/surface${extname(source).toLowerCase()}`;
    const target = insidePlanetDir(workspacePath, relative);
    if (target === null) return { ok: false, error: "地表图的落点越界。" };
    await mkdir(join(workspacePath, PLANET_DIR, SUB_AGENTS_DIR, id), { recursive: true });
    // 先拷到临时名再 rename：半张图比没有图更难排查（同 writeBytesAtomic 的理由）
    const temp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await copyFile(source, temp);
    await rename(temp, target);
    return { ok: true, value: relative };
  }

  async create(workspacePath: string, raw: unknown, source: SubAgentSource): Promise<Checked<{ id: string; name: string }>> {
    return withPlanetLock(workspacePath, async () => {
      const galaxy = await this.galaxy(workspacePath);
      const checked = checkCreate(raw, galaxy.context);
      if (!checked.ok) return checked;
      const input = checked.value;
      const id = this.uniqueId(galaxy);
      const surface = input.surfacePath === undefined ? null : await this.copySurface(workspacePath, id, input.surfacePath);
      if (surface !== null && !surface.ok) return surface;
      const now = this.now();
      const profile: SubAgentProfile = {
        id,
        name: input.name,
        role: input.role,
        createdAt: now,
        updatedAt: now,
        source,
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      };
      await writeJsonAtomic(profilePath(workspacePath, id), { version: SUB_AGENT_VERSION, ...profile });
      const orbit = defaultSubAgentOrbit(galaxy.companion.planets.map((planet, index) => planet.orbit ?? indexOrbit(index)));
      const planet: CompanionPlanet = {
        id,
        name: input.name,
        massEarth: input.massEarth,
        composition: input.composition,
        orbit,
        elements: { eyes: true },
        ...(surface === null ? {} : { surface: surface.value }),
      };
      await writeJsonAtomic(join(workspacePath, PLANET_DIR, PLANET_GALAXY_FILE), { ...galaxy.companion, planets: [...galaxy.companion.planets, planet] });
      return { ok: true, value: { id, name: input.name } };
    });
  }

  async update(workspacePath: string, raw: unknown, source: SubAgentSource): Promise<Checked<{ id: string; name: string }>> {
    return withPlanetLock(workspacePath, async () => {
      const galaxy = await this.galaxy(workspacePath);
      const checked = checkUpdate(raw, galaxy.context);
      if (!checked.ok) return checked;
      const input = checked.value;
      const agent = galaxy.agents.find((each) => each.planet.id === input.id);
      if (agent === undefined) return { ok: false, error: `没有 id 为 ${input.id} 的子智能体。` };
      const now = this.now();
      // 没有档案（导入的、面板老版本加的行星）：改它时补一份；补的这一份必须有职能
      const base: SubAgentProfile = agent.profile ?? { id: input.id, name: agent.name, role: "", createdAt: now, updatedAt: now, source };
      const role = input.role ?? base.role;
      if (role.trim() === "") return { ok: false, error: "这个子智能体还没有职能，第一次改它时要给 role。" };
      const name = input.name ?? (base.name.trim() === "" ? agent.name : base.name);
      if (name.trim() === "") return { ok: false, error: "这个子智能体还没有名字，第一次改它时要给 name。" };
      const { modelId: _old, ...rest } = base;
      const modelId = input.modelId === null ? undefined : (input.modelId ?? base.modelId);
      const profile: SubAgentProfile = { ...rest, name, role, updatedAt: now, ...(modelId === undefined ? {} : { modelId }) };
      let surface: string | undefined;
      if (input.surfacePath !== undefined) {
        const copied = await this.copySurface(workspacePath, input.id, input.surfacePath);
        if (!copied.ok) return copied;
        surface = copied.value;
      }
      await writeJsonAtomic(profilePath(workspacePath, input.id), { version: SUB_AGENT_VERSION, ...profile });
      // 名字与地表在伴随文件里也记一份（没有插件稿的行星，名字就记在这里；星系画的地表从这里取）
      if (input.name !== undefined || surface !== undefined) {
        const planets = galaxy.companion.planets.map((planet) =>
          planet.id !== input.id ? planet : { ...planet, ...(planet.design === undefined && input.name !== undefined ? { name } : {}), ...(surface === undefined ? {} : { surface }) },
        );
        await writeJsonAtomic(join(workspacePath, PLANET_DIR, PLANET_GALAXY_FILE), { ...galaxy.companion, planets });
      }
      return { ok: true, value: { id: input.id, name } };
    });
  }

  /** 删：从名单拿掉，planet/agents/<id>/ 整个挪进 planet/agents/.deleted/<id>-<时间>/（可恢复）。归属它的会话不动 */
  async delete(workspacePath: string, id: string): Promise<Checked<{ id: string; name: string }>> {
    return withPlanetLock(workspacePath, async () => {
      const galaxy = await this.galaxy(workspacePath);
      const agent = galaxy.agents.find((each) => each.planet.id === id);
      if (agent === undefined) return { ok: false, error: `没有 id 为 ${JSON.stringify(id)} 的子智能体。` };
      await writeJsonAtomic(join(workspacePath, PLANET_DIR, PLANET_GALAXY_FILE), {
        ...galaxy.companion,
        planets: galaxy.companion.planets.filter((planet) => planet.id !== id),
      });
      const from = join(workspacePath, PLANET_DIR, SUB_AGENTS_DIR, id);
      const exists = await stat(from).then((info) => info.isDirectory(), () => false);
      if (exists) {
        const trash = join(workspacePath, PLANET_DIR, SUB_AGENTS_DIR, DELETED_DIR);
        await mkdir(trash, { recursive: true });
        await rename(from, join(trash, `${id}-${this.now()}`));
      }
      return { ok: true, value: { id, name: agent.name } };
    });
  }

  private uniqueId(galaxy: Galaxy): string {
    const taken = new Set(galaxy.companion.planets.map((planet) => planet.id));
    for (;;) {
      const id = this.newId();
      if (!taken.has(id)) return id;
    }
  }
}
