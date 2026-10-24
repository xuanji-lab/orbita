/**
 * 引用补全的 IPC 层 —— 四层契约的第 2 层（契约在 `shared/cite.ts`，preload 面在
 * `preload/api/cite.ts`）。
 *
 * **不新造第二套授权**：项目目录由 `locateLatexProject` 找（与 `latex:*` 同一个函数：
 * 白名单核 root + path，再往上找到带 `\documentclass` 的目录），所以 renderer 无法让
 * 主进程去读一个根之外的 .bib。magic comment 改写项目根的情形也同一份事实——
 * 编译读的是哪个目录，补全读的就是哪个目录。
 */
import { ipcMain } from "electron";
import {
  citeChannels,
  type CiteFileContext,
  type CiteLibraryOutcome,
} from "../../shared/cite.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { describeLatexProject } from "../latex/project.ts";
import { locateLatexProject } from "../latex/ipc.ts";
import { collectCiteLibrary } from "./library.ts";

export function registerCiteIpc(workspaces: WorkspaceStore, sessions: SessionStore): void {
  ipcMain.handle(
    citeChannels.library,
    async (_event, req: CiteFileContext): Promise<CiteLibraryOutcome> => {
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return { found: false };
      // 编译真正用的目录（magic root 会改写它），不是「文件所在目录」
      const project = describeLatexProject(located.dir);
      return { found: true, library: collectCiteLibrary(project.dir) };
    },
  );
}
