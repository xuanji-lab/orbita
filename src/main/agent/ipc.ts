/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 */
import { BrowserWindow, ipcMain } from "electron";
import { ipcChannels, type CreateAgentInput } from "../../shared/agent-ipc.ts";
import type { ProviderStore } from "../provider/store.ts";
import { AgentHost } from "./host.ts";

export function registerAgentIpc(host: AgentHost, providers: ProviderStore): void {
  ipcMain.handle(
    ipcChannels.agentCreate,
    async (_event, input: CreateAgentInput): Promise<string> => {
      const apiKey = await providers.resolveApiKey(input.providerId);
      if (apiKey === null) {
        throw new Error(`provider "${input.providerId}" has no API key stored`);
      }
      // 明文密钥只在主进程 → agent 进程这一跳出现，永不进 renderer
      return host.createSession({ ...input, apiKey });
    },
  );

  ipcMain.handle(ipcChannels.agentSubmit, (_e, sessionId: string, text: string) =>
    host.submit(sessionId, text),
  );
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));
}

/** agent 进程的事件 → 所有窗口 */
export function broadcastAgentEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(ipcChannels.agentEvent, event);
  }
}
