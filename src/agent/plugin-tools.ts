import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { PermissionMode } from "../shared/permission.ts";
import type { PluginAgentInstallOutcome, PluginAgentListOutcome, PluginAgentPreviewOutcome, PluginInstallRow } from "../shared/plugin.ts";

/**
 * agent 的插件工具（实验功能 plugins）：install_plugin / preview_plugin / list_plugins。
 *
 * 与 create_skill / add_mcp_server 同一条路（broker，见 request-broker.ts）：这一层**只是翻译**——
 * 参数 → pluginInstallRequest / pluginPreviewRequest / pluginListRequest → 等回执 → 工具结果。预览、路径校验、
 * 安装全在主进程（main/plugin/agent-requests.ts），agent 进程不碰 userData。
 *
 * **三个工具都立即返回，不等用户**（以前 install_plugin 挂起等用户点确认卡、超时 15 分钟，已删）。
 * install_plugin 要不要让用户点一下由主进程定：低风险直接装并在对话里留「已装上」一行；带 MCP / 范围是所有工作区 /
 * manual 档则不装，留一行带「安装」的行并让这一轮结束。那一行的数据放进工具结果的 `details.pluginInstall`
 * （随会话落盘，渲染层据此画出那一行）。权限档语义见 shared/permission.ts 的 SELF_CONFIRMING_TOOLS。
 */

export const PLUGIN_TOOL_NAMES = ["install_plugin", "preview_plugin", "list_plugins"] as const;

/** 讲给模型听的工具说明（字段说明在参数 schema 里，这里讲语义与会发生什么）。 */
const INSTALL_DESCRIPTION =
  "Install a plugin folder you have written (it must contain .claude-plugin/plugin.json and/or skills/<slug>/SKILL.md) " +
  "so its skills become available. The folder must be inside this session's workspace — put plugins you create at " +
  "<workspace>/plugins/<name>/. The install is a LINK: Orbita records the folder's path and re-reads it every turn, so " +
  "later edits to the folder take effect without installing again. " +
  "FIRST ask the user, in one plain sentence in their language, whether you may install it now, and call this tool only after they agree. " +
  "The call returns immediately; it never waits for the user. Two outcomes: " +
  '(1) "Installed": Orbita installed it and left a line "Installed <name> · [Uninstall]" in the conversation — do not repeat what the line says. ' +
  '(2) "Not installed yet": the plugin starts an MCP server, is enabled for all workspaces, or the session is in Manual permission mode, so ' +
  'Orbita did NOT install it and left a line with [Install] and [Details] in the conversation. End your turn right away: say in one short sentence that ' +
  "the line is waiting for the user's click (they can click it any time, also in a later session); do not repeat the command or the reason, the line already shows them. " +
  "Do not call this tool again for the same folder, do not poll, do not ask the same question in prose. " +
  "Problems in the folder (invalid manifest, a SKILL.md without description, a workflow step naming a skill that " +
  "does not exist, a name clash) are returned as an error: fix them and call again. " +
  'scope "workspace" (default inside a workspace) enables it only for this workspace; "global" for all workspaces (the user then always gets the line to click).';

const PREVIEW_DESCRIPTION =
  "Show the user the plugin folder you are drafting in the right pane of the app, WITHOUT installing it. " +
  "Call it once, right after you have written the panel files (panel/sample.json, panel/index.html, panel/spec.md and the orbita.panel block " +
  "in .claude-plugin/plugin.json): the pane then shows the plugin being made — the card rendered from your sample data, plus the spec. " +
  "After that the pane refreshes by itself within a few seconds whenever you change those files, so do NOT call it again after every edit; " +
  "call it again only if the user says they cannot see it. The folder must be inside this session's workspace. " +
  "Returns immediately with what Orbita found (skills, workflow steps, panel files, problems to fix before install_plugin). " +
  "Problems are normal while the draft is unfinished; they do not stop the pane from showing.";

type Outcome = PluginAgentInstallOutcome | PluginAgentListOutcome | PluginAgentPreviewOutcome;

/** 铸工具对。broker 由 runtime 持有并接回执；getMode 读此刻的权限档（manual 档主进程不直接装）。 */
export function createPluginTools(broker: RequestBroker, sessionId: string, getMode: () => PermissionMode): ToolDefinition[] {
  /** 发请求并等回执；这一轮被停掉（signal abort）就放手（terminal-tools.ts 同款）。 */
  const call = async <T extends Outcome>(event: Record<string, unknown>, signal: AbortSignal | undefined): Promise<T> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<T>(event);
    if (signal === undefined) return pending;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })),
    ]);
  };

  /** 路径参数：非空字符串，否则抛给模型一句能照着改的话。 */
  const pathOf = (params: unknown, tool: string): string => {
    const args = (params ?? {}) as Record<string, unknown>;
    const path = typeof args["path"] === "string" ? args["path"].trim() : "";
    if (path === "") throw new Error(`${tool} needs a non-empty path to the plugin folder`);
    return path;
  };

  const installPlugin: ToolDefinition = {
    name: "install_plugin",
    label: "install_plugin",
    description: INSTALL_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or relative to the working directory) of the plugin folder, inside the workspace." },
        scope: { type: "string", enum: ["workspace", "global"], description: 'Where to enable it. Default: "workspace" inside a workspace session, otherwise "global".' },
      },
      required: ["path"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const path = pathOf(params, "install_plugin");
      const rawScope = ((params ?? {}) as Record<string, unknown>)["scope"];
      if (rawScope !== undefined && rawScope !== "workspace" && rawScope !== "global") {
        throw new Error(`scope must be "workspace" or "global", got ${JSON.stringify(rawScope)}`);
      }
      const result = await call<PluginAgentInstallOutcome>(
        { type: "pluginInstallRequest", sessionId, path, scope: rawScope ?? null, mode: getMode() },
        signal,
      );
      if (!result.ok) throw new Error(result.error);
      return {
        content: [{ type: "text", text: describeInstalled(result) }],
        // 对话里那一行的数据：随工具结果落盘，渲染层靠它画「已装上 / 安装」（already 没有行）
        details: result.row === null ? undefined : { pluginInstall: result.row },
      };
    },
  };

  const previewPlugin: ToolDefinition = {
    name: "preview_plugin",
    label: "preview_plugin",
    description: PREVIEW_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path (or relative to the working directory) of the plugin folder, inside the workspace." },
      },
      required: ["path"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const result = await call<PluginAgentPreviewOutcome>({ type: "pluginPreviewRequest", sessionId, path: pathOf(params, "preview_plugin") }, signal);
      if (!result.ok) throw new Error(result.error);
      return { content: [{ type: "text", text: describePreview(result) }], details: undefined };
    },
  };

  const listPlugins: ToolDefinition = {
    name: "list_plugins",
    label: "list_plugins",
    description:
      "List the plugins already available in this session's workspace (name, what it is for, its skills, the steps of its workflow, " +
      "where its folder is). Call it before creating a plugin, to reuse or extend one instead of duplicating it.",
    parameters: { type: "object", properties: {} } as never,
    async execute(_toolCallId, _params, signal) {
      const result = await call<PluginAgentListOutcome>({ type: "pluginListRequest", sessionId }, signal);
      if (!result.ok) throw new Error(result.error);
      return { content: [{ type: "text", text: describePlugins(result) }], details: undefined };
    },
  };

  return [installPlugin, previewPlugin, listPlugins];
}

/** 为什么没直接装（给模型的话）。 */
function pendingReason(reason: PluginInstallRow["reason"]): string {
  if (reason === "mcp") return "it starts an MCP server on the user's machine, so the user has to see the exact command first";
  if (reason === "global") return "it is enabled for all workspaces, so the user has to look first";
  return "this session is in Manual permission mode, where every action needs the user's click";
}

/** 安装结果回给模型的话（纯函数，带测试）。 */
export function describeInstalled(outcome: Extract<PluginAgentInstallOutcome, { ok: true }>): string {
  const where = outcome.scope === "global" ? "all workspaces" : "this workspace";
  const parts = [
    outcome.skills.length > 0 ? `skills: ${outcome.skills.join(", ")}` : null,
    outcome.mcp.length > 0 ? `MCP servers: ${outcome.mcp.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  const brings = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  if (outcome.kind === "pending") {
    return (
      `Not installed yet: "${outcome.name}"${brings} was NOT installed because ${pendingReason(outcome.row.reason)}. ` +
      `A line with [Install] and [Details] is now in the conversation for ${where}. ` +
      "End your turn now: tell the user in one short sentence that the line is waiting for their click (they can click it any time, also later). " +
      "Do not repeat the command or the reason (the line already shows them), do not call install_plugin again for this folder unless you changed it, " +
      "and do not ask the same question in prose."
    );
  }
  const data = outcome.dataDir === "" ? "" : ` Plugin data folder: ${outcome.dataDir} (actions the user triggers in the plugin's panel are appended to actions.jsonl there).`;
  if (outcome.kind === "already") {
    return (
      `Plugin "${outcome.name}" is already installed from this folder${brings}; nothing new was shown. ` +
      `Your edits take effect on the next turn.${data}`
    );
  }
  return (
    `Installed plugin "${outcome.name}" for ${where}${brings}. A line "Installed ${outcome.name}" with [Uninstall] is now in the conversation; do not repeat what it says. ` +
    `It is linked to its folder, so later edits take effect on the next turn; its skills are loaded from the next turn on, not in this one.${data}`
  );
}

/** preview_plugin 回给模型的话（纯函数，带测试）。 */
export function describePreview(outcome: Extract<PluginAgentPreviewOutcome, { ok: true }>): string {
  const lines = [
    `The right pane now shows the draft "${outcome.name}" (${outcome.path}). It re-reads the files by itself every few seconds; you do not need to call preview_plugin again after each edit.`,
    outcome.skills.length > 0 ? `skills: ${outcome.skills.join(", ")}` : "skills: none yet",
    outcome.workflow.length > 0 ? `workflow: ${outcome.workflow.map((title, index) => `${index + 1}. ${title}`).join(" → ")}` : "workflow: not written yet",
    outcome.panelFiles.length > 0
      ? `panel files: ${outcome.panelFiles.map((file) => `${file.key} ${file.path}${file.exists ? "" : " (MISSING)"}`).join("; ")}`
      : "panel files: none declared",
  ];
  if (outcome.installed) lines.push("A plugin with this name is already installed (you are editing it; the pane shows the draft folder).");
  if (outcome.issues.length > 0) lines.push(`Things to fix (before install_plugin; none of them stops the pane from showing):\n- ${outcome.issues.join("\n- ")}`);
  return lines.join("\n");
}

/** list_plugins 回给模型的话（纯函数，带测试）。 */
export function describePlugins(outcome: Extract<PluginAgentListOutcome, { ok: true }>): string {
  if (outcome.plugins.length === 0) return "No plugins are enabled in this workspace.";
  return outcome.plugins
    .map((plugin) => {
      const lines = [`- ${plugin.name}${plugin.origin === "builtin" ? " (built into Orbita)" : ""}: ${plugin.description || "(no description)"}`];
      if (plugin.skills.length > 0) lines.push(`  skills: ${plugin.skills.join(", ")}`);
      if (plugin.mcp.length > 0) lines.push(`  MCP servers: ${plugin.mcp.join(", ")}`);
      if (plugin.workflow.length > 0) lines.push(`  workflow: ${plugin.workflow.map((title, index) => `${index + 1}. ${title}`).join(" → ")}`);
      lines.push(`  folder: ${plugin.root}`);
      if (plugin.dataDir !== "") lines.push(`  data folder: ${plugin.dataDir}`);
      return lines.join("\n");
    })
    .join("\n");
}
