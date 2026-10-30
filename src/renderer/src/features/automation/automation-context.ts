import { createContext, useContext } from "react";
import type { Automation, AutomationAction, AutomationOutcome } from "../../../../shared/automation.ts";

/**
 * 对话里要用的自动化现状（App 提供）：卡片读它的实时状态、点「在右栏查看」打开面板定位到那一条、
 * 点「暂停」直接转移；用户气泡认「这是不是自动化新开的会话」读 runSessionIds。
 * 走 Context 而不是层层 props：消费点在 ChatView 深处的 memo 组件里（同 ExperimentalFeaturesContext 的理由）。
 */
export interface AutomationUi {
  automations: readonly Automation[];
  /** 打开右栏自动化面板；给 id 就定位到那一条并展开 */
  openPanel: (automationId?: string) => void;
  act: (id: string, action: AutomationAction) => Promise<AutomationOutcome>;
}

const EMPTY: AutomationUi = {
  automations: [],
  openPanel: () => undefined,
  act: async () => ({ ok: false, error: "Automations are unavailable here." }),
};

export const AutomationContext = createContext<AutomationUi>(EMPTY);

export function useAutomationUi(): AutomationUi {
  return useContext(AutomationContext);
}

/**
 * 自动化新开且还没转成普通会话的会话 id：这些会话的第一条消息显示成气泡而不是唤醒分隔线。
 * **单独一个 Context**：用户消息行（每条都订阅）只需要这个集合，它几乎不变；跟 AutomationUi 合并的话，
 * 任何一条自动化的状态变化（每次到点 / 跑完）都会让所有对话行重渲染。
 */
export const AutomationRunSessionsContext = createContext<ReadonlySet<string>>(new Set<string>());

export function useAutomationRunSessions(): ReadonlySet<string> {
  return useContext(AutomationRunSessionsContext);
}
