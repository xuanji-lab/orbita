import type { SessionMeta } from "@shared/session";
import { sessionRunState, type RunStateSource, type SessionRunState } from "../notify/completion-notice.ts";
import { workspaceHash } from "../galaxy-designer/design.ts";
import {
  PLANET_MASS,
  PLANET_ZONE,
  VISIBLE_ORBIT_CAP,
  type Composition,
  type GalaxySpec,
  type PlanetSpec,
  type RockSpec,
} from "./galaxy.ts";

/**
 * 一座星系的真实数据（替换原型的写死 fixture）：主星 = 工作区（或没选工作区时的「主目录」），
 * 行星 = 这里的子智能体 / 派出去的活，碎石带 = 其余会话。守「引力语法」：
 * - 行星只来自子会话（久没动静的退场）与自己此刻在跑 / 在等你的根会话；质量夹在 PLANET_MASS 里（远小于主星），
 *   所以再忙的会话也长不成主星；
 * - 其余会话只是碎石带的颗粒数（2000 条也只是更浓，不逐条画）；
 * - 行星按「要你动手 → 在跑 → 出错 → 跑完 → 其它」排，越要紧越靠内圈；只画 VISIBLE_ORBIT_CAP 圈，
 *   其余计进 hidden（layoutGalaxy 按轨道半径取最内的那几颗，所以排名就是轨道次序）。
 *
 * 差异来源都是真实数据或确定的哈希，不随机：
 * - 行星质量 = 这件活用过的 token 量（meta.stats，取对数压进区间）；没有账本的取下限；
 * - 成分（只决定纹理深浅）、倾角、升交点、初相位 = 会话 id 的哈希——同一件活每次长得一样。
 */

/**
 * runStateOf 的批量版：先把子会话按母会话建好表，再逐条问。runStateOf 每条都扫一遍全表找子会话，
 * 2000 条会话的工作区就是 400 万次比较；这里整趟 O(n)。口径与 runStateOf 完全一致（见测试）。
 */
export interface StateIndex {
  /** 含子会话的汇总态（侧栏行的状态饼同口径） */
  state: (meta: SessionMeta) => SessionRunState;
  /** 只看这条会话自己的槽（不含子会话）：判断「根会话自己在不在干活」，免得母会话与它在跑的孩子重复上轨道 */
  own: (meta: SessionMeta) => SessionRunState;
}

export function stateIndexOf(source: RunStateSource): StateIndex {
  const childrenOf = new Map<string, SessionMeta[]>();
  for (const meta of source.sessions) {
    if (meta.parentId === undefined) continue;
    const list = childrenOf.get(meta.parentId);
    if (list === undefined) childrenOf.set(meta.parentId, [meta]);
    else list.push(meta);
  }
  const slot = (id: string) => ({
    phase: source.phaseOf(id),
    approvals: source.approvalsOf(id).length,
    planAwaiting: source.planAwaitingOf?.(id) ?? false,
  });
  return {
    state: (meta) =>
      sessionRunState({
        slot: slot(meta.id),
        children: (childrenOf.get(meta.id) ?? []).map((child) => slot(child.id)),
        unread: meta.unread ?? null,
      }),
    own: (meta) => sessionRunState({ slot: slot(meta.id), children: [], unread: meta.unread ?? null }),
  };
}

export function stateOfIndex(source: RunStateSource): (meta: SessionMeta) => SessionRunState {
  return stateIndexOf(source).state;
}

/** 一条会话算不算在这座星系里：归档的、自动化开出来还没转正的都不算（侧栏也不列它们） */
function listed(meta: SessionMeta): boolean {
  return !meta.archived && (meta.automationId === undefined || meta.promoted === true);
}

const STATE_RANK: Readonly<Record<Exclude<SessionRunState, null>, number>> = {
  waiting: 0,
  running: 1,
  failed: 2,
  done: 3,
};

function rankOf(state: SessionRunState): number {
  return state === null ? 4 : STATE_RANK[state];
}

/** 行星质量：token 量取对数。1 万 token ≈ 5，100 万 ≈ 13，封顶 16（再大也只是一颗重一点的行星） */
export const PLANET_MASS_CAP = 16;

export function planetMassOf(totalTokens: number | null): number {
  if (totalTokens === null || !Number.isFinite(totalTokens) || totalTokens <= 0) return PLANET_MASS.min * 1.5;
  const mass = 1 + 4 * Math.log10(1 + totalTokens / 1000);
  return Math.min(PLANET_MASS_CAP, Math.max(PLANET_MASS.min, mass));
}

/**
 * 没动静的子会话（状态不亮）多久不碰就退场：超过这个窗口它不再占一条轨道，退回碎石带。
 * 做完看过的活不该永远挂在行星位上——3 天与侧栏时间范围的中档同量级；在跑 / 在等 / 出错 / 跑完没看的不受这条管。
 */
export const IDLE_CHILD_MS = 3 * 24 * 60 * 60 * 1000;

const COMPOSITIONS: readonly Composition[] = ["rock", "ice", "gas"];

/** 行星按排名落在等距的轨道上：最内 ORBIT_FIRST，最外一圈（第 VISIBLE_ORBIT_CAP 颗）贴着行星区外沿 */
export const ORBIT_FIRST = 12;
export const ORBIT_STEP = (PLANET_ZONE - 3 - ORBIT_FIRST) / (VISIBLE_ORBIT_CAP - 1);

/**
 * 第 index 颗（0 起）的轨道半径。行星少时别全挤在主星身边、外面留一大圈空：只有 n 颗就把它们均匀铺进行星区
 * （间距最多放大到 ORBIT_STEP 的 2.3 倍，免得两三颗之间隔得像互不相干）；满 VISIBLE_ORBIT_CAP 颗回到原来的等距。
 * 排名次序不变——越要紧越靠内圈；只有一颗时放在行星区中段，不贴着主星。
 */
export const ORBIT_SPREAD_MAX = 2.3;

export function orbitRadiusOf(index: number, count: number): number {
  const shown = Math.min(Math.max(count, 1), VISIBLE_ORBIT_CAP);
  if (shown === 1) return ORBIT_FIRST + (PLANET_ZONE - 3 - ORBIT_FIRST) * 0.35;
  const step = Math.min(ORBIT_STEP * ORBIT_SPREAD_MAX, (PLANET_ZONE - 3 - ORBIT_FIRST) / (shown - 1));
  return ORBIT_FIRST + step * index;
}

export interface ScopeGalaxyInput {
  sessions: readonly SessionMeta[];
  /** 哪座星系：工作区 id；null = 不属于任何工作区的那些（全局首页的「主目录」） */
  workspaceId: string | null;
  stateOf: (meta: SessionMeta) => SessionRunState;
  /** 根会话「自己」的状态（不含子会话）；缺省按 stateOf。给了才能避免母会话与它在跑的孩子同时上轨道 */
  ownStateOf?: (meta: SessionMeta) => SessionRunState;
  /** 现在（毫秒）：算「没动静的子会话」退场用 */
  now: number;
  starMass: number;
  /** 主星连星环 / 日冕的外缘（世界单位，来自设计稿）；缺席 = 主星半径 */
  starExtent?: number;
  /**
   * 星系设计面板里设计过的那颗行星（只有改过才给）：套到排第一的行星上（质量与成分），
   * 轨道次序仍按要紧程度排，不让面板里的轨道半径打乱「越要紧越靠内」。
   */
  designedPlanet: { mass: number; composition: Composition } | null;
  /**
   * 子智能体（编排星系：行星 = 子智能体，会话 = 碎石）。给了就换一套规矩：行星只画这些子智能体（质量、成分、轨道照设计稿），
   * 会话一律进碎石带，在跑 / 等你的会话单独拎成带锁定框的碎石块（spec.rocks）。缺席 = 旧规矩（会话当行星，星际空间仍用它）。
   */
  agents?: readonly AgentPlanetInput[];
}

/** 同时拎成碎石块（带锁定框）的在做事会话上限：满载时 15 件同时在跑，一圈 15 个锁定框读不出谁要紧 */
export const ROCK_CAP = 8;

/** 一颗子智能体行星（来自设计稿） */
export interface AgentPlanetInput {
  id: string;
  mass: number;
  composition: Composition;
  orbitRadius: number;
}

export interface ScopeGalaxy {
  spec: GalaxySpec;
  /** 行星依次对应的会话 id（排名顺序；只有前 VISIBLE_ORBIT_CAP 颗会画出来） */
  planetIds: string[];
}

/** 这座星系里的根会话与子会话（子会话跟着母会话走：母会话在这座星系里，它的子会话就是这里的行星） */
export function scopeMembers(
  sessions: readonly SessionMeta[],
  workspaceId: string | null,
): { roots: SessionMeta[]; children: SessionMeta[] } {
  const roots = sessions.filter((meta) => meta.parentId === undefined && listed(meta) && meta.workspaceId === workspaceId);
  const rootIds = new Set(roots.map((meta) => meta.id));
  const children = sessions.filter((meta) => meta.parentId !== undefined && rootIds.has(meta.parentId));
  return { roots, children };
}

export function scopeGalaxy(input: ScopeGalaxyInput): ScopeGalaxy {
  const { roots, children } = scopeMembers(input.sessions, input.workspaceId);
  if (input.agents !== undefined) return agentGalaxy(input, input.agents, roots, children);
  const candidates: { meta: SessionMeta; state: SessionRunState }[] = [];
  const planetIds = new Set<string>();
  let retired = 0;
  for (const meta of children) {
    const state = input.stateOf(meta);
    // 没动静又久没碰：退场进碎石带（不再占轨道），平常的星系只剩真在走动的那几件
    if (state === null && input.now - meta.updatedAt > IDLE_CHILD_MS) {
      retired += 1;
      continue;
    }
    candidates.push({ meta, state });
    planetIds.add(meta.id);
  }
  const ownStateOf = input.ownStateOf ?? input.stateOf;
  for (const meta of roots) {
    const state = ownStateOf(meta);
    if (state === "running" || state === "waiting") {
      candidates.push({ meta, state: input.stateOf(meta) });
      planetIds.add(meta.id);
    }
  }
  candidates.sort((a, b) => rankOf(a.state) - rankOf(b.state) || b.meta.updatedAt - a.meta.updatedAt || a.meta.id.localeCompare(b.meta.id));
  const planets: PlanetSpec[] = candidates.map(({ meta, state }, index) => {
    const hash = workspaceHash(meta.id);
    const designed = index === 0 ? input.designedPlanet : null;
    return {
      id: meta.id,
      mass: designed?.mass ?? planetMassOf(meta.stats?.tokens.total ?? null),
      composition: designed?.composition ?? COMPOSITIONS[hash % COMPOSITIONS.length] ?? "rock",
      orbitRadius: orbitRadiusOf(index, candidates.length),
      inclinationDeg: ((hash >>> 3) % 11) - 5,
      nodeDeg: (hash >>> 7) % 360,
      phaseDeg: (hash >>> 13) % 360,
      state,
      label: meta.title.trim(),
    };
  });
  return {
    spec: {
      starMass: input.starMass,
      ...(input.starExtent === undefined ? {} : { starExtent: input.starExtent }),
      planets,
      sessions: roots.filter((meta) => !planetIds.has(meta.id)).length + retired,
    },
    planetIds: candidates.map(({ meta }) => meta.id),
  };
}

/**
 * 编排星系：行星 = 子智能体（设计稿），会话 = 碎石。在做事的会话（根会话自己在跑 / 等你、子会话在跑 / 等你）
 * 拎成碎石块，按「等你 > 在跑」、同档最近活动在前排序；其余会话都是星屑带里的一粒（只计数）。
 */
function agentGalaxy(input: ScopeGalaxyInput, agents: readonly AgentPlanetInput[], roots: readonly SessionMeta[], children: readonly SessionMeta[]): ScopeGalaxy {
  const ownStateOf = input.ownStateOf ?? input.stateOf;
  const active: { meta: SessionMeta; state: "waiting" | "running" }[] = [];
  for (const meta of roots) {
    const state = ownStateOf(meta);
    if (state === "running" || state === "waiting") active.push({ meta, state });
  }
  for (const meta of children) {
    const state = input.stateOf(meta);
    if (state === "running" || state === "waiting") active.push({ meta, state });
  }
  active.sort((a, b) => rankOf(a.state) - rankOf(b.state) || b.meta.updatedAt - a.meta.updatedAt || a.meta.id.localeCompare(b.meta.id));
  // 最多拎出 ROCK_CAP 块（等你的排在前面，一定在里面）；再多的只是星屑里的一粒，计数里有、「+N」里有
  const rocks: RockSpec[] = active.slice(0, ROCK_CAP).map(({ meta, state }) => ({ id: meta.id, state, label: meta.title.trim() }));
  const planets: PlanetSpec[] = agents.map((agent) => {
    const hash = workspaceHash(agent.id);
    return {
      id: agent.id,
      mass: agent.mass,
      composition: agent.composition,
      orbitRadius: agent.orbitRadius,
      inclinationDeg: ((hash >>> 3) % 11) - 5,
      nodeDeg: (hash >>> 7) % 360,
      phaseDeg: (hash >>> 13) % 360,
      state: null,
    };
  });
  const activeChildren = active.filter(({ meta }) => meta.parentId !== undefined).length;
  return {
    spec: {
      starMass: input.starMass,
      ...(input.starExtent === undefined ? {} : { starExtent: input.starExtent }),
      planets,
      sessions: roots.length + activeChildren,
      rocks,
    },
    planetIds: [],
  };
}

/**
 * 工作区此刻的样子（侧栏智能体行的第二行与时间、工作区页页头的状态胶囊、星系碎石共用）。
 * 「等你 / 在跑」按**件**数（2026-11-24 设计审查 R2：页头说 1、星系画 3，同一屏两个数）：
 * 根会话看它自己的槽（不含子会话），子会话各算一件——与星系拎成碎石块的口径（agentGalaxy）逐件一致。
 * 一条母会话自己空着、两个孩子都在等你 = 两件，不是一件。
 */
export interface ScopeSummary {
  /** 等你的件数（根会话自己 + 子会话） */
  waiting: number;
  /** 在跑的件数（同上） */
  running: number;
  /** 根会话总数（不含归档） */
  total: number;
  /** 最近一次活动（根会话 updatedAt 的最大值）；没有会话为 null */
  lastActive: number | null;
  /** 最近活动的那条会话的标题（第二行在不忙时说「最近在聊什么」） */
  lastTitle: string | null;
  /** 最近一件等你的会话（根会话或子会话；页头「等你」胶囊点了直达它）；没有为 null */
  waitingId: string | null;
  /**
   * 要你看一眼的根会话数：等你的 + 跑完没看 / 出错没看的，**不含眼下正开着的那条**（你正看着它，就不算「没看」）。
   * 侧栏行的小圆点只在它 > 0 时出现；看过即退。等你的状态本身（「等你 · N」）不因看过而消失——事还没办。
   */
  attention: number;
}

/**
 * 状态来源：StateIndex（state 含子会话的汇总态、own 只看自己的槽）；只给一个函数时两者同一个（测试里逐条写死状态时用）。
 */
export type SummaryStates = Pick<StateIndex, "state" | "own"> | ((meta: SessionMeta) => SessionRunState);

/** 没有运行态可读时（单智能体侧栏不算编排状态）：一律空闲 */
export const NO_STATES: SummaryStates = () => null;

export function scopeSummary(
  sessions: readonly SessionMeta[],
  workspaceId: string | null,
  states: SummaryStates,
  viewedId: string | null = null,
): ScopeSummary {
  const { roots, children } = scopeMembers(sessions, workspaceId);
  const stateOf = typeof states === "function" ? states : states.state;
  const ownOf = typeof states === "function" ? states : states.own;
  let attention = 0;
  let waiting = 0;
  let running = 0;
  let last: SessionMeta | null = null;
  // 闭包里改的东西放进对象：let 在闭包里赋值，TS 收窄不到
  const pick: { waiting: SessionMeta | null } = { waiting: null };
  const count = (meta: SessionMeta, state: SessionRunState): void => {
    if (state === "waiting") {
      waiting += 1;
      if (pick.waiting === null || meta.updatedAt > pick.waiting.updatedAt) pick.waiting = meta;
    } else if (state === "running") running += 1;
  };
  for (const meta of roots) {
    // 小圆点（要你看一眼）仍按根会话的汇总态：它说的是「侧栏这一行有没有要点开的」
    const state = stateOf(meta);
    if (state !== null && state !== "running" && meta.id !== viewedId) attention += 1;
    count(meta, ownOf(meta));
    if (last === null || meta.updatedAt > last.updatedAt) last = meta;
  }
  // 子会话各算一件（与星系碎石同口径：子会话读 state，孙会话的事记在它头上）
  for (const meta of children) count(meta, stateOf(meta));
  return {
    waiting,
    running,
    total: roots.length,
    lastActive: last?.updatedAt ?? null,
    lastTitle: last === null ? null : last.title.trim() || null,
    waitingId: pick.waiting === null ? null : pick.waiting.id,
    attention,
  };
}

/** 菜单里只分三档：等你、在跑、其余（跑完没看 / 出错没看按最近活动排，不压过在跑的） */
function menuRank(state: SessionRunState): number {
  return state === "waiting" ? 0 : state === "running" ? 1 : 2;
}

/** 页头「会话」菜单列几条：编排侧不展示单智能体那套会话树，回看靠这一小串 + 「在单智能体里看全部」 */
export const RECENT_MENU_LIMIT = 8;

/**
 * 这个工作区最近的根会话：等你 → 在跑 → 其余按最近活动，只取前 limit 条；total 是不含归档的根会话总数
 * （菜单尾写「还有 N 条」，不悄悄藏）。只在菜单打开时算一次，2000 条排一遍序也是毫秒级。
 */
export function scopeRecent(
  sessions: readonly SessionMeta[],
  workspaceId: string | null,
  stateOf: (meta: SessionMeta) => SessionRunState,
  limit: number = RECENT_MENU_LIMIT,
): { rows: { meta: SessionMeta; state: SessionRunState }[]; total: number } {
  const { roots } = scopeMembers(sessions, workspaceId);
  const rows = roots
    .map((meta) => ({ meta, state: stateOf(meta) }))
    .sort((a, b) => menuRank(a.state) - menuRank(b.state) || b.meta.updatedAt - a.meta.updatedAt || a.meta.id.localeCompare(b.meta.id))
    .slice(0, limit);
  return { rows, total: roots.length };
}

/** 页头胶囊与侧栏行说哪一种状态：等你压过在跑（更具体、要你动手），都没有就是就绪 */
export type ScopeTone = "waiting" | "running" | "idle";

export function scopeTone(summary: Pick<ScopeSummary, "waiting" | "running">): ScopeTone {
  if (summary.waiting > 0) return "waiting";
  if (summary.running > 0) return "running";
  return "idle";
}

/**
 * 切到编排时落在哪个工作区：最近有过根会话活动的那个；没有活动过的就取列表第一个；一个工作区也没有为 null。
 * （编排没有「不属于任何工作区」的首页：进去先落在一座具体的星系上。）
 */
export function latestWorkspaceId(
  sessions: readonly SessionMeta[],
  workspaces: readonly { id: string }[],
): string | null {
  const known = new Set(workspaces.map((workspace) => workspace.id));
  let best: SessionMeta | null = null;
  for (const meta of sessions) {
    if (meta.parentId !== undefined || !listed(meta) || meta.workspaceId === null || !known.has(meta.workspaceId)) continue;
    if (best === null || meta.updatedAt > best.updatedAt) best = meta;
  }
  return best?.workspaceId ?? workspaces[0]?.id ?? null;
}
