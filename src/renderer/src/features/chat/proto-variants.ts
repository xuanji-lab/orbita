/**
 * 编排页的候选版式（原型，等用户挑）。两个开关，**运行时可切**（不用重载页面——重载会丢掉在跑 / 等你的界面状态）：
 *   window.orbitaProto.set({ title: "both" })     // 或 "header"（缺省）
 *   window.orbitaProto.set({ avatar: "same" })    // 或 "seeded"（缺省）
 * 初值也可以从地址读：`?title=both&avatar=same`。
 * - title=header（缺省，2026-11-24 主会话定）：去掉大标题、切换箭头与 slogan（换工作区靠侧栏），名字只在页头出现一次。slogan 不留：它是每个工作区都一样的
 *   品牌句，不说这个工作区的事；空星系下一步该做什么由星系下面那一句「还没有派出的活，在下面写一件事」说；
 *   title=both：页头胶囊之外，页面左上还有大标题「<工作区名> 星系 ⌄」+ slogan（第一版的样子，留作对比）。
 * - avatar=seeded（缺省）：没设计过的工作区按 id 取一套稳定的种子稿；avatar=same：全部同一颗默认主星（现状）。
 * - agentName=off（缺省）：侧栏、页头、设计面板都以工作区名为主名、智能体名为副（用户原话「头像加工作区名字」）；
 *   agentName=on：反过来，侧栏写「智能体名 · 工作区名」、页头与面板以智能体名为主。
 *   （主智能体还没起名的工作区照旧只写工作区名）。window.orbitaProto.set({ agentName: "on" })
 */
export type WsTitleVariant = "both" | "header";
export type AvatarVariant = "seeded" | "same";
export type AgentNameVariant = "off" | "on";

export interface ProtoVariants {
  title: WsTitleVariant;
  avatar: AvatarVariant;
  agentName: AgentNameVariant;
}

export function agentNameVariantOf(search: string): AgentNameVariant {
  return new URLSearchParams(search).get("agentName") === "on" ? "on" : "off";
}

/** 侧栏一行的主标签：候选开着且主智能体有名字时写「智能体名 · 工作区名」，否则只写工作区名 */
export function rowLabelOf(variant: AgentNameVariant, workspaceName: string, agentName: string): string {
  const agent = agentName.trim();
  return variant === "on" && agent !== "" && agent !== workspaceName ? `${agent} · ${workspaceName}` : workspaceName;
}

/**
 * 页头与设计面板的名字顺序（用户原话「左侧栏是头像加工作区名字」）：默认工作区名为主、智能体名为副；
 * 候选 agentName=on 时反过来。智能体还没起名（或与工作区同名）时只有主名。
 */
export function nameOrderOf(variant: AgentNameVariant, workspaceName: string, agentName: string): { primary: string; secondary: string | null } {
  const agent = agentName.trim();
  if (agent === "" || agent === workspaceName) return { primary: workspaceName, secondary: null };
  return variant === "on" ? { primary: agent, secondary: workspaceName } : { primary: workspaceName, secondary: agent };
}

export function wsTitleVariantOf(search: string): WsTitleVariant {
  return new URLSearchParams(search).get("title") === "both" ? "both" : "header";
}

export function avatarVariantOf(search: string): AvatarVariant {
  return new URLSearchParams(search).get("avatar") === "same" ? "same" : "seeded";
}

/** 合并补丁：只认合法值，坏值忽略 */
export function mergeVariants(current: ProtoVariants, patch: Partial<Record<keyof ProtoVariants, unknown>>): ProtoVariants {
  return {
    title: patch.title === "header" || patch.title === "both" ? patch.title : current.title,
    avatar: patch.avatar === "same" || patch.avatar === "seeded" ? patch.avatar : current.avatar,
    agentName: patch.agentName === "on" || patch.agentName === "off" ? patch.agentName : current.agentName,
  };
}
