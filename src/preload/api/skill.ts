/**
 * Skills 的 contextBridge 面 —— 四层契约的第 3 层。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SkillContent, SkillMeta, SkillPatch } from "../../shared/skill.ts";

export const skillApi = {
  /** 两个目录一起列，按 slug 排序 */
  list: (): Promise<SkillMeta[]> => ipcRenderer.invoke(ipcChannels.skillList),
  /** 启停 = 在 skills/ 与 skills-inactive/ 之间搬目录 */
  toggle: (slug: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.skillToggle, slug, enabled),
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
