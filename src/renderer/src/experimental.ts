import { createContext, useContext } from "react";
import type { ExperimentalFeatureId } from "@shared/settings";

/**
 * 实验功能的逐项开关（`settings.experimentalFeatures`，App 解析后提供）。
 * 每个功能自己开 / 关（2026-10-12 用户裁决），关着时挂在其后的入口不渲染：
 * - `paper-themes`：主题选择卡的纸面两档（copybook / typescript）；
 * 只藏入口不动数据，开了原样回来（语义的契约面在 shared/settings.ts）。
 *
 * 走 Context 而不是层层 props：消费面散在 Sidebar / ChatView / SettingsView，
 * 还有 Drawer 与 Sub-sessions 面板里**复用的 ChatView**——横切开关逐层传 props
 * 要动每一个中间签名，漏一层就漏一个入口。与 LocaleContext 同构。
 */
export const ExperimentalFeaturesContext = createContext<
  Readonly<Partial<Record<ExperimentalFeatureId, boolean>>>
>({});

/**
 * 设置里还没有 experimentalFeatures 字段时的 Provider 值：**必须是同一个对象**。
 * 写成 `?? {}` 时每次 App 渲染都新建空对象，Context 跟着变，所有消费者（每条消息的
 * MarkdownBlock 都是）穿透 memo 逐帧重渲染——流式输出期间就是整条对话逐帧重算。
 */
export const NO_EXPERIMENTAL_FEATURES: Readonly<Partial<Record<ExperimentalFeatureId, boolean>>> = Object.freeze({});

/** 某一项实验功能开着吗。缺省（测试 / 树外渲染 / 键不在）= false */
export function useExperimentalFeature(id: ExperimentalFeatureId): boolean {
  return useContext(ExperimentalFeaturesContext)[id] === true;
}
