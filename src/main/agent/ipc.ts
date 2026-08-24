/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 */
import { BrowserWindow, ipcMain } from "electron";
import { ipcChannels, type CreateAgentInput } from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import type { ProviderStore } from "../provider/store.ts";
import { AgentHost } from "./host.ts";

export function registerAgentIpc(host: AgentHost, providers: ProviderStore): void {
  ipcMain.handle(
    ipcChannels.agentCreate,
    async (_event, input: CreateAgentInput): Promise<string> => {
      const dto = (await providers.list()).find((p) => p.id === input.providerId);
      if (!dto) throw new Error(`unknown provider "${input.providerId}"`);
      const apiKey = await providers.resolveApiKey(input.providerId);
      if (apiKey === null) {
        throw new Error(`provider "${input.providerId}" has no API key stored`);
      }
      // 明文密钥只在主进程 → agent 进程这一跳出现，永不进 renderer
      return host.createSession({
        cwd: input.cwd,
        modelId: input.modelId,
        mode: input.mode,
        provider: {
          id: dto.id,
          api: dto.endpoint.api,
          baseUrl: dto.endpoint.baseUrl,
          apiKey,
          ...(dto.endpoint.headers ? { headers: dto.endpoint.headers } : {}),
          models: dto.models.declared.map((m) => m.id),
        },
      });
    },
  );

  ipcMain.handle(ipcChannels.providerBuiltins, () => host.listBuiltins());

  ipcMain.handle(ipcChannels.agentSubmit, (_e, sessionId: string, text: string) =>
    host.submit(sessionId, text),
  );
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));

  ipcMain.handle(ipcChannels.agentSetMode, (_e, sessionId: string, mode: PermissionMode) =>
    host.setMode(sessionId, mode),
  );

  // 用户对工具审批的回答，原样送回 agent 进程（按 requestId 对号）
  ipcMain.handle(
    ipcChannels.agentAnswerPermission,
    (_e, requestId: string, answer: PermissionAnswer) => host.answerPermission(requestId, answer),
  );
}

/** agent 进程的事件 → 所有窗口 */
export function broadcastAgentEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(ipcChannels.agentEvent, event);
  }
}
