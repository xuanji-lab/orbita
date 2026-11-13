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
  type CiteSaveOutcome,
  type CiteSaveRequest,
  type CiteSearchOutcome,
  type CiteSearchRequest,
} from "../../shared/cite.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { describeLatexProject } from "../latex/project.ts";
import { locateLatexProject } from "../latex/ipc.ts";
import { collectCiteLibrary } from "./library.ts";
import { searchCite } from "./search.ts";
import { writeCiteEntry } from "./save.ts";

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

  /**
   * 在线检索。**不查白名单**：请求里只有一个查询串，不涉及任何本地文件；能联网的
   * 只有这一个 handler，而且只在用户点「查找」时被调用一次。查询串的长度与形状
   * 由 `searchCite` 自己认（超长串在 URL 里会被服务端拒，不必在这里另设上限）。
   */
  ipcMain.handle(
    citeChannels.search,
    async (_event, req: CiteSearchRequest): Promise<CiteSearchOutcome> =>
      searchCite(typeof req?.query === "string" ? req.query : ""),
  );

  /**
   * 写 .bib。授权与 library 同一道：项目目录从「根 + 当前文件」现算，renderer 给不出
   * 目录，也就不可能让主进程往一个白名单外的 .bib 里追加条目。
   */
  ipcMain.handle(citeChannels.save, async (_event, req: CiteSaveRequest): Promise<CiteSaveOutcome> => {
    const located = await locateLatexProject(req.context, workspaces, sessions);
    if (located === null) return { ok: false, reason: "outside-project", detail: req.context.path };
    const project = describeLatexProject(located.dir);
    return writeCiteEntry(project.dir, project.main, req.candidate);
  });
}
