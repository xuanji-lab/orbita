/**
 * 自动化的 contextBridge 面 —— 四层契约的第 3 层。右栏自动化面板与对话里的自动化卡片
 * 的全部数据与写操作从这里走；变更推送走 onEvent（载荷不带数据，听到就重拉 list）。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type {
  Automation,
  AutomationAction,
  AutomationCreateInput,
  AutomationEvent,
  AutomationOutcome,
  AutomationPatch,
} from "../../shared/automation.ts";

export const automationApi = {
  /** 全部自动化（所有工作区）；实验开关关着回空 */
  list: (): Promise<Automation[]> => ipcRenderer.invoke(ipcChannels.automationList),
  /** 面板里手建（只能新开会话），直接生效 */
  create: (input: AutomationCreateInput): Promise<AutomationOutcome> => ipcRenderer.invoke(ipcChannels.automationCreate, input),
  update: (id: string, patch: AutomationPatch): Promise<AutomationOutcome> =>
    ipcRenderer.invoke(ipcChannels.automationUpdate, id, patch),
  /** 暂停 / 继续 / 重新启动 / 立即运行 / 删除 */
  act: (id: string, action: AutomationAction): Promise<AutomationOutcome> =>
    ipcRenderer.invoke(ipcChannels.automationAct, id, action),
  /** 「转成普通会话」：自动化新开的会话进左侧栏 */
  promote: (sessionId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(ipcChannels.automationPromote, sessionId),
  onEvent: (listener: (event: AutomationEvent) => void): (() => void) => {
    const handler = (_e: unknown, event: AutomationEvent) => listener(event);
    ipcRenderer.on(ipcChannels.automationEvent, handler);
    return () => ipcRenderer.removeListener(ipcChannels.automationEvent, handler);
  },
};
