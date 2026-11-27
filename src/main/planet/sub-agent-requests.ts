/**
 * agent 的 create_sub_agent / update_sub_agent / revise_sub_agent_avatar / list_sub_agents 落地（subAgentRequest 事件），纯核 + 注入，可直测。
 * runtime 只在「编排形态 + 有工作区 + 根会话」时注册这些工具；这里再核一遍（工具描述被无视、设置在这一轮中途切了形态），
 * 信任边界在主进程。建完 / 改完广播 subAgentsChanged：renderer 重读星系，聊天里新建的弹出设计面板停在它上面。
 */
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import { AVATAR_INSTRUCTION_MAX } from "../../shared/planet-avatar.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { AppSettings } from "../../shared/settings.ts";
import type { SubAgentListItem, SubAgentsChanged, SubAgentToolOutcome } from "../../shared/sub-agent.ts";
import type { Workspace } from "../../shared/workspace.ts";
import type { SubAgentStore } from "./sub-agents.ts";

export interface SubAgentRequestDeps {
  sessions: { readMeta(id: string): Promise<SessionMeta | null> };
  workspaces: { list(): Promise<Workspace[]> };
  settings: { read(): Promise<AppSettings> };
  store: SubAgentStore;
  broadcast(event: SubAgentsChanged): void;
  /**
   * 建完没带地表图时开一组形象候选（与星系设计面板「生成形象」同一套：planet/avatar.ts）。
   * 缺席 = 不自动出图（测试 / 出图没接上），行星先用代码画的默认球。
   */
  startAvatar?: (workspaceId: string, bodyId: string, instruction?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}

/** 这条会话能不能管子智能体：编排形态、属于某个工作区（星际空间没有主星）、是根会话（主智能体本人） */
export async function subAgentScope(
  deps: Pick<SubAgentRequestDeps, "sessions" | "workspaces" | "settings">,
  sessionId: string,
): Promise<{ ok: true; workspace: Workspace } | { ok: false; error: string }> {
  const meta = await deps.sessions.readMeta(sessionId);
  if (meta === null) return { ok: false, error: `Session ${sessionId} was not found.` };
  if (meta.parentId !== undefined) return { ok: false, error: "子会话不能建或改子智能体——只有工作区的主智能体能。" };
  if ((await deps.settings.read()).appMode !== "orchestrate") return { ok: false, error: "子智能体只在编排形态里可用（侧栏顶部切到「编排」）。" };
  if (meta.workspaceId === null) return { ok: false, error: "这条会话不属于任何工作区（星际空间没有主星），不能建子智能体。" };
  const workspace = (await deps.workspaces.list()).find((each) => each.id === meta.workspaceId);
  if (workspace === undefined) return { ok: false, error: "这条会话的工作区已经不在了。" };
  return { ok: true, workspace };
}

function describe(agent: SubAgentListItem): string {
  const role = agent.role === null ? "(no role yet)" : agent.role.split("\n")[0]?.slice(0, 120) ?? "";
  const bits = [
    agent.massEarth === null ? null : `${agent.massEarth} M⊕`,
    agent.modelId === null ? null : `model ${agent.modelId}`,
    agent.hasSurface ? "has avatar image" : "avatar image pending (code-drawn default sphere)",
  ].filter((bit): bit is string => bit !== null);
  return `- ${agent.id} · "${agent.name}" · ${bits.join(" · ")}\n  role: ${role}`;
}

export async function applySubAgentRequest(
  deps: SubAgentRequestDeps,
  event: Extract<AgentEvent, { type: "subAgentRequest" }>,
): Promise<SubAgentToolOutcome> {
  const scope = await subAgentScope(deps, event.sessionId);
  if (!scope.ok) return scope;
  const { workspace } = scope;
  const request = event.request;
  if (request.action === "list") {
    const agents = await deps.store.list(workspace.path);
    const text =
      agents.length === 0
        ? `Workspace "${workspace.name}" has no sub-agents yet.`
        : `Sub-agents of workspace "${workspace.name}" (pass an id as delegate's subAgentId to run a task as that sub-agent):\n${agents.map(describe).join("\n")}`;
    return { ok: true, text, agents };
  }
  if (request.action === "create") {
    const created = await deps.store.create(workspace.path, request.input, "chat", workspace.id);
    if (!created.ok) return { ok: false, error: created.error };
    deps.broadcast({ workspaceId: workspace.id, subAgentId: created.value.id, action: "created", source: "chat", sessionId: event.sessionId });
    let pending = "";
    if (request.input.surfacePath === undefined) {
      // 形象走面板同一套出图：候选出在设计面板里、由用户挑；主智能体自己不要再出图
      const avatar = deps.startAvatar === undefined ? null : await deps.startAvatar(workspace.id, created.value.id).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }));
      pending =
        avatar !== null && avatar.ok
          ? " Avatar candidates are now being generated in the background by the planet-forge plugin; they appear in the Galaxy Design panel and the user picks one there — do not generate or set an avatar image yourself."
          : ` Its avatar is the code-drawn default sphere for now (image pending${avatar === null ? "" : `: avatar generation did not start — ${avatar.error}`}).`;
    }
    return {
      ok: true,
      id: created.value.id,
      text:
        `Sub-agent "${created.value.name}" created (id ${created.value.id}) as a new planet in workspace "${workspace.name}", on a default free orbit.${pending} ` +
        "The Galaxy Design panel has opened on it so the user can set its orbit and mass — do not pick a position yourself. " +
        "Tell the user in one or two sentences what was saved and that they can adjust the orbit and mass in the panel.",
    };
  }
  if (request.action === "reviseAvatar") {
    const instruction = request.input.instruction.trim();
    if (instruction === "" || instruction.length > AVATAR_INSTRUCTION_MAX) return { ok: false, error: `Avatar instruction must be 1–${AVATAR_INSTRUCTION_MAX} characters.` };
    if (deps.startAvatar === undefined) return { ok: false, error: "Avatar generation is not available." };
    const avatar = await deps.startAvatar(workspace.id, request.input.id, instruction).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : String(cause) }));
    if (!avatar.ok) return avatar;
    // action=avatar 让正看着这条主会话的界面弹到这颗行星；候选与面板里的「按这个改」完全同源
    deps.broadcast({ workspaceId: workspace.id, subAgentId: request.input.id, action: "avatar", source: "chat", sessionId: event.sessionId });
    return {
      ok: true,
      id: request.input.id,
      text: `Avatar revision started for sub-agent ${request.input.id}: "${instruction}". The Galaxy Design panel has opened on it; new candidates will appear there and the user picks one. Do not generate, choose or set the avatar yourself.`,
    };
  }
  const updated = await deps.store.update(workspace.path, request.input, "chat");
  if (!updated.ok) return { ok: false, error: updated.error };
  deps.broadcast({ workspaceId: workspace.id, subAgentId: updated.value.id, action: "updated", source: "chat", sessionId: event.sessionId });
  return { ok: true, id: updated.value.id, text: `Sub-agent "${updated.value.name}" (id ${updated.value.id}) updated.` };
}
