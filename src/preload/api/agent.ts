/**
 * agent 域的 contextBridge 面 —— 四层契约的第 3 层。
 * 只依赖 electron 与 src/shared。事件流是订阅式：renderer 拿到的是 pi-protocol 的 progress，
 * 用 pi 自带的 transcript 归约器消费，主进程不预处理。
 */
import { ipcRenderer } from "electron";
import { ipcChannels, type AgentEvent, type CreateAgentInput } from "../../shared/agent-ipc.ts";

export const agentApi = {
  create: (input: CreateAgentInput): Promise<string> =>
    ipcRenderer.invoke(ipcChannels.agentCreate, input),
  submit: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSubmit, sessionId, text),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke(ipcChannels.agentAbort, sessionId),
  onEvent: (listener: (event: AgentEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(ipcChannels.agentEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler);
  },
};
