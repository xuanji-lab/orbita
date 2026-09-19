/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 *
 * 开轮的装配（密钥解析、继承规则、meta 校准）全在 ./dispatch.ts——renderer 的
 * submit 与 agent 工具 start_task（B-2）必须走同一套真相，这里只做 IPC 形状。
 */
import { BrowserWindow, ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "../session/store.ts";
import type { TurnAssembler } from "./dispatch.ts";
import { resolveProviderSecrets } from "./dispatch.ts";
import type { AgentHost } from "./host.ts";

export function registerAgentIpc(
  host: AgentHost,
  providers: ProviderStore,
  sessions: SessionStore,
  /** 开轮装配器（submit / interrupt / compact 共用，start_task 也走它） */
  assembler: TurnAssembler,
): void {
  ipcMain.handle(ipcChannels.providerBuiltins, () => host.listBuiltins());

  ipcMain.handle(ipcChannels.agentSubmit, (_e, input: Parameters<TurnAssembler["submit"]>[0]): Promise<void> =>
    assembler.submit(input),
  );
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));
  ipcMain.handle(ipcChannels.agentInterrupt, (_e, input: Parameters<TurnAssembler["interrupt"]>[0]): Promise<void> =>
    assembler.interrupt(input),
  );
  ipcMain.handle(ipcChannels.agentCompact, (_e, input: Parameters<TurnAssembler["compact"]>[0]): Promise<void> =>
    assembler.compact(input),
  );

  ipcMain.handle(
    ipcChannels.agentSetMode,
    async (_e, sessionId: string, mode: PermissionMode) => {
      await host.setMode(sessionId, mode);
      // 档位也落盘：重开这条会话时不该静默换档，而这一档决定 bash 能不能跑
      await sessions.setMode(sessionId, mode);
    },
  );

  ipcMain.handle(
    ipcChannels.agentSetModel,
    async (_e, sessionId: string, providerId: string, modelId: string) => {
      // provider 在这里装配（含 key）再传给 runtime——renderer 永远不碰密钥。
      // meta 不在此落：成功与否由 runtime 的 model / failed 事件定，recorder 统一落盘。
      const provider = await resolveProviderSecrets(providers, providerId);
      await host.setModel(sessionId, provider, modelId);
    },
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
