import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";

/**
 * agent 的「自我配置」工具（4-3）：create_skill / add_mcp_server。
 * 与 MCP 工具同一条路（pi 的 customTools），但**写盘不在 agent 进程**——
 * agent 只发带 requestId 的请求事件，主进程调 store 后回命令（permission
 * 问答的同款模式，通道见 ./request-broker.ts）。agent 进程不碰 userData，
 * 这是架构边界，不是谦虚。
 *
 * 两个工具天然走 ask：decidePermission 对非只读工具本来就 ask（plan 拒 /
 * manual 问 / skip 放），审批条里能看到完整参数，用户改了参数再放行也行。
 */

/** 主进程回执里带来的连接状态 */
export type WriteStatus = { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string };
export type WriteResult =
  | { ok: true; path?: string; status?: WriteStatus }
  | { ok: false; error: string };

/**
 * 讲给模型听的说明（拼进 system prompt，同 describePermissionMode 的注入方式）。
 * 工具的参数 schema 已经讲了字段；这里讲格式与语义：SKILL.md 长什么样、
 * scope 两个值各意味着什么、写盘要过审批。
 *
 * **会话的工作区归属是参数**（2026-10-11 用户实测：模型两次拿 scope:"workspace"
 * 撞「不属于任何工作区」的墙——旧文案只说「属于工作区时默认 workspace」，
 * 却从不告诉模型这条会话属不属于，它只能瞎猜）：
 *   - null   这条会话不属于任何工作区（从首页 New task 建的、cwd 只是目录）——
 *           workspace scope 必被拒，明说，别试；
 *   - 有名字 报名字，模型知道 workspace scope 落在哪；
 *   - 缺席   有工作区但翻不出名字（旧夹具 / 工作区已删）——如实说「未知」，不猜。
 *
 * **常驻规则的去处也是这段话的职责**（2026-10 用户实测：「把规则加进这个工作区」
 * 直接触发 create_skill——旧文案把 skill 说成 "applies to every task"，又从没告诉
 * 模型 AGENTS.md 是可写的常驻规则文件，提示词里唯一的持久化出口就是这俩工具）。
 * 修的是文案而不是加路由黑名单：skill 的真实语义（每任务只列名字与描述，正文
 * 描述匹配时才被读）如实写；常驻规则指路 cwd 下的 AGENTS.md（pi 每轮当 project
 * instructions 读进来，不存在可新建，路径写死进提示词）。没有工作区的会话没有
 * 项目规则文件可指——让模型问用户放哪，不许自己挑地方（Home 也不是全局规则的
 * 定案去处，~/.pi/agent 是 pi CLI 自己的全局配置，写它会外溢，都不提）。
 */
export function storeToolsGuideline(workspace: { name?: string } | null, cwd: string): string {
  const membership =
    workspace === null
      ? 'This session does NOT belong to any workspace (it was not opened inside one): create_skill with scope "workspace" will be rejected — use "global".'
      : workspace.name === undefined
        ? 'This session belongs to a workspace whose name is not available here; scope "workspace" is allowed.'
        : `This session belongs to workspace "${workspace.name}"; skills with scope "workspace" are listed only in that workspace's sessions.`;
  // 常驻规则落点：有工作区 = cwd 下的 AGENTS.md（文件不存在也要把路径写进提示词，
  // 并说明可以新建）；无工作区 = 没有项目规则文件，让模型问用户，别自己挑地方
  const rulesDestination =
    workspace === null
      ? `- A standing rule ("run tests before committing", "reply in Chinese in this project") → this session has no
  workspace, so there is no project rules file to write it to: ask the user where to keep such a rule
  instead of picking a place yourself.`
      : `- A standing rule ("run tests before committing", "reply in Chinese in this project") → this workspace's
  rules file at ${cwd}/AGENTS.md, read into context as project instructions every turn. The file may not
  exist yet — create it; a few lines are enough.`;
  return `<orbita-store-tools>
You can configure this agent itself with two tools:
- create_skill writes a skill the agent will use in later sessions. The skill is a folder with a SKILL.md:
  a frontmatter block (name, description) followed by markdown instructions. Each task lists the skill's
  name and description only; the body is read when the task matches that description — a skill is a
  manual loaded on demand, not something in effect every turn. scope "global" = listed in every task;
  "workspace" = listed only in this workspace's tasks. Both are subject to user approval.
- add_mcp_server adds an MCP server from its config (stdio command or http url). The result reports the
  connection status; a failed server can be fixed by editing mcp.json.
Both tools change disk state and require approval. When the user asks for a new skill or a new MCP server,
use these tools instead of telling the user to copy files into place by hand.

Where a lasting instruction belongs — pick by when it must apply:
${rulesDestination}
- A reusable procedure for specific situations ("how to release", "how to migrate") → create_skill.
- Never store a standing rule as a skill: the body is read only when the description matches the task,
  so the rule would silently not apply in most turns.
- If the user states a rule without asking to persist it, ask once whether to write it into the rules file.

Writing a skill body (this matters — a skill is instructions for a future agent, not a reply to this user):
- Write for the reader that will load it cold: start with WHEN to use it (trigger conditions), then the
  steps in order. No greetings, no apologies, no restating this conversation.
- Be imperative and specific: exact commands, paths, formats, pitfalls. One line of "run X then check Y"
  beats a paragraph of explanation.
- description carries the matching burden: the future agent decides whether to read the body from it
  alone, so name the situations it covers and excludes.
- scope: ${membership}
</orbita-store-tools>`;
}

/** 铸工具对。broker 由 runtime 持有并接回执；这里只包 execute 的翻译。 */
export function createStoreTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  const createSkill: ToolDefinition = {
    name: "create_skill",
    label: "create_skill",
    description:
      "Write a skill (folder with SKILL.md) into this agent's central store and link it. " +
      "A skill is listed by name and description in each task; its body is read only when the task matches " +
      "the description — a rule that must apply every turn belongs in the workspace's AGENTS.md instead. " +
      'scope "global" = listed in every task; "workspace" = listed only in this workspace\'s tasks.',
    parameters: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Folder name: lowercase letters, digits, dots, dashes, underscores." },
        name: { type: "string", description: "Human name shown in the index." },
        description: { type: "string", description: "One or two sentences on WHEN to use this skill." },
        body: { type: "string", description: "The full markdown instructions (SKILL.md body)." },
        scope: { type: "string", enum: ["global", "workspace"] },
      },
      required: ["slug", "name", "description", "body", "scope"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await broker.request<WriteResult>({
        type: "skillWriteRequest",
        sessionId,
        slug: String(args["slug"] ?? ""),
        name: String(args["name"] ?? ""),
        description: String(args["description"] ?? ""),
        body: String(args["body"] ?? ""),
        scope: args["scope"] === "workspace" ? "workspace" : "global",
      });
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text", text: `Skill written: ${result.path ?? "(central store)"}` }],
        details: undefined,
      };
    },
  };

  const addMcpServer: ToolDefinition = {
    name: "add_mcp_server",
    label: "add_mcp_server",
    description:
      "Add an MCP server to this agent's mcp.json (writes the config and reloads connections; " +
      "the new server's tools are available in sessions opened afterwards, not in the current one). " +
      "stdio: {transport:'stdio', command, args, env}; http: {transport:'http', url, headers}.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Server name (letters, digits, dashes, underscores)." },
        server: {
          type: "object",
          description:
            "Server config: stdio {transport:'stdio', command, args?, env?} or http {transport:'http', url, headers?}.",
        },
      },
      required: ["name", "server"],
    } as never,
    async execute(_toolCallId, params) {
      const args = (params ?? {}) as Record<string, unknown>;
      const result = await broker.request<WriteResult>({
        type: "mcpWriteRequest",
        name: String(args["name"] ?? ""),
        server: args["server"],
      });
      if (!result.ok) throw new Error(result.error);
      const status = result.status;
      const text =
        status === undefined
          ? "Server added; its tools will be available in sessions opened afterwards."
          : status.kind === "ready"
            ? "Server added and connected (ready)."
            : `Server added; connection status: ${status.kind}${status.message ? ` — ${status.message}` : ""}`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  };

  return [createSkill, addMcpServer];
}
