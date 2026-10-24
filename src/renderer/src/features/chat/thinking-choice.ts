/**
 * 「这一次开工该用哪一档」——ComposerBar（输入框底栏的思考档菜单）与 useChatSession
 * （新任务槽起档）共用同一份判定，不各写一份默认档规则。「一个型号支持哪些思考档」
 * 在 shared/model-defaults 的 modelThinkingLevels：会话注册也要和它比（一致性测试），
 * 所以住在 renderer 与 agent 都能加载的地方。
 */
import type { ThinkingLevel } from "@shared/thinking";
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名（type import 剥离后无此问题）
import { defaultThinkingLevel } from "../../../../shared/model-defaults.ts";

/**
 * 这一次开工该用哪一档：用户本次运行内手选的档（`picked`）仍被这个型号支持
 * （或支持集未知——那时不替用户否决他刚选的档）就用它；否则落这个型号的默认档
 * （`defaultThinkingLevel`：白名单默认档 > medium，再按支持集夹）。
 *
 * 语义源自用户裁决（wafo 2026-09-23）：彻底重启才回到模型默认档，没重启就记住
 * 上一次手选，换到不支持那一档的型号时才落回默认档。
 */
export function resolveThinkingLevel(options: {
  modelId: string;
  supported: readonly ThinkingLevel[] | null;
  picked: ThinkingLevel | null;
}): ThinkingLevel {
  const { modelId, supported, picked } = options;
  if (picked !== null && (supported === null || supported.includes(picked))) return picked;
  return defaultThinkingLevel(modelId, supported);
}
