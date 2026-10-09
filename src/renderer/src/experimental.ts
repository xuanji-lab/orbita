import { createContext, useContext } from "react";

/**
 * 实验功能总开关（`settings.experimental`，App 解析后提供，缺省 false）。
 * 关着时挂在其后的入口不渲染：纸面皮肤两档（copybook / typescript）的选择卡，
 * 以及会话生命周期三件套——完成标记、收尾扫描与遗留事项、星标——的全部入口。
 * 只藏入口不动数据，开关打开原样回来（语义的契约面在 shared/settings.ts）。
 *
 * 走 Context 而不是层层 props：消费面散在 Sidebar / ChatView / SettingsView，
 * 还有 Drawer 与 Sub-sessions 面板里**复用的 ChatView**——横切开关逐层传 props
 * 要动每一个中间签名，漏一层就漏一个入口。与 LocaleContext 同构。
 */
export const ExperimentalContext = createContext(false);

/** 当前实验开关。缺省 false（测试 / 树外渲染 = 实验功能不在） */
export function useExperimental(): boolean {
  return useContext(ExperimentalContext);
}
