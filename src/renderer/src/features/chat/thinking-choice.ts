/**
 * 「这一次开工该用哪一档」与「会话记着的档还能不能发」——ComposerBar（输入框底栏的思考档
 * 菜单）与 useChatSession（新任务槽起档 / 换模型 / 打开旧会话）共用同一份判定，不各写一份
 * 默认档规则。「一个型号支持哪些思考档」
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

/**
 * **会话账里的档**落到某个型号上仍然是它能发的档吗：不是就退这个型号的默认档。
 * （移植自 PR 180，@XIAOZF99）
 *
 * 与 `resolveThinkingLevel` 的差别在「档从哪来」：那个是**用户手选**过的（手选不
 * 该被悄悄改掉，换了型号也只在他手选的档发不出去时才退）；这个是**会话自己记的**——
 * 打开一条旧会话、或换模型时它当前那一档——没有手选可尊重，只问「发得出去吗」。
 *
 * 存在这条纠偏的理由是真实发生过的一类账：会话记的档可以是**这个型号进白名单之前**
 * 选的（step-5-preview 在 pi 眼里曾经是不能思考的型号，于是会话账里留着 off），也
 * 可以是白名单收紧了支持集之后留下的（OpenCode Go 的 kimi-k3 以前菜单给 low，现在只有
 * max）。不纠的话 chip 说一档、pi 发送前夹成另一档——两处说法不一致。
 *
 * 支持集未知（null）时原样返回：不替用户否决，pi 发送前按同规则夹。
 */
export function reconcileThinkingLevel(
  level: ThinkingLevel,
  modelId: string,
  supported: readonly ThinkingLevel[] | null,
): ThinkingLevel {
  if (supported === null || supported.includes(level)) return level;
  return defaultThinkingLevel(modelId, supported);
}
