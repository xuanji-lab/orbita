/**
 * Skills 的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SkillContent, SkillMeta, SkillPatch, SkillScope } from "../../shared/skill.ts";
import type { McpServer, McpServerInfo } from "../../shared/mcp.ts";

export const skillApi = {
  /** 中心存储 + 全部集合链接一起扫，按 slug 排序（含 missing 的断链条目） */
  list: (): Promise<SkillMeta[]> => ipcRenderer.invoke(ipcChannels.skillList),
  /** 链进一个集合（global 或某个 workspace）；互斥规则在主进程执行 */
  link: (slug: string, scope: SkillScope): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.skillLink, slug, scope),
  /** 从一个集合移出（只删链接，不碰中心存储） */
  unlink: (slug: string, scope: SkillScope): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.skillUnlink, slug, scope),
  /** 清掉一条 skill 的全部断链引用（missing 的收尾） */
  clean: (slug: string): Promise<void> => ipcRenderer.invoke(ipcChannels.skillClean, slug),
  /** 导入已有目录：主进程开目录选择框；取消返回 null，成功返回 slug */
  import: (scope: SkillScope | null): Promise<string | null> =>
    ipcRenderer.invoke(ipcChannels.skillImport, scope),
  /** 读详情；不存在返回 null */
  read: (slug: string): Promise<SkillContent | null> =>
    ipcRenderer.invoke(ipcChannels.skillRead, slug),
  /** 改详情；缺席的字段不动 */
  write: (slug: string, patch: SkillPatch): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.skillWrite, slug, patch),
  /** 在文件管理器里揭示；传 null 打开 skills 根目录（新建走这里） */
  reveal: (slug: string | null): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.skillReveal, slug),
} as const;

/** MCP 的 contextBridge 面。和 skills 放同一个文件：两者是同一个「能力」面的两半。 */
export const mcpApi = {
  /** server 列表与它们此刻的连接状态 */
  list: (): Promise<McpServerInfo[]> => ipcRenderer.invoke(ipcChannels.mcpList),
  /** 用系统默认编辑器打开 mcp.json（加减 server 走文件） */
  openConfig: (): Promise<void> => ipcRenderer.invoke(ipcChannels.mcpOpenConfig),
  /** 重读 mcp.json 并重连（新配置对下一轮开学生效；进行中的任务工具集不变） */
  reload: (): Promise<void> => ipcRenderer.invoke(ipcChannels.mcpReload),
  /** 加一台 server（4-2）：写盘后自动重连；重名由主进程抛错 */
  add: (name: string, server: McpServer): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.mcpAdd, name, server),
  /** 删一台 server（4-2） */
  remove: (name: string): Promise<void> => ipcRenderer.invoke(ipcChannels.mcpRemove, name),
  /** 启停一台 server（4-2） */
  setDisabled: (name: string, disabled: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.mcpSetDisabled, name, disabled),
} as const;
