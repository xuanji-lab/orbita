/**
 * 提示音记账的 IPC —— 四层契约的第 2 层。
 *
 * 只有一个通道：renderer 真响了一声就报一次，这里净化后追加进账本。记账失败
 * （磁盘满 / 权限）只打一行日志、不回抛——提示音与它的账都不能让任何流程失败。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { normalizeChimeLog, type ChimeLog } from "./chime-log.ts";

export function registerNotifyIpc(log: ChimeLog): void {
  ipcMain.handle(ipcChannels.notifyChimeLog, async (_event, raw: unknown): Promise<void> => {
    const request = normalizeChimeLog(raw);
    if (request === null) return;
    await log.append(request).catch((cause: unknown) => {
      console.warn("[notify] 提示音记账失败", cause);
    });
  });
}
