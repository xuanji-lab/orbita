/**
 * 插件的 IPC —— 四层契约的第 2 层。
 *
 * 已装页的一张表 = 真插件（PluginStore）+ 旧技能（SkillStore 的链接表）+ 旧 MCP（全局 mcp.json），
 * 各自是自己那份状态的**唯一真源**，这里只投影（legacy.ts）与按视图 id 前缀分派写入：
 * 在插件页里拨开关与在旧面板里拨，落到同一份状态。renderer 传来的一切入参都当不可信：
 * 形状、枚举、id 前缀逐项校验（路径、范围名单、配置值）。
 */
import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  parsePluginViewId,
  type PluginConfigValue,
  type PluginInstallRequest,
  type PluginInstallResult,
  type PluginListResult,
  type PluginPreviewRequest,
  type PluginPreviewResult,
  type PluginScope,
  type PluginSource,
} from "../../shared/plugin.ts";
import type {
  PluginPanelActionResult,
  PluginPanelInfo,
  PluginPanelSnapshot,
  PluginPanelTab,
} from "../../shared/plugin-panel.ts";
import type { SkillMeta } from "../../shared/skill.ts";
import type { McpServer } from "../../shared/mcp.ts";
import type { McpStore } from "../mcp/store.ts";
import type { SkillStore } from "../skill/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { applyMcpScope, applySkillScope, mcpViews, skillViews } from "./legacy.ts";
import type { PluginPanels } from "./panel-service.ts";
import { parseScope } from "./records.ts";
import type { PluginStore } from "./store.ts";

export function registerPluginIpc(deps: {
  plugins: PluginStore;
  /** 插件面板（右栏页签 / 载入 / 动作 / 详情）；契约在 shared/plugin-panel.ts */
  panels: PluginPanels;
  skills: SkillStore;
  mcp: McpStore;
  workspaces: WorkspaceStore;
  /** 让 agent 进程把现有 MCP 连接拆掉重来（host 注入；「重新载入」与改旧 MCP 用） */
  reloadMcp: () => Promise<void>;
}): void {
  const { plugins, panels, skills, mcp, workspaces } = deps;

  ipcMain.handle(ipcChannels.pluginList, async (): Promise<PluginListResult> => {
    let servers: Record<string, McpServer> = {};
    let mcpError: string | null = null;
    try {
      servers = await mcp.read();
    } catch (error) {
      // mcp.json 读不出来：其余照常列，错误原文贴在页上（不说成「你没有 MCP」）
      mcpError = error instanceof Error ? error.message : String(error);
    }
    const [real, userSkills, workspaceList] = await Promise.all([plugins.listViews(), skills.list(), workspaces.list()]);
    return {
      plugins: [...real, ...skillViews(userSkills, skills.storeRoot()), ...mcpViews(servers, workspaceList)],
      mcpError,
    };
  });

  ipcMain.handle(ipcChannels.pluginSkills, (): Promise<SkillMeta[]> => plugins.skillMetas());

  ipcMain.handle(ipcChannels.pluginPickFolder, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ["openDirectory" as const] };
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  ipcMain.handle(ipcChannels.pluginPreview, (_event, raw: unknown): Promise<PluginPreviewResult> => plugins.preview(requirePreviewRequest(raw)));

  ipcMain.handle(ipcChannels.pluginDiscard, (_event, previewId: unknown): Promise<void> => plugins.discard(requireString(previewId, "previewId")));

  ipcMain.handle(ipcChannels.pluginInstall, (_event, raw: unknown): Promise<PluginInstallResult> => {
    const request = requireRecord(raw, "install request");
    const preview = requirePreviewRequest(request["preview"]);
    const previewId = request["previewId"] === null ? null : requireString(request["previewId"], "previewId");
    const scope = parseScope(request["scope"]);
    if (scope === null) throw new Error("Invalid scope");
    const checked: PluginInstallRequest = { preview, previewId, scope };
    return plugins.install(checked);
  });

  ipcMain.handle(ipcChannels.pluginSetScope, async (_event, rawId: unknown, rawScope: unknown): Promise<void> => {
    const parsed = parsePluginViewId(requireString(rawId, "id"));
    if (parsed === null) throw new Error(`Invalid plugin id: ${String(rawId)}`);
    const scope: PluginScope | null = parseScope(rawScope);
    if (scope === null) throw new Error("Invalid scope");
    if (parsed.origin === "plugin") return plugins.setScope(parsed.key, scope);
    if (parsed.origin === "user-skill") {
      const meta = (await skills.list()).find((each) => each.slug === parsed.key);
      if (meta === undefined) throw new Error(`Skill not found: ${parsed.key}`);
      return applySkillScope(skills, meta, scope);
    }
    await applyMcpScope(mcp, parsed.key, scope);
    await deps.reloadMcp().catch((error: unknown) => {
      console.error("[plugin] mcp.json 改了但重连失败（下次开轮会用新配置）", error);
    });
  });

  ipcMain.handle(
    ipcChannels.pluginSetConfig,
    (_event, name: unknown, key: unknown, value: unknown): Promise<void> =>
      plugins.setConfig(requireString(name, "name"), requireString(key, "key"), value === null ? null : requireConfigValue(value)),
  );

  ipcMain.handle(ipcChannels.pluginUninstall, (_event, name: unknown): Promise<void> => plugins.uninstall(requireString(name, "name")));

  ipcMain.handle(ipcChannels.pluginReveal, async (_event, name: unknown): Promise<void> => {
    const record = (await plugins.records()).find((each) => each.name === requireString(name, "name"));
    if (record === undefined) throw new Error(`No such plugin: ${String(name)}`);
    const failure = await shell.openPath(plugins.rootOf(record));
    if (failure !== "") throw new Error(failure);
  });

  ipcMain.handle(ipcChannels.pluginReload, async (): Promise<void> => {
    await deps.reloadMcp();
  });

  // 面板：入参一律当不可信（renderer 被攻破时也不该能凭空读写别的插件 / 路径——这里只认插件名与工作区 id，
  // 路径从不由 renderer 给）
  ipcMain.handle(
    ipcChannels.pluginPanelTabs,
    (_event, workspaceId: unknown): Promise<PluginPanelTab[]> => panels.tabs(optionalId(workspaceId, "workspaceId")),
  );

  ipcMain.handle(ipcChannels.pluginPanelLoad, (_event, raw: unknown): Promise<PluginPanelSnapshot> => {
    const request = requireRecord(raw, "panel load request");
    return panels.load({
      name: requireString(request["name"], "name"),
      workspaceId: optionalId(request["workspaceId"], "workspaceId"),
      stamp: request["stamp"] === null || request["stamp"] === undefined ? null : requireString(request["stamp"], "stamp"),
    });
  });

  ipcMain.handle(ipcChannels.pluginPanelAction, (_event, raw: unknown): Promise<PluginPanelActionResult> => {
    const request = requireRecord(raw, "panel action request");
    // action 不是字符串也不抛：交给 checkPanelAction 回 invalid，调用方一律拿到数据而不是异常
    return panels.action({ name: requireString(request["name"], "name"), action: request["action"] as string, payload: request["payload"] });
  });

  ipcMain.handle(
    ipcChannels.pluginPanelInfo,
    (_event, name: unknown, workspaceId: unknown): Promise<PluginPanelInfo | null> =>
      panels.info(requireString(name, "name"), optionalId(workspaceId, "workspaceId")),
  );
}

function optionalId(value: unknown, what: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, what);
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${what}`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Invalid ${what}`);
  return value;
}

function requireConfigValue(value: unknown): PluginConfigValue {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item): item is string => typeof item === "string")) return value;
  throw new Error("Invalid config value");
}

function requirePreviewRequest(raw: unknown): PluginPreviewRequest {
  const request = requireRecord(raw, "preview request");
  const source = requireRecord(request["source"], "source");
  const mode = request["mode"];
  if (mode !== "copy" && mode !== "link") throw new Error("Invalid install mode");
  let checked: PluginSource;
  if (source["kind"] === "folder") checked = { kind: "folder", path: requireString(source["path"], "path") };
  else if (source["kind"] === "git") checked = { kind: "git", url: requireString(source["url"], "url") };
  else throw new Error("Invalid source");
  return { source: checked, mode };
}
