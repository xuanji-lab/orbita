/** 发件箱的 IPC（四层契约第 2 层）：store 在 outbox.ts（不碰 electron，可直测） */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isOutboxEntry } from "../../shared/outbox.ts";
import type { OutboxStore } from "./outbox.ts";

export function registerOutboxIpc(store: OutboxStore): void {
  // put 要等写完才回：renderer 拿到回执才开跑（先落盘再开跑）
  ipcMain.handle(ipcChannels.outboxPut, async (_event, entry: unknown) => {
    if (!isOutboxEntry(entry)) throw new Error("outbox: bad entry");
    await store.put(entry);
  });
  ipcMain.handle(ipcChannels.outboxRemove, (_event, id: unknown) => (typeof id === "string" ? store.remove(id) : undefined));
  ipcMain.handle(ipcChannels.outboxList, () => store.list());
}
