/**
 * agent 的 install_plugin / list_plugins 在主进程的落地（实验功能 plugins）。
 *
 * **纯逻辑模块**（不 import electron；store 与会话查询都是注入的端口），可被 `node --test` 直接测——
 * main/index.ts 只做路由。流程（install）：
 *
 *   1. 开关 / 会话归属 / 范围解析（`workspace` 落到这条会话所在工作区；没有工作区的会话只能用 global）；
 *   2. **路径只认这条会话的工作区或工作目录之内**（realpath 之后再比，符号链接指出去的不算）——
 *      agent 想把别处的文件夹装成插件，得先放进工作区；
 *   3. 预览（链接装法，**只读不写**）：读不出来 / 重名 / 清单有问题 / workflow 点名了不存在的技能，
 *      都在弹卡**之前**以清楚的错误回给模型——这些是它自己写错的东西，让它先改完再来打扰用户；
 *   4. 弹确认卡（pluginInstallAsk 事件挂到会话上），**等用户点**；点了「安装」才 `PluginStore.install`，
 *      拒绝 / 这一轮停了 / 超时都回清楚的错误。
 *
 * 已经链接安装过同一个文件夹的（agent 改完又装一次）不再弹卡：链接只记路径、开轮现读目录，改动已经生效。
 */
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  scopeApplies,
  type PluginAgentInstallOutcome,
  type PluginAgentListItem,
  type PluginAgentListOutcome,
  type PluginAgentScope,
  type PluginConflict,
  type PluginInstallResult,
  type PluginPreview,
  type PluginPreviewError,
  type PluginPreviewRequest,
  type PluginPreviewResult,
  type PluginScope,
  type PluginView,
} from "../../shared/plugin.ts";
import type { PluginRecord } from "./records.ts";

export type PluginInstallAsk = Extract<AgentEvent, { type: "pluginInstallAsk" }>;

/** PluginStore 里本模块要用的几个方法（测试注入假的）。 */
export interface PluginStorePort {
  preview(request: PluginPreviewRequest): Promise<PluginPreviewResult>;
  install(request: { preview: PluginPreviewRequest; previewId: string | null; scope: PluginScope }): Promise<PluginInstallResult>;
  records(): Promise<PluginRecord[]>;
  listViews(): Promise<PluginView[]>;
  /** `${CLAUDE_PLUGIN_DATA}` */
  dataDirOf(name: string): string;
}

export interface PluginAgentPorts {
  plugins: PluginStorePort;
  /** 实验开关此刻开着吗（每次现读：用户中途关了就不再装） */
  enabled: () => Promise<boolean>;
  /** 会话的归属：cwd 与工作区 id；会话不在了为 null */
  session: (sessionId: string) => Promise<{ cwd: string; workspaceId: string | null } | null>;
  /** 工作区 id → 名字与根目录；找不到（被删了）为 null */
  workspace: (id: string) => Promise<{ name: string; path: string } | null>;
  /** 把确认卡送到 renderer */
  ask: (event: PluginInstallAsk) => void;
  /** 装好了（让技能选取面等刷新；renderer 还会把装它的那条会话的右栏切到它的面板） */
  installed: (info: { name: string; sessionId: string }) => void;
}

interface Pending {
  sessionId: string;
  settle: (outcome: PluginAgentInstallOutcome) => void;
  /** 用户点「安装」后要装的东西 */
  request: { preview: PluginPreviewRequest; scope: PluginScope; agentScope: PluginAgentScope; preview_: PluginPreview };
}

export class PluginAgentRequests {
  private readonly ports: PluginAgentPorts;
  private readonly pending = new Map<string, Pending>();

  constructor(ports: PluginAgentPorts) {
    this.ports = ports;
  }

  async install(event: Extract<AgentEvent, { type: "pluginInstallRequest" }>): Promise<PluginAgentInstallOutcome> {
    const { ports } = this;
    if (!(await ports.enabled())) return fail("The plugins feature is turned off in Orbita's experimental settings.");
    const session = await ports.session(event.sessionId);
    if (session === null) return fail("This session no longer exists.");
    const workspace = session.workspaceId === null ? null : await ports.workspace(session.workspaceId);

    // 范围：省略时工作区会话默认 workspace、没有工作区默认 global
    const wanted: PluginAgentScope = event.scope ?? (workspace === null ? "global" : "workspace");
    if (wanted === "workspace" && (session.workspaceId === null || workspace === null)) {
      return fail(
        'This session does not belong to a workspace, so scope "workspace" has nowhere to apply. ' +
          'Use scope "global", or ask the user to move the session into a workspace first.',
      );
    }
    const scope: PluginScope =
      wanted === "global" || session.workspaceId === null ? { kind: "global" } : { kind: "workspaces", ids: [session.workspaceId] };

    // 路径：只认工作区根与会话工作目录之内
    const roots = [...new Set([workspace?.path, session.cwd].filter((root): root is string => root !== undefined && root !== ""))];
    const located = await locateInside(event.path, session.cwd, roots);
    if (!located.ok) return fail(located.error);
    const path = located.path;

    const request: PluginPreviewRequest = { source: { kind: "folder", path }, mode: "link" };
    const previewed = await ports.plugins.preview(request);
    if (!previewed.ok) return fail(previewErrorMessage(previewed.error, path));
    const preview = previewed.preview;

    // 同一个文件夹已经链接装过：不重复弹卡，改动下一轮自动生效
    const existing = (await ports.plugins.records()).find((record) => record.name === preview.name);
    const relinked = existing !== undefined && existing.source.kind === "link" && sameFolder(existing.source.path, path);
    const conflicts = relinked ? preview.conflicts.filter((conflict) => !(conflict.kind === "plugin-exists" && conflict.name === preview.name)) : preview.conflicts;
    if (conflicts.length > 0) return fail(`Cannot install "${preview.name}": ${conflicts.map(conflictMessage).join(" ")}`);

    // 弹卡之前先拦下 agent 自己写错的东西
    const issues = [
      ...preview.problems.map((problem) => `${problem.kind}: ${problem.detail}`),
      ...preview.workflow
        .filter((step) => step.skill !== null && step.skillSlug === null)
        .map((step) => `workflow step "${step.title}" names the skill "${step.skill}", which is not one of this plugin's skills (${preview.skills.map((skill) => skill.slug).join(", ") || "none"})`),
    ];
    if (issues.length > 0) {
      return fail(`The plugin folder has problems; fix them and call install_plugin again (the user has not been asked yet):\n- ${issues.join("\n- ")}`);
    }

    const skills = preview.skills.map((skill) => skill.slug);
    const mcp = preview.mcp.map((server) => server.name);
    if (relinked) return { ok: true, name: preview.name, scope: wanted, already: true, skills, mcp, dataDir: ports.plugins.dataDirOf(preview.name) };

    return new Promise<PluginAgentInstallOutcome>((settle) => {
      this.pending.set(event.requestId, {
        sessionId: event.sessionId,
        settle,
        request: { preview: request, scope, agentScope: wanted, preview_: preview },
      });
      ports.ask({
        type: "pluginInstallAsk",
        sessionId: event.sessionId,
        requestId: event.requestId,
        preview,
        scope: wanted,
        workspaceName: wanted === "workspace" ? (workspace?.name ?? null) : null,
      });
    });
  }

  /** 用户在确认卡上的应答。不认识的 requestId（这一轮停了、已经取消）静默。 */
  async answer(requestId: string, approve: boolean): Promise<void> {
    const pending = this.pending.get(requestId);
    if (pending === undefined) return;
    this.pending.delete(requestId);
    if (!approve) {
      pending.settle(fail("The user declined to install the plugin. Do not retry on your own: ask what they want changed."));
      return;
    }
    try {
      const result = await this.ports.plugins.install({ preview: pending.request.preview, previewId: null, scope: pending.request.scope });
      if (!result.ok) {
        pending.settle(fail(installErrorMessage(result.error)));
        return;
      }
      const { preview_: preview, agentScope } = pending.request;
      this.ports.installed({ name: preview.name, sessionId: pending.sessionId });
      pending.settle({
        ok: true,
        name: preview.name,
        scope: agentScope,
        already: false,
        skills: preview.skills.map((skill) => skill.slug),
        mcp: preview.mcp.map((server) => server.name),
        dataDir: this.ports.plugins.dataDirOf(preview.name),
      });
    } catch (cause) {
      pending.settle(fail(`Installing failed: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
  }

  /** 这条会话的一轮停了（完成 / 被停 / 出错）：没应答的卡按取消结掉。 */
  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of [...this.pending]) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      pending.settle(fail("The turn ended before the user answered the install card, so nothing was installed."));
    }
  }

  async list(event: Extract<AgentEvent, { type: "pluginListRequest" }>): Promise<PluginAgentListOutcome> {
    const { ports } = this;
    if (!(await ports.enabled())) return { ok: false, error: "The plugins feature is turned off in Orbita's experimental settings." };
    const session = await ports.session(event.sessionId);
    if (session === null) return { ok: false, error: "This session no longer exists." };
    const views = (await ports.plugins.listViews()).filter((view) => view.origin === "plugin" && scopeApplies(view.scope, session.workspaceId));
    const plugins: PluginAgentListItem[] = views.map((view) => ({
      name: view.id.slice("plugin:".length),
      description: view.description,
      origin: view.install?.source.kind === "builtin" ? "builtin" : "plugin",
      skills: view.skills.map((skill) => skill.slug),
      mcp: view.mcp.map((server) => server.name),
      workflow: view.workflow.map((step) => step.title),
      root: view.install?.root ?? view.location ?? "",
      dataDir: view.install?.dataDir ?? "",
    }));
    return { ok: true, plugins };
  }
}

// ---------- 纯函数（带测试） ----------

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

type Located = { ok: true; path: string } | { ok: false; error: string };

/**
 * 模型给的路径 → 真实的文件夹路径，且必须落在 roots 之内。相对路径按会话工作目录解；
 * 两边都过 realpath（符号链接指到工作区外的不算在里面）。
 */
export async function locateInside(raw: string, cwd: string, roots: readonly string[]): Promise<Located> {
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    return { ok: false, error: `${absolute} does not exist. Create the plugin folder (with .claude-plugin/plugin.json and skills/) first.` };
  }
  if (!(await stat(real).then((info) => info.isDirectory(), () => false))) {
    return { ok: false, error: `${absolute} is not a folder; pass the plugin's root folder.` };
  }
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot === null) continue;
    const inside = relative(realRoot, real);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return { ok: true, path: real };
  }
  return {
    ok: false,
    error:
      `${absolute} is outside this session's workspace (${roots.join(", ") || "no workspace folder"}). ` +
      "Plugins you create must live inside it, at <workspace>/plugins/<name>/.",
  };
}

function sameFolder(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

export function conflictMessage(conflict: PluginConflict): string {
  switch (conflict.kind) {
    case "plugin-exists":
      return `A plugin named "${conflict.name}" is already installed (from a different folder). Pick another name in plugin.json, or ask the user to uninstall the old one.`;
    case "skill-name":
      return `The skill "${conflict.skill}" clashes with ${conflict.with.origin === "plugin" ? "the plugin" : "your own skill"} "${conflict.with.name}". Rename the skill (its folder name and the name in SKILL.md).`;
    case "skill-duplicate":
      return `Two skills in this plugin share the name "${conflict.skill}". Rename one.`;
    case "mcp-name":
      return `The MCP server "${conflict.server}" would be named "${conflict.qualified}", which clashes with "${conflict.with}". Rename the server.`;
  }
}

export function previewErrorMessage(error: PluginPreviewError, path: string): string {
  switch (error.kind) {
    case "not-a-plugin":
      return `${path} does not look like a plugin: it needs .claude-plugin/plugin.json, or skills/<slug>/SKILL.md, or a SKILL.md at its root.`;
    case "invalid-name":
      return `The plugin name "${error.name}" is not valid: use lowercase letters, digits, dots, dashes, underscores, starting with a letter or digit (max 64).`;
    case "git-url-rejected":
    case "git-failed":
    case "too-large":
      return `Could not read ${path} as a plugin (${error.kind}).`;
    case "symlink-escape":
      return `${path} contains symbolic links that point outside it: ${error.paths.join(", ")}.`;
    case "read-failed":
      return `Could not read ${path}: ${error.message}`;
  }
}

function installErrorMessage(error: Extract<PluginInstallResult, { ok: false }>["error"]): string {
  if (error.kind === "conflict") return `Cannot install: ${error.conflicts.map(conflictMessage).join(" ")}`;
  if (error.kind === "stale-preview") return "The preview is stale; call install_plugin again.";
  return previewErrorMessage(error, "the folder");
}
