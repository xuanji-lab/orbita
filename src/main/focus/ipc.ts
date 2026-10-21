/**
 * 专注模式的 IPC —— 四层契约的第 2 层。
 *
 * 两个通道都只读 / 只发：U / M 走 git-source 的同一套只读 runner（不另起一套
 * git 调用），系统通知是 Electron 的 Notification（renderer sandbox 里没有）。
 * 路径策略在主进程：renderer 只传 workspaceId，路径由 WorkspaceStore 解——
 * 不信 renderer 传来的任何路径（同 review:ipc 读 meta.cwd 的纪律）。
 */
import { BrowserWindow, Notification, ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { FocusChanges, FocusNotifyRequest } from "../../shared/focus.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { gitWorkdirChanges, realGitRunner } from "../review/git-source.ts";

export function registerFocusIpc(workspaces: WorkspaceStore): void {
  ipcMain.handle(ipcChannels.focusChanges, async (_event, raw: unknown): Promise<FocusChanges> => {
    if (typeof raw !== "string") return { kind: "error", message: "invalid focus changes request" };
    const workspace = (await workspaces.list()).find((item) => item.id === raw);
    if (workspace === undefined) {
      return { kind: "error", message: `工作区 ${raw} 不存在（可能刚被移除）` };
    }
    try {
      return await gitWorkdirChanges(realGitRunner, workspace.path);
    } catch (cause) {
      return { kind: "error", message: cause instanceof Error ? cause.message : String(cause) };
    }
  });

  ipcMain.handle(ipcChannels.focusNotifyDone, async (_event, req: FocusNotifyRequest): Promise<void> => {
    // 时间到的提醒是「把人叫回来」：点通知聚焦主窗口（多窗口时聚焦最近使用的那张——
    // 专注是单窗口里的事，第一张就是我们自己的）
    const notice = new Notification({ title: req.title, body: req.body });
    notice.on("click", () => {
      const [first] = BrowserWindow.getAllWindows();
      first?.focus();
    });
    notice.show();
  });
}
