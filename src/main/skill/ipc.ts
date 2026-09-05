/**
 * Skills 的 IPC —— 四层契约的第 2 层。
 * 揭示目录必须走主进程：renderer 在 sandbox 里没有文件系统访问权。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { SkillContent, SkillMeta, SkillPatch } from "../../shared/skill.ts";
import type { SkillStore } from "./store.ts";

export function registerSkillIpc(store: SkillStore): void {
  ipcMain.handle(ipcChannels.skillList, (): Promise<SkillMeta[]> => store.list());
  ipcMain.handle(ipcChannels.skillToggle, (_event, slug: string, enabled: boolean): Promise<void> =>
    store.setEnabled(slug, enabled),
  );
  ipcMain.handle(ipcChannels.skillRead, (_event, slug: string): Promise<SkillContent | null> =>
    store.read(slug),
  );
  ipcMain.handle(ipcChannels.skillWrite, (_event, slug: string, patch: SkillPatch): Promise<void> =>
    store.write(slug, patch),
  );

  /**
   * 在系统文件管理器里揭示这条 skill 的目录。
   * **新建与删除都走这里**：删除不可逆，而新建一个文件夹本来就是文件管理器最擅长的事，
   * 我们没有理由为它做一套弱化的 UI。
   */
  ipcMain.handle(ipcChannels.skillReveal, async (_event, slug: string | null): Promise<void> => {
    if (slug === null) {
      await shell.openPath(store.enabledDir());
      return;
    }
    const dir = await store.locateDir(slug);
    if (dir === null) throw new Error(`skill 不存在：${slug}`);
    shell.showItemInFolder(dir);
  });
}
