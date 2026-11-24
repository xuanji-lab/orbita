import type { SessionMeta } from "@shared/session";
import { scopeMembers, type SummaryStates } from "../features/chat/galaxy-data.ts";

/**
 * 侧栏智能体行的「谁在干活」（原型，等用户挑；window.orbitaProto.set({ sidebarActivity: "a" | "b" | "c" })，默认 off = 现状）。
 *
 * 真实数据里能分清的只有两种（这条线还是旧内核，会话与持久子智能体之间没有归属关系）：
 * - 根会话自己的槽在跑 = 主智能体在干活（用户和主智能体的对话）；在等你 = 主智能体在等你；
 * - 子会话在跑 = 派出去的会话在跑。
 * 「某个子智能体在干活」现在只能来自演示数据（SubAgentFixture），等内核线接上归属后再走真数据——
 * 不拿真实会话去冒充子智能体。
 *
 * 口径与 scopeSummary 逐件一致：根会话读自己的槽（own），子会话读含孙会话的汇总态（state）；
 * 所以 mainWorking + sessionsRunning = summary.running、mainWaiting + sessionsWaiting = summary.waiting（见测试）。
 * 星际空间（workspaceId = null）没有主智能体：它的根会话在跑算会话，不算主智能体。
 */
export type ActivityVariant = "off" | "a" | "b" | "c";

export interface RowActivity {
  /** 主智能体自己：等你优先于在干活（等你时不演「在干活」的动效，免得把等你压下去） */
  main: "waiting" | "working" | "idle";
  /** 在跑的根会话件数（星际空间恒为 0） */
  mainWorking: number;
  mainWaiting: number;
  /** 在跑 / 等你的派出会话件数（星际空间里含根会话） */
  sessionsRunning: number;
  sessionsWaiting: number;
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
  for (const meta of children) {
    const state = stateOf(meta);
    if (state === "running") sessionsRunning += 1;
    else if (state === "waiting") sessionsWaiting += 1;
  }
  const main = mainWaiting > 0 ? "waiting" : mainWorking > 0 ? "working" : "idle";
  return { main, mainWorking, mainWaiting, sessionsRunning, sessionsWaiting };
}

/** 演示数据里的一个子智能体：planet = 这座星系设计稿里第几颗行星（名字与形象是真的，「在干活」是演示的） */
export interface SubAgentFixture {
  planet: number;
  state: "working" | "waiting";
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

export function activityVariantOf(value: unknown): ActivityVariant | null {
  return value === "off" || value === "a" || value === "b" || value === "c" ? value : null;
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
