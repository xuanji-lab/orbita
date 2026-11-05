/**
 * agent 的 install_plugin / preview_plugin / list_plugins 在主进程的落地（实验功能 plugins）。
 *
 * **纯逻辑模块**（不 import electron；store 与会话查询都是注入的端口），可被 `node --test` 直接测——
 * main/index.ts 只做路由。**没有任何一个请求会等用户**（以前挂起等用户点确认卡、15 分钟超时，已删）。
 *
 * install（立即回执）：
 *   1. 开关 / 会话归属 / 范围解析（`workspace` 落到这条会话所在工作区；没有工作区的会话只能用 global）；
 *   2. **路径只认这条会话的工作区或工作目录之内**（realpath 之后再比，符号链接指出去的不算）——
 *      agent 想把别处的文件夹装成插件，得先放进工作区；
 *   3. 预览（链接装法，**只读不写**）：读不出来 / 重名 / 清单有问题 / workflow 点名了不存在的技能，
 *      都以清楚的错误回给模型——这些是它自己写错的东西，让它先改完再来；
 *   4. 要不要让用户看一眼：带 MCP（会在本机启动程序）/ 范围是所有工作区 / manual 档（每个动作都要用户点头）
 *      → **不装**，回 `pending`，对话里留一行带「安装」的行（`PluginInstallRow`，落在工具结果的 details 里
 *      随会话落盘）；其余低风险 → 直接装，回 `installed`，留一行「已装上」。
 *
 * installFromRow：用户点那一行的「安装」。renderer 传来的会话 / 路径 / 范围一概不信，重走 1–3，
 * 再重算指纹——用户看到那一行之后文件夹里会启动的命令变了就拒装（`changed`），不让「看到的」和「装上的」分叉。
 *
 * preview（立即回执）：同样的路径校验 + 只读扫描，不装；成功后送出 pluginDraft（右栏打开「正在做」视图）。
 *
 * 已经链接安装过同一个文件夹的（agent 改完又装一次）不新增一行：链接只记路径、开轮现读目录，改动已经生效。
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentEvent } from "../../shared/agent-ipc.ts";
import {
  scopeApplies,
  type PluginAgentInstallOutcome,
  type PluginAgentListItem,
  type PluginAgentListOutcome,
  type PluginAgentPreviewOutcome,
  type PluginAgentScope,
  type PluginConflict,
  type PluginDraftFile,
  type PluginInstallResult,
  type PluginInstallRow,
  type PluginPreview,
  type PluginPreviewError,
  type PluginPreviewRequest,
  type PluginPreviewResult,
  type PluginRowInstallRequest,
  type PluginRowInstallResult,
  type PluginScope,
  type PluginView,
} from "../../shared/plugin.ts";
import type { PermissionMode } from "../../shared/permission.ts";
import type { PluginRecord } from "./records.ts";

/** 送到 renderer 的草稿事件（右栏的「正在做」视图靠它打开） */
export type PluginDraftEvent = Extract<AgentEvent, { type: "pluginDraft" }>;

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
  /** 草稿能看了：把 pluginDraft 送到 renderer */
  draft: (event: PluginDraftEvent) => void;
  /** 装好了（让技能选取面、插件页、对话里那一行刷新） */
  installed: () => void;
}

/** 通过了路径、预览、清单与冲突检查、可以装的东西（install 与 installFromRow 共用） */
interface Prepared {
  wanted: PluginAgentScope;
  scope: PluginScope;
  workspaceName: string | null;
  path: string;
  request: PluginPreviewRequest;
  preview: PluginPreview;
  /** 同一个文件夹早已链接装过 */
  relinked: boolean;
}

type PrepareFailure = { ok: false; kind: "disabled" | "no-session" | "not-found" | "invalid"; message: string };

export class PluginAgentRequests {
  private readonly ports: PluginAgentPorts;

  constructor(ports: PluginAgentPorts) {
    this.ports = ports;
  }

  /** 开关 → 会话 → 范围 → 路径 → 预览 → 冲突与自己写错的东西。任何一步不过都以清楚的话回。 */
  private async prepare(sessionId: string, rawPath: string, agentScope: PluginAgentScope | null): Promise<({ ok: true } & Prepared) | PrepareFailure> {
    const { ports } = this;
    if (!(await ports.enabled())) return refuse("disabled", "The plugins feature is turned off in Orbita's experimental settings.");
    const session = await ports.session(sessionId);
    if (session === null) return refuse("no-session", "This session no longer exists.");
    const workspace = session.workspaceId === null ? null : await ports.workspace(session.workspaceId);

    // 范围：省略时工作区会话默认 workspace、没有工作区默认 global
    const wanted: PluginAgentScope = agentScope ?? (workspace === null ? "global" : "workspace");
    if (wanted === "workspace" && (session.workspaceId === null || workspace === null)) {
      return refuse(
        "invalid",
        'This session does not belong to a workspace, so scope "workspace" has nowhere to apply. ' +
          'Use scope "global", or ask the user to move the session into a workspace first.',
      );
    }
    const scope: PluginScope =
      wanted === "global" || session.workspaceId === null ? { kind: "global" } : { kind: "workspaces", ids: [session.workspaceId] };

    // 路径：只认工作区根与会话工作目录之内
    const located = await locateInside(rawPath, session.cwd, rootsOf(workspace, session.cwd));
    if (!located.ok) return refuse("not-found", located.error);
    const path = located.path;

    const request: PluginPreviewRequest = { source: { kind: "folder", path }, mode: "link" };
    const previewed = await ports.plugins.preview(request);
    if (!previewed.ok) return refuse("not-found", previewErrorMessage(previewed.error, path));
    const preview = previewed.preview;

    // 同一个文件夹已经链接装过：不再新增一行，改动下一轮自动生效
    const relinked = await this.isRelinked(preview.name, path);
    const conflicts = relinked ? preview.conflicts.filter((conflict) => !(conflict.kind === "plugin-exists" && conflict.name === preview.name)) : preview.conflicts;
    if (conflicts.length > 0) return refuse("invalid", `Cannot install "${preview.name}": ${conflicts.map(conflictMessage).join(" ")}`);

    // 先拦下 agent 自己写错的东西
    const issues = [
      ...preview.problems.map((problem) => `${problem.kind}: ${problem.detail}`),
      ...unresolvedWorkflow(preview),
    ];
    if (issues.length > 0) {
      return refuse("invalid", `The plugin folder has problems; fix them and call install_plugin again:\n- ${issues.join("\n- ")}`);
    }
    return { ok: true, wanted, scope, workspaceName: wanted === "workspace" ? (workspace?.name ?? null) : null, path, request, preview, relinked };
  }

  private async isRelinked(name: string, path: string): Promise<boolean> {
    const existing = (await this.ports.plugins.records()).find((record) => record.name === name);
    return existing !== undefined && existing.source.kind === "link" && sameFolder(existing.source.path, path);
  }

  /** 真装（链接）。成功广播刷新，失败回一句话。 */
  private async doInstall(prepared: Prepared): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const result = await this.ports.plugins.install({ preview: prepared.request, previewId: null, scope: prepared.scope });
      if (!result.ok) return { ok: false, error: installErrorMessage(result.error) };
    } catch (cause) {
      return { ok: false, error: `Installing failed: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
    this.ports.installed();
    return { ok: true };
  }

  async install(event: Extract<AgentEvent, { type: "pluginInstallRequest" }>): Promise<PluginAgentInstallOutcome> {
    const prepared = await this.prepare(event.sessionId, event.path, event.scope);
    if (!prepared.ok) return fail(prepared.message);
    const { preview, wanted } = prepared;
    const skills = preview.skills.map((skill) => skill.slug);
    const mcp = preview.mcp.map((server) => server.name);
    const dataDir = this.ports.plugins.dataDirOf(preview.name);
    if (prepared.relinked) return { ok: true, kind: "already", name: preview.name, scope: wanted, skills, mcp, dataDir, row: null };

    const reason = needsLook(preview, wanted, event.mode);
    if (reason !== null) {
      // 不装，也不等：留一行带「安装」的行，让这一轮结束
      return { ok: true, kind: "pending", name: preview.name, scope: wanted, skills, mcp, row: rowOf(prepared, "pending", reason) };
    }
    const installed = await this.doInstall(prepared);
    if (!installed.ok) return fail(installed.error);
    return { ok: true, kind: "installed", name: preview.name, scope: wanted, skills, mcp, dataDir, row: rowOf(prepared, "installed", null) };
  }

  /** 用户点了对话里那一行的「安装」。 */
  async installFromRow(request: PluginRowInstallRequest): Promise<PluginRowInstallResult> {
    const prepared = await this.prepare(request.sessionId, request.path, request.scope);
    if (!prepared.ok) return { ok: false, reason: prepared.kind, detail: prepared.message };
    if (prepared.relinked) return { ok: true, name: prepared.preview.name };
    if (fingerprintOf(prepared) !== request.fingerprint) {
      return {
        ok: false,
        reason: "changed",
        detail: "The plugin folder changed after this line was shown (its name, skills or the commands it starts are not what you were shown).",
      };
    }
    const installed = await this.doInstall(prepared);
    if (!installed.ok) return { ok: false, reason: "failed", detail: installed.error };
    return { ok: true, name: prepared.preview.name };
  }

  /** preview_plugin：路径校验 + 只读扫描，不装；成功后让右栏打开「正在做」视图。 */
  async previewDraft(event: Extract<AgentEvent, { type: "pluginPreviewRequest" }>): Promise<PluginAgentPreviewOutcome> {
    const { ports } = this;
    if (!(await ports.enabled())) return fail("The plugins feature is turned off in Orbita's experimental settings.");
    const session = await ports.session(event.sessionId);
    if (session === null) return fail("This session no longer exists.");
    const workspace = session.workspaceId === null ? null : await ports.workspace(session.workspaceId);
    const located = await locateInside(event.path, session.cwd, rootsOf(workspace, session.cwd));
    if (!located.ok) return fail(located.error);
    const path = located.path;

    const previewed = await ports.plugins.preview({ source: { kind: "folder", path }, mode: "link" });
    if (!previewed.ok) return fail(previewErrorMessage(previewed.error, path));
    const preview = previewed.preview;
    const relinked = await this.isRelinked(preview.name, path);
    const installed = (await ports.plugins.records()).some((record) => record.name === preview.name);

    const panelFiles = await draftPanelFiles(path, preview, ports.plugins.dataDirOf(preview.name));
    const conflicts = relinked ? preview.conflicts.filter((conflict) => !(conflict.kind === "plugin-exists" && conflict.name === preview.name)) : preview.conflicts;
    const issues = [
      ...preview.problems.map((problem) => `${problem.kind}: ${problem.detail}`),
      ...conflicts.map(conflictMessage),
      ...unresolvedWorkflow(preview).map((line) => `${line} (fine for now if you have not written that skill yet; it must exist before install_plugin)`),
      ...panelFiles.filter((file) => !file.exists && file.key !== "data").map((file) => `orbita.panel.${file.key} points at ${file.path}, which does not exist`),
      ...(panelFiles.length === 0 ? ['plugin.json has no "orbita.panel" block, so the right pane has no panel to show yet'] : []),
    ];
    ports.draft({ type: "pluginDraft", sessionId: event.sessionId, path });
    return {
      ok: true,
      name: preview.name,
      path,
      skills: preview.skills.map((skill) => skill.slug),
      workflow: preview.workflow.map((step) => step.title),
      panelFiles,
      issues,
      installed,
    };
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

function refuse(kind: PrepareFailure["kind"], message: string): PrepareFailure {
  return { ok: false, kind, message };
}

/** 路径只认这些根之内：会话所在工作区的根与会话工作目录。 */
function rootsOf(workspace: { path: string } | null, cwd: string): string[] {
  return [...new Set([workspace?.path, cwd].filter((root): root is string => root !== undefined && root !== ""))];
}

/** workflow 里点名了、却不是本插件技能的步骤（agent 自己写错的，装之前要改）。 */
function unresolvedWorkflow(preview: PluginPreview): string[] {
  return preview.workflow
    .filter((step) => step.skill !== null && step.skillSlug === null)
    .map(
      (step) =>
        `workflow step "${step.title}" names the skill "${step.skill}", which is not one of this plugin's skills (${preview.skills.map((skill) => skill.slug).join(", ") || "none"})`,
    );
}

/**
 * 这次安装要不要让用户先看一眼（要 = 不装，留一行带「安装」的行）。返回原因，null = 低风险可直装。
 *
 * 看一眼的有三种：带 MCP（会在本机启动程序，必须让用户看见完整命令）、范围是所有工作区（别的工作区也会加载这些技能）、
 * 权限档不是 skip（manual = 每个动作都要用户点头；plan 本来就被权限层拒了，万一走到这里也按保守处理）。
 * 多个原因同时成立时取最要紧的：mcp > global > manual。
 */
export function needsLook(preview: Pick<PluginPreview, "mcp">, scope: PluginAgentScope, mode: PermissionMode): PluginInstallRow["reason"] {
  if (preview.mcp.length > 0) return "mcp";
  if (scope === "global") return "global";
  if (mode !== "skip") return "manual";
  return null;
}

/** 用户看到的那一行的内容的指纹：名字 + 范围 + 技能 + MCP（名字与完整命令行）。点「安装」时对着现读的文件夹再算一遍。 */
export function fingerprintOf(prepared: Pick<Prepared, "wanted" | "preview">): string {
  const { preview, wanted } = prepared;
  const payload = [
    preview.name,
    wanted,
    preview.skills.map((skill) => skill.slug).sort(),
    preview.mcp.map((server) => [server.name, server.commandLine]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ];
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function rowOf(prepared: Prepared, state: PluginInstallRow["state"], reason: PluginInstallRow["reason"]): PluginInstallRow {
  const { preview } = prepared;
  return {
    state,
    reason,
    name: preview.name,
    displayName: preview.displayName,
    path: prepared.path,
    scope: prepared.wanted,
    workspaceName: prepared.workspaceName,
    skills: preview.skills.map((skill) => skill.slug),
    commands: preview.mcp.map((server) => server.commandLine),
    fingerprint: fingerprintOf(prepared),
  };
}

/**
 * 清单 `orbita.panel` 里写的几个文件，各自在不在。没写 panel 块返回空数组。
 * 只读原始清单里的这几个键（面板的完整解析在面板那条线上）；template / spec / sample 必须在插件根内才算在，
 * data 允许落在插件数据目录（`${CLAUDE_PLUGIN_DATA}`），不在也正常（脚本还没跑）。
 */
export async function draftPanelFiles(root: string, preview: Pick<PluginPreview, "manifestFile">, dataDir: string): Promise<PluginDraftFile[]> {
  if (preview.manifestFile === null) return [];
  let panel: unknown;
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, ...preview.manifestFile.split("/")), "utf8"));
    const orbita = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>)["orbita"] : undefined;
    panel = typeof orbita === "object" && orbita !== null ? (orbita as Record<string, unknown>)["panel"] : undefined;
  } catch {
    return [];
  }
  if (typeof panel !== "object" || panel === null) return [];
  const entries = panel as Record<string, unknown>;
  const files: PluginDraftFile[] = [];
  for (const key of ["template", "spec", "sample", "data"] as const) {
    const written = entries[key];
    if (typeof written !== "string" || written === "") continue;
    const absolute = resolve(root, written.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replaceAll("${CLAUDE_PLUGIN_DATA}", dataDir));
    const inside = relative(root, absolute);
    const allowed = key === "data" || (!inside.startsWith("..") && !isAbsolute(inside));
    const exists = allowed && (await stat(absolute).then((info) => info.isFile(), () => false));
    files.push({ key, path: written, exists });
  }
  return files;
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
