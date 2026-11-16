/**
 * 常驻主智能体的 IPC —— 四层契约的第 2 层（`agents:main`）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { parseMainAgentModel, type MainAgentProfile } from "../../shared/main-agent.ts";
import type { SessionStore } from "../session/store.ts";
import { mainAgentOf, type MainAgentStore } from "./main-agent.ts";

export function registerMainAgentIpc(store: MainAgentStore, sessions: SessionStore): void {
  ipcMain.handle(ipcChannels.agentsMain, async (_event, raw: unknown): Promise<MainAgentProfile> => {
    if (typeof raw !== "string" || raw === "") throw new Error("agents:main 需要工作区 id");
    return mainAgentOf(store, sessions, raw);
  });
  ipcMain.handle(ipcChannels.agentsSetMainModel, async (_event, raw: unknown): Promise<MainAgentProfile> => {
    const input = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const workspaceId = input["workspaceId"];
    const model = parseMainAgentModel(input["model"]);
    if (typeof workspaceId !== "string" || workspaceId === "" || model === null) throw new Error("agents:set-main-model 需要工作区 id 与完整的型号");
    return store.setModel(workspaceId, model);
  });
}
