/**
 * agent 域的 contextBridge 面 —— 四层契约的第 3 层。
 * 只依赖 electron 与 src/shared。事件流是订阅式：renderer 拿到的是 pi-protocol 的 progress，
 * 用 pi 自带的 transcript 归约器消费，主进程不预处理。
 */
import { ipcRenderer } from "electron";
import {
  ipcChannels,
  type AgentEvent,
  type CompactAgentInput,
  type SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";

export const agentApi = {
  /**
   * 发一轮（无状态：原 create 的全部上下文随每次 submit 带上）。
   * sessionId 由 renderer 生成；resume 带上已知 pi 本子，null = 开新本子。
   */
  submit: (input: SubmitAgentInput): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSubmit, input),
  abort: (sessionId: string): Promise<void> => ipcRenderer.invoke(ipcChannels.agentAbort, sessionId),

  /** 停下当前这一轮（含工具调用），把这句话作为新一轮发出去。队列在 renderer 一侧 */
  interrupt: (input: SubmitAgentInput): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentInterrupt, input),

  /** 手动压缩上下文（`/compact`）。忙碌态与界碑从 agent:event 的 compaction 事件回来 */
  compact: (input: CompactAgentInput): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentCompact, input),
  setMode: (sessionId: string, mode: PermissionMode): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSetMode, sessionId, mode),
  /** 会话内换模型（C-4）：下一轮生效。结果走 agent:event 的 model / failed 事件 */
  setModel: (sessionId: string, providerId: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSetModel, sessionId, providerId, modelId),
  /** 回答一次工具审批 */
  answerPermission: (requestId: string, answer: PermissionAnswer): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentAnswerPermission, requestId, answer),
  onEvent: (listener: (event: AgentEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(ipcChannels.agentEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler);
  },
};
