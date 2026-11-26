/**
 * 子智能体档案（四层契约第 1 层）：一颗行星 = 一个持久子智能体，它「是谁、负责什么」落在工作区
 * `planet/agents/<id>/agent.json`，形象与轨道仍在伴随文件 `planet/galaxy.json`（shared/planet-design.ts）。
 *
 * 为什么另起 agent.json、不往 galaxy.json 的条目里加字段：
 * - galaxy.json 是星系设计面板的形象稿，面板拖滑块时去抖整份重写；职能提示词是另一件事（身份），
 *   一段几百字的提示词跟着每次拖轨道重写一遍，坏一处两样一起坏；
 * - 职能提示词会长（几百到几千字），用户也可能直接在文件夹里打开它改，一颗一份文件好找好改；
 * - 读不到 / 坏了只丢职能，不影响星系显示（形象照旧从 galaxy.json 来）。
 * 名单（有哪些子智能体）仍以 galaxy.json 的 planets 为准；agent.json 只是挂在同一个 id 上的档案。
 * 名字两边都有：agent.json 在时以它为准（主进程写名字时两边一起改）。
 *
 * 质量单位同 planet-design：盘上 M⊕。
 */

import {
  displayToAu,
  displayZone,
  ladderOrbit,
  MASS_UNIT_PER_EARTH,
  orbitClearance,
  physicalOrbitOf,
  seededStarMass,
  STAR_MASS,
  starPhysicalEarth,
  starPlanetCapacity,
  starSolarMass,
} from "./galaxy-scale.ts";
import { checkSystem, LEGACY_ORBIT_E, LEGACY_ORBIT_OMEGA_DEG, type OrbitSpec } from "./orbit-physics.ts";

export const SUB_AGENTS_DIR = "agents";
export const SUB_AGENT_FILE = "agent.json";
export const SUB_AGENT_VERSION = 1;
/** 名字最多几个字（与星系设计面板的 NAME_MAX 同一个数，按字符数） */
export const SUB_AGENT_NAME_MAX = 24;
/** 职能提示词最多几个字：再长就不是「职能」而是一份任务书了，也会撑大每条子会话的系统提示 */
export const SUB_AGENT_ROLE_MAX = 6000;
/** 行星质量（M⊕）的绝对区间：与界面 galaxy.ts 的 PLANET_MASS（1–40，单位 M⊕ × 10）同一档 */
export const SUB_AGENT_MASS_EARTH = { min: 0.1, max: 4 } as const;
/** 行星质量上限跟着主星走（璇玑星系规则：行星上限 = 主星质量 × 5%–10%，这里取 10%） */
export const SUB_AGENT_MASS_RATIO = 0.1;
/**
 * 连工作区 id 都没有、主星质量实在读不到时按界面上最轻的那档主星算（STAR_MASS.min，同一个来源）：宁严勿松。
 * 有工作区 id 时不用它——界面给那个工作区画的主星是 seededStarMassEarth(id)。
 */
export const STAR_MASS_EARTH_FLOOR = STAR_MASS.min / MASS_UNIT_PER_EARTH;
/** 没给质量时的默认（M⊕） */
export const SUB_AGENT_MASS_DEFAULT = 2;

/** 档案是从哪建出来的：聊天里主智能体建的 / 星系设计面板里用户建的 */
export type SubAgentSource = "chat" | "panel";

export interface SubAgentProfile {
  id: string;
  name: string;
  /** 职能提示词：它是谁、负责什么、怎么做、边界。派活指名它时整段进子会话的系统提示 */
  role: string;
  /** 可选的默认模型（裸 id）：指名派活且 delegate 没给 model 时用它 */
  modelId?: string;
  createdAt: number;
  updatedAt: number;
  source: SubAgentSource;
}

/** 盘上的 agent.json（version 便于以后升级） */
export interface SubAgentFile extends SubAgentProfile {
  version: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSubAgentId(value: unknown): value is string {
  return typeof value === "string" && /^[\w-]{1,64}$/.test(value);
}

export function nameLengthOf(name: string): number {
  return [...name].length;
}

/**
 * 读回的 agent.json → 档案。宽松但不编：id 必须与目录名一致（文件被拷到别的目录不认），
 * 名字或职能读不出来就当没有档案（null），交给调用方降级——星系照画，只是没有职能。
 */
export function parseSubAgentProfile(raw: unknown, id: string): SubAgentProfile | null {
  if (!isRecord(raw)) return null;
  if (raw["id"] !== id) return null;
  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  const role = typeof raw["role"] === "string" ? raw["role"] : "";
  if (name === "" || role.trim() === "") return null;
  const createdAt = typeof raw["createdAt"] === "number" && Number.isFinite(raw["createdAt"]) ? raw["createdAt"] : 0;
  const updatedAt = typeof raw["updatedAt"] === "number" && Number.isFinite(raw["updatedAt"]) ? raw["updatedAt"] : createdAt;
  const source: SubAgentSource = raw["source"] === "panel" ? "panel" : "chat";
  const modelId = typeof raw["modelId"] === "string" && raw["modelId"].trim() !== "" ? raw["modelId"].trim() : undefined;
  return { id, name, role, createdAt, updatedAt, source, ...(modelId === undefined ? {} : { modelId }) };
}

/** 行星质量上限（M⊕）：主星 × 10%，再夹在绝对区间里 */
export function subAgentMassCap(starMassEarth: number | null): number {
  const star = starMassOrFloor(starMassEarth);
  return Math.min(SUB_AGENT_MASS_EARTH.max, Math.round(star * SUB_AGENT_MASS_RATIO * 100) / 100);
}

export type SubAgentComposition = "rock" | "ice" | "gas";

/** 新建一个子智能体（面板与工具共用的入参；工具另有 surfacePath） */
export interface SubAgentCreateInput {
  name: string;
  role: string;
  modelId?: string;
  /** M⊕；缺席 = SUB_AGENT_MASS_DEFAULT（再夹到上限） */
  massEarth?: number;
  composition?: SubAgentComposition;
  /**
   * 无脸地表图的绝对路径（插件「行星造物」的流程用 Qwen 出的图）：主进程拷进 planet/agents/<id>/。
   * 缺席 = 先用代码画的默认球，面板上标「待出图」。
   */
  surfacePath?: string;
}

/** 改一个子智能体：只改给了的字段；modelId 给 null = 清掉默认模型 */
export interface SubAgentUpdateInput {
  id: string;
  name?: string;
  role?: string;
  modelId?: string | null;
  surfacePath?: string;
}

/** 校验时要知道的星系现状 */
export interface SubAgentContext {
  /** 主星名字（同名冲突也算主星） */
  mainName: string | null;
  /** 主星质量（M⊕）；读不到为 null */
  starMassEarth: number | null;
  /** 已有的子智能体（id + 名字） */
  agents: readonly { id: string; name: string }[];
  /** 名单上限（PLANET_AGENTS_MAX） */
  max: number;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function checkName(name: unknown, context: SubAgentContext, selfId: string | null): Checked<string> {
  if (typeof name !== "string" || name.trim() === "") return { ok: false, error: "name 不能为空。" };
  const trimmed = name.trim();
  const length = nameLengthOf(trimmed);
  if (length > SUB_AGENT_NAME_MAX) return { ok: false, error: `name 最多 ${SUB_AGENT_NAME_MAX} 个字，现在 ${length} 个。` };
  if (context.mainName !== null && context.mainName.trim() !== "" && sameName(trimmed, context.mainName)) {
    return { ok: false, error: `「${trimmed}」是主星（主智能体）的名字，子智能体换一个名字。` };
  }
  const clash = context.agents.find((agent) => agent.id !== selfId && sameName(agent.name, trimmed));
  if (clash !== undefined) return { ok: false, error: `已经有一个叫「${clash.name}」的子智能体（id ${clash.id}），换个名字，或用 update 改它。` };
  return { ok: true, value: trimmed };
}

function checkRole(role: unknown): Checked<string> {
  if (typeof role !== "string" || role.trim() === "") return { ok: false, error: "role（职能提示词）不能为空。" };
  const length = [...role].length;
  if (length > SUB_AGENT_ROLE_MAX) return { ok: false, error: `role 最多 ${SUB_AGENT_ROLE_MAX} 个字，现在 ${length} 个。` };
  return { ok: true, value: role.trim() };
}

function checkModel(model: unknown): Checked<string | undefined> {
  if (model === undefined) return { ok: true, value: undefined };
  if (typeof model !== "string" || model.trim() === "" || model.length > 200) return { ok: false, error: "modelId 要是非空的模型 id。" };
  return { ok: true, value: model.trim() };
}

function checkSurface(path: unknown): Checked<string | undefined> {
  if (path === undefined) return { ok: true, value: undefined };
  if (typeof path !== "string" || path.trim() === "") return { ok: false, error: "surfacePath 要是图片文件的绝对路径。" };
  if (!/\.(png|jpe?g|webp)$/i.test(path)) return { ok: false, error: "surfacePath 只认 png / jpg / webp 图片。" };
  return { ok: true, value: path };
}

export interface CheckedCreate {
  name: string;
  role: string;
  modelId?: string;
  massEarth: number;
  composition: SubAgentComposition;
  surfacePath?: string;
}

/** 新建的校验：名字长度与冲突、职能非空、质量不越过主星（上限跟着主星走）、名单没满 */
export function checkCreate(raw: unknown, context: SubAgentContext): Checked<CheckedCreate> {
  if (!isRecord(raw)) return { ok: false, error: "参数要是一个对象。" };
  // 主星越重带得越多：容量按物理层算（0.3 M☉ → 3 颗 … 1.0 M☉ → 8 颗）
  const capacity = subAgentCapacity(context.starMassEarth);
  if (context.agents.length >= capacity) {
    const solar = starSolarMass(starMassOrFloor(context.starMassEarth) * MASS_UNIT_PER_EARTH);
    return {
      ok: false,
      error: `这颗主星（${Number(solar.toFixed(2))} M☉）最多带 ${capacity} 颗行星，现在已经有 ${context.agents.length} 颗，子智能体尚未创建。先删掉一颗，或在星系设计里把主星调重（主星越重带得越多，1.0 M☉ 最多 8 颗）。`,
    };
  }
  if (context.agents.length >= context.max) return { ok: false, error: `这座星系已经有 ${context.agents.length} 个子智能体，最多 ${context.max} 个。先删掉一个再建。` };
  const name = checkName(raw["name"], context, null);
  if (!name.ok) return name;
  const role = checkRole(raw["role"]);
  if (!role.ok) return role;
  const model = checkModel(raw["modelId"]);
  if (!model.ok) return model;
  const surface = checkSurface(raw["surfacePath"]);
  if (!surface.ok) return surface;
  const cap = subAgentMassCap(context.starMassEarth);
  const massRaw = raw["massEarth"];
  let massEarth = Math.min(SUB_AGENT_MASS_DEFAULT, cap);
  if (massRaw !== undefined) {
    if (typeof massRaw !== "number" || !Number.isFinite(massRaw) || massRaw <= 0) return { ok: false, error: "massEarth 要是正数（单位 M⊕）。" };
    if (massRaw < SUB_AGENT_MASS_EARTH.min) return { ok: false, error: `massEarth 至少 ${SUB_AGENT_MASS_EARTH.min} M⊕。` };
    if (massRaw > cap) {
      return {
        ok: false,
        error: `massEarth ${massRaw} M⊕ 越过了上限 ${cap} M⊕：行星质量不能超过主星的 ${SUB_AGENT_MASS_RATIO * 100}%（主星 ${context.starMassEarth ?? `未知，按 ${STAR_MASS_EARTH_FLOOR}`} M⊕），也不超过 ${SUB_AGENT_MASS_EARTH.max} M⊕。`,
      };
    }
    massEarth = massRaw;
  }
  const compRaw = raw["composition"];
  if (compRaw !== undefined && compRaw !== "rock" && compRaw !== "ice" && compRaw !== "gas") {
    return { ok: false, error: 'composition 只能是 "rock" / "ice" / "gas"。' };
  }
  const composition: SubAgentComposition = compRaw === "ice" || compRaw === "gas" ? compRaw : "rock";
  return {
    ok: true,
    value: {
      name: name.value,
      role: role.value,
      massEarth,
      composition,
      ...(model.value === undefined ? {} : { modelId: model.value }),
      ...(surface.value === undefined ? {} : { surfacePath: surface.value }),
    },
  };
}

export interface CheckedUpdate {
  id: string;
  name?: string;
  role?: string;
  modelId?: string | null;
  surfacePath?: string;
}

/** 改的校验：id 要在名单上，给了的字段逐个校验（改名照样查冲突，跳过它自己） */
export function checkUpdate(raw: unknown, context: SubAgentContext): Checked<CheckedUpdate> {
  if (!isRecord(raw)) return { ok: false, error: "参数要是一个对象。" };
  const id = raw["id"];
  if (!isSubAgentId(id) || !context.agents.some((agent) => agent.id === id)) {
    return { ok: false, error: `没有 id 为 ${JSON.stringify(id)} 的子智能体（先用 list_sub_agents 看看有哪些）。` };
  }
  const out: CheckedUpdate = { id };
  if (raw["name"] !== undefined) {
    const name = checkName(raw["name"], context, id);
    if (!name.ok) return name;
    out.name = name.value;
  }
  if (raw["role"] !== undefined) {
    const role = checkRole(raw["role"]);
    if (!role.ok) return role;
    out.role = role.value;
  }
  if (raw["modelId"] === null) out.modelId = null;
  else if (raw["modelId"] !== undefined) {
    const model = checkModel(raw["modelId"]);
    if (!model.ok) return model;
    if (model.value !== undefined) out.modelId = model.value;
  }
  if (raw["surfacePath"] !== undefined) {
    const surface = checkSurface(raw["surfacePath"]);
    if (!surface.ok) return surface;
    if (surface.value !== undefined) out.surfacePath = surface.value;
  }
  if (out.name === undefined && out.role === undefined && out.modelId === undefined && out.surfacePath === undefined) {
    return { ok: false, error: "没有要改的字段（name / role / modelId / surfacePath 至少给一个）。" };
  }
  return { ok: true, value: out };
}

/**
 * 没设计过的工作区（planet/ 里还没有主星质量）界面上画的那颗主星（M⊕）：按工作区 id 播种，与设计面板、首页星系、
 * 侧栏头像用的是同一个函数（galaxy-scale 的 seededStarMass）。新建子智能体找空轨、算行星质量上限时，读不到主星质量
 * 就按它算——两边对同一颗星说同一个质量，新行星才不会落进界面画出的主星里。
 */
export function seededStarMassEarth(workspaceId: string | null): number | null {
  return workspaceId === null ? null : seededStarMass(workspaceId) / MASS_UNIT_PER_EARTH;
}

function starMassOrFloor(starMassEarth: number | null): number {
  return starMassEarth !== null && Number.isFinite(starMassEarth) && starMassEarth > 0 ? starMassEarth : STAR_MASS_EARTH_FLOOR;
}

/** 旧稿里没写轨道的第 index 颗按这个画面半径算（与 design.ts 的 defaultAgentOrbit 同一个起点与步长） */
function legacyOrbit(index: number): number {
  return 19 + 12 * index;
}

/**
 * 第 k 档默认轨道写到盘上的画面半径：两位小数（与面板滑块的精度同档），向外进位——第 0 档正好贴着画面行星区内缘，
 * 四舍五入往里挪 0.005 就会碰到最大的那种行星
 */
export function ladderDisplay(starUiMass: number, k: number): number {
  return Math.ceil(ladderOrbit(starUiMass, k).display * 100 - 1e-9) / 100;
}

/** 这颗主星最多带几颗行星（物理层容量，见 galaxy-scale 的 starPlanetCapacity）；读不到主星质量按最轻那档 */
export function subAgentCapacity(starMassEarth: number | null): number {
  return starPlanetCapacity(starMassOrFloor(starMassEarth) * MASS_UNIT_PER_EARTH);
}

/**
 * 新行星的默认轨道（盘上写画面半径）：从离主星最近的安全物理轨道 a_in 起，每档外推 1.3 倍（ladderOrbit），
 * 挑第一档同时满足两道判据的：
 * - 画面层：不落进主星、不出画面行星区（orbitClearance，与设计面板同一条）；
 * - 物理层：与已有行星隔开 2√3 个相互希尔半径（checkSystem，主星按 M☉ × 333000 M⊕、轨道按 AU；
 *   只看新行星涉及的冲突，旧稿本身的红区仍交给面板修）。
 * 档位都被占了（比如旧行星被拖到了档与档之间）就在画面行星区里按 0.25 的步长从内往外找；还找不到返回 null，
 * 调用方不得先落档案。
 *
 * 以前全按画面数算希尔半径：主星 30–100 M⊕、行星 2 M⊕，质量比夸张上万倍，30–70 M⊕ 的主星只排得下 1 颗（2026-11-26）；
 * 再往前，候选从 4 起一路试，空工作区的第二颗被排到 4.5、落在主星里（2026-11-25）。
 */
export function findSubAgentOrbit(
  starMassEarth: number | null,
  existing: readonly { massEarth: number | null; orbit: number | null; eccentricity?: number; periapsisDeg?: number }[],
  newMassEarth: number,
  newComposition: SubAgentComposition = "rock",
): number | null {
  const starUi = starMassOrFloor(starMassEarth) * MASS_UNIT_PER_EARTH;
  const planetUi = newMassEarth * MASS_UNIT_PER_EARTH;
  const physical: OrbitSpec[] = existing.map((planet, index) =>
    physicalOrbitOf(starUi, {
      mass: (planet.massEarth ?? SUB_AGENT_MASS_DEFAULT) * MASS_UNIT_PER_EARTH,
      a: planet.orbit ?? legacyOrbit(index),
      e: planet.eccentricity ?? LEGACY_ORBIT_E,
      omegaDeg: planet.periapsisDeg ?? LEGACY_ORBIT_OMEGA_DEG,
    }),
  );
  const starPhysical = { mass: starPhysicalEarth(starUi) };
  const fits = (display: number): boolean => {
    // 新行星从圆轨道出生，所以看的就是半长轴本身
    if (!orbitClearance({ star: { mass: starUi }, planet: { mass: planetUi, composition: newComposition, a: display, e: 0 } }).ok) return false;
    const next = [...physical, { mass: newMassEarth, a: displayToAu(starUi, display), e: 0, omegaDeg: LEGACY_ORBIT_OMEGA_DEG }];
    const self = next.length - 1;
    return checkSystem(starPhysical, next).warnings.every((warning) => warning.level !== "red" || (warning.innerIndex !== self && warning.outerIndex !== self));
  };
  const rungs = starPlanetCapacity(starUi);
  for (let k = 0; k < rungs; k++) {
    const display = ladderDisplay(starUi, k);
    if (fits(display)) return display;
  }
  const { dIn, dOut } = displayZone(starUi);
  for (let display = Math.ceil(dIn * 4) / 4; display <= dOut + 1e-9; display += 0.25) {
    if (fits(display)) return display;
  }
  return null;
}

// ── IPC（面板）与 agent 工具的载荷 ─────────────────────────────────────

export interface SubAgentCreateRequest {
  workspaceId: string;
  input: SubAgentCreateInput;
}

export interface SubAgentUpdateRequest {
  workspaceId: string;
  input: SubAgentUpdateInput;
}

export interface SubAgentDeleteRequest {
  workspaceId: string;
  id: string;
}

export type SubAgentMutationResult = { ok: true; id: string } | { ok: false; error: string };

/** agent 工具（create_sub_agent / update_sub_agent / revise_sub_agent_avatar / list_sub_agents）的请求 */
export type SubAgentToolRequest =
  | { action: "create"; input: SubAgentCreateInput }
  | { action: "update"; input: SubAgentUpdateInput }
  | { action: "reviseAvatar"; input: { id: string; instruction: string } }
  | { action: "list" };

/** 列表里的一行（给模型看的） */
export interface SubAgentListItem {
  id: string;
  name: string;
  role: string | null;
  modelId: string | null;
  massEarth: number | null;
  /** 有没有地表图（false = 还是代码画的默认球，待出图） */
  hasSurface: boolean;
}

export type SubAgentToolOutcome =
  | { ok: true; text: string; id?: string; agents?: SubAgentListItem[] }
  | { ok: false; error: string };

/** 子智能体档案变了（主进程写完广播给 renderer）：界面重读这座星系；聊天里新建或要求改形象的还要弹出设计面板停在它上面 */
export interface SubAgentsChanged {
  workspaceId: string;
  subAgentId: string;
  action: "created" | "updated" | "deleted" | "avatar";
  source: SubAgentSource;
  /** 聊天里建的：是哪条会话建的（renderer 只在正看着这条会话时弹面板） */
  sessionId?: string;
}

/** 指名派活时随每轮命令带给 agent 进程的那一段身份（主进程按 attributionOf(会话 meta) 现读档案） */
export interface SubAgentTurnIdentity {
  id: string;
  name: string;
  role: string;
}
