/**
 * 常驻主智能体的 IPC —— 四层契约的第 2 层（`agents:main`）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { MainAgentProfile } from "../../shared/main-agent.ts";
import type { SessionStore } from "../session/store.ts";
import { mainAgentOf, type MainAgentStore } from "./main-agent.ts";

export function registerMainAgentIpc(store: MainAgentStore, sessions: SessionStore): void {
  ipcMain.handle(ipcChannels.agentsMain, async (_event, raw: unknown): Promise<MainAgentProfile> => {
    if (typeof raw !== "string" || raw === "") throw new Error("agents:main 需要工作区 id");
    return mainAgentOf(store, sessions, raw);
  });
}
