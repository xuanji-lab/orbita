import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import {
  SUB_AGENT_MASS_EARTH,
  SUB_AGENT_NAME_MAX,
  SUB_AGENT_ROLE_MAX,
  type SubAgentCreateInput,
  type SubAgentToolOutcome,
  type SubAgentToolRequest,
  type SubAgentTurnIdentity,
  type SubAgentUpdateInput,
} from "../shared/sub-agent.ts";

/**
 * 子智能体工具：create_sub_agent / update_sub_agent / list_sub_agents（2026-11-24 用户：「主智能体拥有创建子智能体的权限吗……
 * chat 可能主要是沉淀出子智能体的 prompt（职能）和 AVATAR，真正的位于星系什么位置，可以弹出右侧面板，让用户设置」）。
 *
 * 照 automation-tools 的范式：agent 进程只把参数翻成 subAgentRequest、把回执翻成工具结果；校验（名字、职能、质量不越过主星、
 * 同名冲突）与写盘都在主进程，这里的校验只是让模型少撞一次墙。只在编排形态、有工作区的根会话里注册（主进程按 subAgentTools 装配）。
 * 没有删除工具：删一个子智能体要用户在面板里确认。位置（轨道）也不让模型给——主进程放一圈默认空轨道，建完弹面板让用户定。
 */

export const SUB_AGENT_TOOL_NAMES = ["create_sub_agent", "update_sub_agent", "list_sub_agents"] as const;

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`"${field}" must be a string.`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${field}" is required and must be a non-empty string.`);
  return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`"${field}" must be a number.`);
  return value;
}

/** create 的参数 → 契约形状（字段名与 shared 一致；model 是 modelId 的简写） */
export function toCreateInput(raw: unknown): SubAgentCreateInput {
  const args = (raw ?? {}) as Record<string, unknown>;
  const name = requireString(args["name"], "name");
  const role = requireString(args["role"], "role");
  const model = optionalString(args["model"], "model");
  const massEarth = optionalNumber(args["massEarth"], "massEarth");
  const composition = optionalString(args["composition"], "composition");
  if (composition !== undefined && composition !== "rock" && composition !== "ice" && composition !== "gas") {
    throw new Error('"composition" must be "rock", "ice" or "gas".');
  }
  const surfacePath = optionalString(args["surfacePath"], "surfacePath");
  return {
    name,
    role,
    ...(model === undefined || model.trim() === "" ? {} : { modelId: model }),
    ...(massEarth === undefined ? {} : { massEarth }),
    ...(composition === undefined ? {} : { composition }),
    ...(surfacePath === undefined || surfacePath.trim() === "" ? {} : { surfacePath }),
  };
}

export function toUpdateInput(raw: unknown): SubAgentUpdateInput {
  const args = (raw ?? {}) as Record<string, unknown>;
  const id = requireString(args["id"], "id");
  const name = optionalString(args["name"], "name");
  const role = optionalString(args["role"], "role");
  const surfacePath = optionalString(args["surfacePath"], "surfacePath");
  const modelRaw = args["model"];
  if (modelRaw !== undefined && modelRaw !== null && typeof modelRaw !== "string") throw new Error('"model" must be a model id string, or "" to clear it.');
  const input: SubAgentUpdateInput = { id };
  if (name !== undefined) input.name = name;
  if (role !== undefined) input.role = role;
  if (surfacePath !== undefined && surfacePath.trim() !== "") input.surfacePath = surfacePath;
  if (modelRaw === null || modelRaw === "") input.modelId = null;
  else if (typeof modelRaw === "string") input.modelId = modelRaw;
  if (input.name === undefined && input.role === undefined && input.modelId === undefined && input.surfacePath === undefined) {
    throw new Error("Nothing to update: pass at least one of name, role, model, surfacePath.");
  }
  return input;
}

function toToolResult(outcome: SubAgentToolOutcome): { content: { type: "text"; text: string }[]; details: { subAgentId?: string } } {
  if (!outcome.ok) throw new Error(outcome.error);
  return { content: [{ type: "text", text: outcome.text }], details: outcome.id === undefined ? {} : { subAgentId: outcome.id } };
}

export function createSubAgentTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  const ask = (request: SubAgentToolRequest): Promise<SubAgentToolOutcome> =>
    broker.request<SubAgentToolOutcome>({ type: "subAgentRequest", sessionId, request });
  return [
    {
      name: "create_sub_agent",
      label: "create_sub_agent",
      description:
        "Create a persistent sub-agent of this workspace's main agent (you): a planet in the workspace's galaxy with its own name and role prompt, " +
        "that you can later hand tasks to with delegate's subAgentId. Use it only after the user has agreed on what the sub-agent is for — " +
        "read the sub-agents skill first: ask what it is responsible for, how it should work and where its limits are, then write the role " +
        "prompt yourself (second person: who it is, what it owns, how it works, what it must not do). Do not choose an orbit or position: the app " +
        "puts it on a free default orbit and opens the Galaxy Design panel so the user sets orbit and mass. " +
        `name: at most ${SUB_AGENT_NAME_MAX} characters, not the main agent's name, not an existing sub-agent's name (call list_sub_agents first). ` +
        `massEarth (optional, Earth masses, ${SUB_AGENT_MASS_EARTH.min}–${SUB_AGENT_MASS_EARTH.max}) must stay well below the main star: at most 10% of its mass. ` +
        "surfacePath (optional): absolute path to a face-less planet surface image (png/jpg/webp, e.g. made with the Qwen image tool following the planet-forge flow); " +
        "without it the planet is a code-drawn default sphere marked as image pending. Eyes and rings are drawn by code — never put a face in the image.",
      promptSnippet: "Create a persistent sub-agent (a planet in this workspace's galaxy) with a name and role prompt",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: `Display name, at most ${SUB_AGENT_NAME_MAX} characters, in the user's language.` },
          role: {
            type: "string",
            description: `The role prompt (at most ${SUB_AGENT_ROLE_MAX} characters): who it is, what it is responsible for, how it works, its boundaries. Becomes part of the system prompt of every task delegated to it.`,
          },
          model: { type: "string", description: "Optional default model id for its tasks (as listed by model_costs)." },
          massEarth: { type: "number", description: "Optional mass in Earth masses; default 2 (capped at 10% of the main star)." },
          composition: { type: "string", enum: ["rock", "ice", "gas"], description: "Optional; affects only density, texture and size, never its role." },
          surfacePath: { type: "string", description: "Optional absolute path to a face-less surface image for its avatar." },
        },
        required: ["name", "role"],
      } as never,
      async execute(_toolCallId, params) {
        return toToolResult(await ask({ action: "create", input: toCreateInput(params) }));
      },
    },
    {
      name: "update_sub_agent",
      label: "update_sub_agent",
      description:
        "Change an existing sub-agent's name, role prompt, default model or avatar surface image (id from list_sub_agents). Only the fields you pass change; " +
        'pass model "" to clear its default model. Orbit and mass are the user\'s to set in the Galaxy Design panel; deleting a sub-agent is also done there by the user.',
      promptSnippet: "Change a sub-agent's name, role prompt, default model or avatar image",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "The sub-agent id (from list_sub_agents)." },
          name: { type: "string", description: `New name, at most ${SUB_AGENT_NAME_MAX} characters.` },
          role: { type: "string", description: "The full new role prompt (replaces the old one)." },
          model: { type: "string", description: 'Default model id, or "" to clear.' },
          surfacePath: { type: "string", description: "Absolute path to a new face-less surface image." },
        },
        required: ["id"],
      } as never,
      async execute(_toolCallId, params) {
        return toToolResult(await ask({ action: "update", input: toUpdateInput(params) }));
      },
    },
    {
      name: "list_sub_agents",
      label: "list_sub_agents",
      description:
        "List this workspace's persistent sub-agents (id, name, first line of the role, default model, whether the avatar image is still pending). " +
        "Read-only, no arguments. Call it before create_sub_agent (to avoid duplicates) and before delegate when a sub-agent fits the task.",
      promptSnippet: "List this workspace's persistent sub-agents and their roles",
      parameters: { type: "object", properties: {}, required: [] } as never,
      async execute() {
        return toToolResult(await ask({ action: "list" }));
      },
    },
  ];
}

/**
 * 主智能体这边的一段提示（注册了子智能体工具才讲）：工具描述只在模型想起来时才读，派活前「先看看有没有合适的子智能体」要写进系统提示。
 */
export const SUB_AGENTS_MAIN_GUIDELINE = `<orbita-sub-agents>
You are this workspace's main agent (its main star). You can keep persistent sub-agents (planets): each has a name and a role prompt
the user agreed on. When a task fits one of them, call list_sub_agents and pass its id as delegate's subAgentId — the task then runs
as that sub-agent, with its role in the sub-session's system prompt, and shows up as its work in the sidebar. When the user wants a new
sub-agent, follow the sub-agents skill: settle its responsibility, way of working and limits with the user, write the role prompt, then
create_sub_agent; never pick its orbit or position yourself — the app opens the Galaxy Design panel for the user to place it.
</orbita-sub-agents>`;

/** 子会话这边：指名派给了某个子智能体时，它的职能进系统提示（runtime 每轮按命令里的 subAgent 讲） */
export function describeSubAgentIdentity(identity: SubAgentTurnIdentity): string {
  return `<orbita-sub-agent id="${identity.id}">
You are working as "${identity.name}", a persistent sub-agent (a planet) of this workspace's main agent. The user and the main agent
defined your role as follows; stay within it, and if the task falls outside it, say so in a question report instead of improvising.
<role>
${identity.role}
</role>
</orbita-sub-agent>`;
}
