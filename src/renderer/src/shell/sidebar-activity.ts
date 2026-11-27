import type { SessionMeta } from "@shared/session";
// 值 import 走相对路径：node --test 解析不了 @shared 别名
import { attributionOf } from "../../../shared/session.ts";
import { scopeMembers, type SummaryStates } from "../features/chat/galaxy-data.ts";

/**
 * 编排侧栏智能体行的「谁在干活」（2026-11-24 用户在三个候选里挑了「行首」那个）：
 * 主智能体在干活 = 头像外一圈细日冕呼吸；派出的会话在跑 = 状态词后一根插入符；子智能体在干活 = 第二行最前面一串小头像。
 *
 * 真实数据里分三种：
 * - 根会话自己的槽在跑 = 主智能体在干活（用户和主智能体的对话）；在等你 = 主智能体在等你；
 * - 子会话归某个子智能体（attributionOf：指名派活记下的，以后也有记忆系统推断、比例够高的）= 那个子智能体在干活；
 * - 其余子会话在跑 = 派出去的（临时）会话在跑。
 * 演示数据（SubAgentFixture，地址带 ?fixture=sub-agents 才认）照旧能叠上来，只用来拍满载。
 *
 * 口径与 scopeSummary 逐件一致：根会话读自己的槽（own），子会话读含孙会话的汇总态（state）；
 * 所以 mainWorking + sessionsRunning + Σ子智能体 running = summary.running（waiting 同理，见测试）。
 * 星际空间（workspaceId = null）没有主智能体：它的根会话在跑算会话，不算主智能体。
 */
export interface RowActivity {
  /** 主智能体自己：等你优先于在干活（等你时不演「在干活」的动效，免得把等你压下去） */
  main: "waiting" | "working" | "idle";
  /** 在跑的根会话件数（星际空间恒为 0） */
  mainWorking: number;
  mainWaiting: number;
  /** 在跑 / 等你的派出会话件数（星际空间里含根会话） */
  sessionsRunning: number;
  sessionsWaiting: number;
  /** 有归属的子会话按子智能体聚起来（次序 = 会话列表里第一次出现的次序）；不在这里面的才算进上面两个数 */
  subAgents: SubAgentActivity[];
}

/** 一个子智能体此刻的活：它名下在跑 / 等你的会话件数；有一件等你就是 waiting */
export interface SubAgentActivity {
  id: string;
  state: "working" | "waiting";
  running: number;
  waiting: number;
}

/**
 * 每个子智能体名下的会话（按归属 attributionOf 认，不论状态）：侧栏只取在跑 / 等你的，
 * 下一轮星系里的卫星（在跑 / 等你）与光环（做完的）也从这里取——同一份归属读法，不各算各的。
 */
export function subAgentSessionsOf(sessions: readonly SessionMeta[], workspaceId: string | null): Map<string, SessionMeta[]> {
  const out = new Map<string, SessionMeta[]>();
  if (workspaceId === null) return out;
  const { children } = scopeMembers(sessions, workspaceId);
  for (const meta of children) {
    const owner = attributionOf(meta);
    if (owner === null) continue;
    const list = out.get(owner.subAgentId);
    if (list === undefined) out.set(owner.subAgentId, [meta]);
    else list.push(meta);
  }
  return out;
}

export function rowActivityOf(sessions: readonly SessionMeta[], workspaceId: string | null, states: SummaryStates): RowActivity {
  const { roots, children } = scopeMembers(sessions, workspaceId);
  const stateOf = typeof states === "function" ? states : states.state;
  const ownOf = typeof states === "function" ? states : states.own;
  const hasMain = workspaceId !== null;
  let mainWorking = 0;
  let mainWaiting = 0;
  let sessionsRunning = 0;
  let sessionsWaiting = 0;
  for (const meta of roots) {
    const state = ownOf(meta);
    if (state === "running") {
      if (hasMain) mainWorking += 1;
      else sessionsRunning += 1;
    } else if (state === "waiting") {
      if (hasMain) mainWaiting += 1;
      else sessionsWaiting += 1;
    }
  }
  const agents = new Map<string, SubAgentActivity>();
  for (const meta of children) {
    const state = stateOf(meta);
    if (state !== "running" && state !== "waiting") continue;
    // 星际空间没有主星，也就没有行星：那里的归属不认
    const owner = hasMain ? attributionOf(meta) : null;
    if (owner === null) {
      if (state === "running") sessionsRunning += 1;
      else sessionsWaiting += 1;
      continue;
    }
    const entry = agents.get(owner.subAgentId) ?? { id: owner.subAgentId, state: "working" as const, running: 0, waiting: 0 };
    if (state === "running") entry.running += 1;
    else entry.waiting += 1;
    agents.set(owner.subAgentId, { ...entry, state: entry.waiting > 0 ? "waiting" : "working" });
  }
  const main = mainWaiting > 0 ? "waiting" : mainWorking > 0 ? "working" : "idle";
  return { main, mainWorking, mainWaiting, sessionsRunning, sessionsWaiting, subAgents: [...agents.values()] };
}

/** 演示数据里的一个子智能体：planet = 这座星系设计稿里第几颗行星（名字与形象是真的，「在干活」是演示的） */
export interface SubAgentFixture {
  planet: number;
  state: "working" | "waiting";
  /** 真数据（有归属的会话）为 false；缺席 = 演示数据（悬停提示写「演示数据」） */
  demo?: boolean;
}

/**
 * 真数据 → 小头像要的形状：只画设计稿名单里还在的那几个（planetIds = 名单里每颗的 id，按次序）；
 * 档案已删的那几个不画头像，它名下的会话退回去算普通会话的插入符（leftover）。
 */
export function realSubAgentFaces(
  activity: readonly SubAgentActivity[],
  planetIds: readonly (string | undefined)[],
): { faces: SubAgentFixture[]; leftoverRunning: number; leftoverWaiting: number } {
  const faces: SubAgentFixture[] = [];
  let leftoverRunning = 0;
  let leftoverWaiting = 0;
  for (const agent of activity) {
    const planet = planetIds.indexOf(agent.id);
    if (planet < 0) {
      leftoverRunning += agent.running;
      leftoverWaiting += agent.waiting;
      continue;
    }
    faces.push({ planet, state: agent.state, demo: false });
  }
  return { faces, leftoverRunning, leftoverWaiting };
}

/** 按工作区名给演示数据（只在原型里用 window.orbitaProto.set({ subAgents }) 注入） */
export type SubAgentFixtures = Readonly<Record<string, readonly SubAgentFixture[]>>;

/**
 * 子智能体小头像的次序：等你的在前（同一档按给的次序）。**全部都画，不折成「+N」**
 * （2026-11-24 用户：「我不喜欢被简略，看到越多子智能体在干活，我觉得越爽」；太密了再说）。
 */
export function orderedSubAgents(list: readonly SubAgentFixture[]): SubAgentFixture[] {
  return list
    .map((agent, index) => ({ agent, index }))
    .sort((a, b) => (a.agent.state === "waiting" ? 0 : 1) - (b.agent.state === "waiting" ? 0 : 1) || a.index - b.index)
    .map((item) => item.agent);
}

/** 演示数据开关：地址带 ?fixture=sub-agents 时才收 window.orbitaProto.set({ subAgents }) */
export const SUB_AGENT_FIXTURE = "sub-agents";

export function subAgentFixtureEnabled(search: string): boolean {
  return new URLSearchParams(search).getAll("fixture").includes(SUB_AGENT_FIXTURE);
}

/** 坏数据整份忽略：只认 { 名字: [{ planet: 非负整数, state }] } */
export function subAgentFixturesOf(value: unknown): SubAgentFixtures | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const out: Record<string, SubAgentFixture[]> = {};
  for (const [name, list] of Object.entries(value)) {
    if (!Array.isArray(list)) return null;
    const agents: SubAgentFixture[] = [];
    for (const item of list) {
      if (typeof item !== "object" || item === null) return null;
      const planet: unknown = Reflect.get(item, "planet");
      const state: unknown = Reflect.get(item, "state");
      if (typeof planet !== "number" || !Number.isInteger(planet) || planet < 0) return null;
      if (state !== "working" && state !== "waiting") return null;
      agents.push({ planet, state });
    }
    out[name] = agents;
  }
  return out;
}
