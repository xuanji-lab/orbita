/**
 * agent 域的 contextBridge 面 —— 四层契约的第 3 层。
 * 只依赖 electron 与 src/shared。事件流是订阅式：renderer 拿到的是 pi-protocol 的 progress，
 * 用 pi 自带的 transcript 归约器消费，主进程不预处理。
 */
import { ipcRenderer } from "electron";
import { ipcChannels, type AgentEvent, type CreateAgentInput } from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";

export const agentApi = {
  create: (input: CreateAgentInput): Promise<string> =>
    ipcRenderer.invoke(ipcChannels.agentCreate, input),
  submit: (sessionId: string, text: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSubmit, sessionId, text),
  /** 编辑排队消息：promote = 转插队，cancel = 移出队列。index+text 防错删（乐观校验） */
  queueEdit: (
    sessionId: string,
    op: "promote" | "cancel",
    index: number,
    text: string,
  ): Promise<void> => ipcRenderer.invoke(ipcChannels.agentQueueEdit, sessionId, op, index, text),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke(ipcChannels.agentAbort, sessionId),
  /** 手动压缩上下文（`/compact`）。忙碌态与界碑从 agent:event 的 compaction 事件回来 */
  compact: (sessionId: string, instructions?: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentCompact, sessionId, instructions),
  setMode: (sessionId: string, mode: PermissionMode): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSetMode, sessionId, mode),
  /** 回答一次工具审批 */
  answerPermission: (requestId: string, answer: PermissionAnswer): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentAnswerPermission, requestId, answer),
  onEvent: (listener: (event: AgentEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(ipcChannels.agentEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler);
  },
};
