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
import type { ThinkingLevel } from "../../shared/thinking.ts";
import type { IntentConfirmDecision } from "../../shared/intent-confirm.ts";
import type { BashSessionsSnapshot } from "../../shared/bash-session.ts";

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
  /** 会话内改思考档：下一轮生效，开轮时由 runtime 按 meta 装配 */
  setThinkingLevel: (sessionId: string, level: ThinkingLevel): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSetThinkingLevel, sessionId, level),
  /** 会话内换模型（C-4）：下一轮生效。结果走 agent:event 的 model / failed 事件 */
  setModel: (sessionId: string, providerId: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentSetModel, sessionId, providerId, modelId),
  /** 回答一次工具审批 */
  answerPermission: (requestId: string, answer: PermissionAnswer): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentAnswerPermission, requestId, answer),
  /**
   * 停掉一个后台 bash 会话（行尾停止钮，点一下直接发）。
   * **没有回执**：停完的落定态是 runtime 写回对话的那条终态记录。
   */
  stopBashSession: (sessionId: string, bashId: string): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentBashStop, sessionId, bashId),
  /**
   * 这条会话名下「此刻还在跑的后台命令」快照（带着回答它的 agent 进程标识）。
   * 界面拿交还提示里的 `run=` 比对，判出那一行是同一进程里正常在跑、还是上一个进程留下的。
   * null = 没问出来（超时），调用方维持原判。
   */
  bashSessions: (sessionId: string): Promise<BashSessionsSnapshot | null> =>
    ipcRenderer.invoke(ipcChannels.agentBashState, sessionId),
  /** 意图确认卡的回答（实验功能 intent-system）：对不上号的陈旧应答丢弃不串台 */
  answerIntentConfirm: (requestId: string, decision: IntentConfirmDecision): Promise<void> =>
    ipcRenderer.invoke(ipcChannels.agentAnswerIntentConfirm, requestId, decision),
  onEvent: (listener: (event: AgentEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(ipcChannels.agentEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.agentEvent, handler);
  },
};
