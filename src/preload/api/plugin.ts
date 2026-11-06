/**
 * 插件的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  PluginConfigValue,
  PluginDraftEntry,
  PluginDraftSnapshot,
  PluginInstallRequest,
  PluginInstallResult,
  PluginListResult,
  PluginPreviewRequest,
  PluginPreviewResult,
  PluginRowInstallRequest,
  PluginRowInstallResult,
  PluginScope,
  PluginSkillFile,
} from "../../shared/plugin.ts";
import type {
  PluginBoardLoadRequest,
  PluginBoardSnapshot,
  PluginDraftLoadRequest,
  PluginPanelActionRequest,
  PluginPanelActionResult,
} from "../../shared/plugin-panel.ts";
import type { SkillMeta } from "../../shared/skill.ts";

export const pluginApi = {
  /** 已装页的全部：真插件 + 旧技能 + 旧 MCP，一张表（mcp.json 读坏时 mcpError 带原文，其余照常） */
  list: (): Promise<PluginListResult> => ipcRenderer.invoke(ipcChannels.pluginList),
  /** 插件里的技能，SkillMeta 形状：右栏 `/` 选取与聊天里的 SKILL.md 徽标用 */
  skills: (): Promise<SkillMeta[]> => ipcRenderer.invoke(ipcChannels.pluginSkills),
  /** 主进程开目录选择框；取消返回 null */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke(ipcChannels.pluginPickFolder),
  /** 安装前预览：读出它带了什么、MCP 命令行、冲突；复制 / git 先暂存 */
  preview: (request: PluginPreviewRequest): Promise<PluginPreviewResult> =>
    ipcRenderer.invoke(ipcChannels.pluginPreview, request),
  /** 放弃一次预览（清暂存） */
  discard: (previewId: string): Promise<void> => ipcRenderer.invoke(ipcChannels.pluginDiscard, previewId),
  /** 确认安装；冲突与暂存失效以数据返回，不抛 */
  install: (request: PluginInstallRequest): Promise<PluginInstallResult> =>
    ipcRenderer.invoke(ipcChannels.pluginInstall, request),
  /** 改启用范围（视图 id 的前缀决定落到插件记录 / skill 链接 / mcp.json） */
  setScope: (id: string, scope: PluginScope): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.pluginSetScope, id, scope),
  /** 改一个配置项；null = 清除；敏感值进系统密钥库 */
  setConfig: (name: string, key: string, value: PluginConfigValue | null): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.pluginSetConfig, name, key, value),
  /** 卸载 = 归档不是删除 */
  uninstall: (name: string): Promise<void> => ipcRenderer.invoke(ipcChannels.pluginUninstall, name),
  /** 在文件管理器里打开插件目录 */
  reveal: (name: string): Promise<void> => ipcRenderer.invoke(ipcChannels.pluginReveal, name),
  /** 重新读目录，并让 MCP 连接按新配置重建 */
  reload: (): Promise<void> => ipcRenderer.invoke(ipcChannels.pluginReload),
  /** 对话里「装上插件」那一行的「安装」（agent 的 install_plugin 留的）：主进程重验会话 / 路径 / 指纹；结局以数据返回，不抛 */
  installFromRow: (request: PluginRowInstallRequest): Promise<PluginRowInstallResult> =>
    ipcRenderer.invoke(ipcChannels.pluginInstallFromRow, request),
  /** 一条插件技能的 SKILL.md 原文（只读查看） */
  skillFile: (name: string, slug: string): Promise<PluginSkillFile> => ipcRenderer.invoke(ipcChannels.pluginSkillFile, name, slug),
  /** 载入 / 轮询一个插件的看板（每张卡的 iframe 地址 + 数据）；stamp 没变回 unchanged */
  boardLoad: (request: PluginBoardLoadRequest): Promise<PluginBoardSnapshot> =>
    ipcRenderer.invoke(ipcChannels.pluginBoardLoad, request),
  /** 草稿预览（一）：工作区里还没安装的插件文件夹的扫描（路径必须在该工作区根内，主进程校验）；没变回 unchanged */
  draftLoad: (request: PluginDraftLoadRequest): Promise<PluginDraftSnapshot> =>
    ipcRenderer.invoke(ipcChannels.pluginDraftLoad, request),
  /** 「正在做」列表：所有工作区里有清单、还没安装的插件文件夹，带最近在做它的会话（用户中途离开后回来的入口） */
  drafts: (): Promise<PluginDraftEntry[]> => ipcRenderer.invoke(ipcChannels.pluginDrafts),
  /** 草稿预览（二）：同一个草稿文件夹的看板 */
  draftBoardLoad: (request: PluginDraftLoadRequest): Promise<PluginBoardSnapshot> =>
    ipcRenderer.invoke(ipcChannels.pluginDraftBoardLoad, request),
  /** 卡里点按钮的回传：追加到插件数据目录的 actions.jsonl，不做别的；失败以数据返回 */
  panelAction: (request: PluginPanelActionRequest): Promise<PluginPanelActionResult> =>
    ipcRenderer.invoke(ipcChannels.pluginPanelAction, request),
} as const;
