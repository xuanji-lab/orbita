import { createContext, useContext } from "react";
import type { ExperimentalFeatureId } from "@shared/settings";

/**
 * 实验功能的逐项开关（`settings.experimentalFeatures`，App 解析后提供）。
 * 每个功能自己开 / 关（2026-10-12 用户裁决），关着时挂在其后的入口不渲染：
 * - `paper-themes`：主题选择卡的纸面两档（copybook / typescript）；
 * - `session-lifecycle`：星标 / 完成标记 / 收尾扫描与遗留事项的全部入口；
 * - `composer-blackhole`：输入框黑洞（App 里合成 BlackholeContext，不走这个 hook）。
 * 只藏入口不动数据，开了原样回来（语义的契约面在 shared/settings.ts）。
 *
 * 走 Context 而不是层层 props：消费面散在 Sidebar / ChatView / SettingsView，
 * 还有 Drawer 与 Sub-sessions 面板里**复用的 ChatView**——横切开关逐层传 props
 * 要动每一个中间签名，漏一层就漏一个入口。与 LocaleContext 同构。
 */
export const ExperimentalFeaturesContext = createContext<
  Readonly<Partial<Record<ExperimentalFeatureId, boolean>>>
>({});

/** 某一项实验功能开着吗。缺省（测试 / 树外渲染 / 键不在）= false */
export function useExperimentalFeature(id: ExperimentalFeatureId): boolean {
  return useContext(ExperimentalFeaturesContext)[id] === true;
}
