/**
 * 插件的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  PluginConfigValue,
  PluginInstallRequest,
  PluginInstallResult,
  PluginListResult,
  PluginPreviewRequest,
  PluginPreviewResult,
  PluginScope,
  PluginSkillFile,
} from "../../shared/plugin.ts";
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
  /** 一条插件技能的 SKILL.md 原文（只读查看） */
  skillFile: (name: string, slug: string): Promise<PluginSkillFile> => ipcRenderer.invoke(ipcChannels.pluginSkillFile, name, slug),
} as const;
