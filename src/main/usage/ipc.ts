/**
 * 每日用量的 IPC —— 四层契约的第 2 层。
 *
 *   usage:week    renderer 拉最近 7 天（回填在途时可能是全 0，跑完推真值）
 *   usage:event   账本每次变化（模型调用落账 / 回填完成）推一份完整快照
 *
 * 启动**不阻塞**：load + backfill 异步跑，注册即返回——初始拉取先拿到空账，
 * 界面画空格；回填完 onChange 推一份真值把格子填上。
 */
import { ipcMain } from "electron";
import { mainWindows } from "../window/main-windows.ts";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { UsageWeekEvent } from "../../shared/usage.ts";
import type { UsageLedger, UsageBackfillSource } from "./ledger.ts";

export function registerUsageIpc(ledger: UsageLedger, sessions: UsageBackfillSource): void {
  ipcMain.handle(ipcChannels.usageWeek, () => ledger.week());

  ledger.onChange((days) => {
    const event: UsageWeekEvent = { days };
    for (const window of mainWindows.list()) {
      window.webContents.send(ipcChannels.usageEvent, event);
    }
  });

  void ledger
    .load()
    .then(() => ledger.backfill(sessions))
    .catch((error: unknown) => {
      console.error("[usage] 日账本装载 / 回填失败，下次启动重试", error);
    });
}
