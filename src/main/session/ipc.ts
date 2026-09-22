/**
 * 会话的 IPC —— 四层契约的第 2 层。
 * 落盘那一半在 `recorder.ts`：它是纯模块，抽出去是为了能被 `node --test` 直接测。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  transcriptToMarkdown,
  type CarryoverDraft,
  type CarryoverStatus,
  type SessionCompletion,
} from "../../shared/session.ts";
import type { AgentHost } from "../agent/host.ts";
import type { CarryoverStore } from "./carryover-store.ts";
import type { SessionStore } from "./store.ts";

export function registerSessionIpc(
  store: SessionStore,
  onSessionRemoved: ((id: string) => void) | undefined,
  agentHost: AgentHost,
  carryovers: CarryoverStore,
): void {
  ipcMain.handle(ipcChannels.sessionList, () => store.list());
  ipcMain.handle(ipcChannels.sessionLoad, (_event, id: string) => store.load(id));
  ipcMain.handle(ipcChannels.sessionRename, (_event, id: string, title: string) =>
    store.rename(id, title),
  );
  ipcMain.handle(ipcChannels.sessionDelete, async (_event, id: string) => {
    // 先停事件源再删文件：顺序反了的话，runtime 里还活着的会话会继续喷事件，
    // record() 虽有 meta 守卫不会重建文件，但那一轮里事件还是白跑
    onSessionRemoved?.(id);
    await store.remove(id);
  });
  // 工作台现状：删除确认项要把「里面有几个文件」说出来（提示后删）。
  // 按需现算，见 store.workbenchStat
  ipcMain.handle(ipcChannels.sessionWorkbenchStat, (_event, id: string) =>
    store.workbenchStat(id),
  );
  ipcMain.handle(ipcChannels.sessionPin, (_event, id: string, pinned: boolean) =>
    store.setPinned(id, pinned),
  );
  ipcMain.handle(ipcChannels.sessionStar, (_event, id: string, starred: boolean) =>
    store.setStarred(id, starred),
  );
  ipcMain.handle(
    ipcChannels.sessionSetCompletion,
    (_event, id: string, completion: SessionCompletion) => store.setCompletion(id, completion),
  );
  // —— 遗留事项（收尾仪式）三通道。store 铸 id/status/时间戳，renderer 不猜 ——
  ipcMain.handle(ipcChannels.carryoverList, () => carryovers.list());
  ipcMain.handle(
    ipcChannels.carryoverCreate,
    (_event, sessionId: string, drafts: CarryoverDraft[]) => carryovers.append(sessionId, drafts),
  );
  ipcMain.handle(
    ipcChannels.carryoverSetStatus,
    (_event, id: string, status: CarryoverStatus) => carryovers.setStatus(id, status),
  );
  ipcMain.handle(ipcChannels.sessionArchive, (_event, id: string, archived: boolean) =>
    store.setArchived(id, archived),
  );
  ipcMain.handle(
    ipcChannels.sessionMove,
    (_event, id: string, workspaceId: string | null) => store.move(id, workspaceId),
  );

  /**
   * 从某条 agent 回答另起一支（C-2）。三步有序：先在本地算前缀与角色序列（store），
   * 再让 pi 把它的本子裁一份新文件（agent 进程，对账守卫在那边），最后才把新会话
   * 落盘——中途失败最多留一个孤儿 pi 文件，不出现「看得见历史但 pi 没有前文」的
   * 半残会话。
   */
  ipcMain.handle(
    ipcChannels.sessionBranch,
    async (_event, id: string, anchorItemId: string): Promise<string> => {
      const plan = await store.prepareBranch(id, anchorItemId);
      const piSessionFile = await agentHost.branchSession(
        {
          sourcePiSessionFile: plan.sourcePiSessionFile,
          cwd: plan.meta.cwd,
          roles: plan.roles,
        },
        plan.newId,
      );
      await store.commitBranch(plan, piSessionFile);
      return plan.newId;
    },
  );

  /**
   * 导出成 Markdown。**渲染在主进程做**：`transcriptToMarkdown` 在 shared，
   * 与「复制整条对话」是同一份实现；写文件必须在主进程（renderer 在 sandbox 里）。
   */
  ipcMain.handle(ipcChannels.sessionExport, async (event, id: string): Promise<string | null> => {
    const detail = await store.load(id);
    if (detail === null) return null;
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { defaultPath: `${safeFileName(detail.meta.title || id)}.md` };
    const result = await (window
      ? dialog.showSaveDialog(window, options)
      : dialog.showSaveDialog(options));
    if (result.canceled || result.filePath === undefined) return null;
    await writeFile(result.filePath, transcriptToMarkdown(detail.transcript, detail.meta), "utf8");
    return result.filePath;
  });
}

/**
 * 标题 → 能当文件名的东西。**这是安全检查，不是美观**：标题是用户输入的，
 * 里面的 `/` 会被当成路径分隔符，`..` 会往上跳一级。
 */
function safeFileName(title: string): string {
  return title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, "-").replace(/^\.+/, "").slice(0, 80) || "task";
}
