import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RequestBroker } from "./request-broker.ts";
import type { PluginAgentInstallOutcome, PluginAgentListOutcome } from "../shared/plugin.ts";

/**
 * agent 的插件工具（实验功能 plugins）：install_plugin / list_plugins。
 *
 * 与 create_skill / add_mcp_server 同一条路（broker，见 request-broker.ts）：这一层**只是翻译**——
 * 参数 → pluginInstallRequest / pluginListRequest → 等回执 → 工具结果。预览、路径校验、确认卡、
 * 安装全在主进程（main/plugin/agent-requests.ts），agent 进程不碰 userData。
 *
 * install_plugin 与 create_skill 的区别：**确认不靠权限档**——它自己就会在对话里弹一张确认卡
 * （装了它会发生什么：带的技能、MCP 的完整命令行、范围），用户点「安装」才装。所以
 * decidePermission 对它 manual / skip 都放行（卡片就是那次询问，再弹一次审批是套娃），plan 档拒绝。
 * 等用户那一下可能很久（去泡杯咖啡），请求的超时放宽到 15 分钟，并且这一轮被停掉就立刻放手
 * （主进程另在这一轮停了时把没应答的卡按取消结掉）。
 */

export const PLUGIN_TOOL_NAMES = ["install_plugin", "list_plugins"] as const;

/** 用户可能很久之后才回来点确认卡。 */
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

/** 讲给模型听的工具说明（字段说明在参数 schema 里，这里讲语义与会发生什么）。 */
const INSTALL_DESCRIPTION =
  "Install a plugin folder you have written (it must contain .claude-plugin/plugin.json and/or skills/<slug>/SKILL.md) " +
  "so its skills become available. The folder must be inside this session's workspace — put plugins you create at " +
  "<workspace>/plugins/<name>/. The install is a LINK: Orbita records the folder's path and re-reads it every turn, so " +
  "later edits to the folder take effect without installing again. The user is shown a confirmation card (what the plugin " +
  "brings, the full command line of any MCP server, the scope) and the call waits until they press Install or decline — " +
  "do not call it again while waiting, and if they decline, ask what to change instead of retrying. " +
  "Problems in the folder (invalid manifest, a SKILL.md without description, a workflow step naming a skill that " +
  "does not exist, a name clash) are returned as an error BEFORE the card is shown: fix them and call again. " +
  'scope "workspace" (default inside a workspace) enables it only for this workspace; "global" for all workspaces.';

type Outcome = PluginAgentInstallOutcome | PluginAgentListOutcome;

/** 铸工具对。broker 由 runtime 持有并接回执。 */
export function createPluginTools(broker: RequestBroker, sessionId: string): ToolDefinition[] {
  /** 发请求并等回执；这一轮被停掉（signal abort）就放手（terminal-tools.ts 同款）。 */
  const call = async <T extends Outcome>(
    event: Record<string, unknown>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<T>(event, timeoutMs);
    if (signal === undefined) return pending;
    return Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true })),
    ]);
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
      const args = (params ?? {}) as Record<string, unknown>;
      const path = typeof args["path"] === "string" ? args["path"].trim() : "";
      if (path === "") throw new Error("install_plugin needs a non-empty path to the plugin folder");
      const rawScope = args["scope"];
      if (rawScope !== undefined && rawScope !== "workspace" && rawScope !== "global") {
        throw new Error(`scope must be "workspace" or "global", got ${JSON.stringify(rawScope)}`);
      }
      const result = await call<PluginAgentInstallOutcome>(
        { type: "pluginInstallRequest", sessionId, path, scope: rawScope ?? null },
        INSTALL_TIMEOUT_MS,
        signal,
      );
      if (!result.ok) throw new Error(result.error);
      return { content: [{ type: "text", text: describeInstalled(result) }], details: undefined };
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
      const result = await call<PluginAgentListOutcome>({ type: "pluginListRequest", sessionId }, undefined, signal);
      if (!result.ok) throw new Error(result.error);
      return { content: [{ type: "text", text: describePlugins(result) }], details: undefined };
    },
  };

  return [installPlugin, listPlugins];
}

/** 安装成功回给模型的话（纯函数，带测试）。 */
export function describeInstalled(outcome: Extract<PluginAgentInstallOutcome, { ok: true }>): string {
  const where = outcome.scope === "global" ? "all workspaces" : "this workspace";
  const parts = [
    outcome.skills.length > 0 ? `skills: ${outcome.skills.join(", ")}` : null,
    outcome.mcp.length > 0 ? `MCP servers: ${outcome.mcp.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
  const brings = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  const data = outcome.dataDir === "" ? "" : ` Plugin data folder: ${outcome.dataDir} (actions the user triggers in the plugin's panel are appended to actions.jsonl there).`;
  if (outcome.already) {
    return (
      `Plugin "${outcome.name}" is already installed from this folder${brings}; no card was shown. ` +
      `Your edits take effect on the next turn.${data}`
    );
  }
  return (
    `Installed plugin "${outcome.name}" for ${where}${brings}. It is linked to its folder, so later edits take effect ` +
    `on the next turn; its skills are loaded from the next turn on, not in this one.${data}`
  );
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
