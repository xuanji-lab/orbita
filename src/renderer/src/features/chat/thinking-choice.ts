/**
 * 「一个型号支持哪些思考档」与「这一次开工该用哪一档」——三个纯函数，
 * ComposerBar（输入框底栏的思考档菜单）、useChatSession（新任务槽起档 / 换模型 /
 * 打开旧会话）共用同一份判定，几处不该对同一个模型说出两个支持集，也不该各写一份
 * 默认档规则。
 */
import type { BuiltinProvider } from "@shared/agent-ipc";
import type { ThinkingLevel } from "@shared/thinking";
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名（type import 剥离后无此问题）
import { knownModelParams } from "../../../../shared/known-providers.ts";
import { defaultThinkingLevel } from "../../../../shared/model-defaults.ts";

/**
 * 这个型号的支持档位集，`null` = 三处都不知道。来源三级（原样收编自 ChatView
 * 此前的三级来源逻辑，行为不变）：
 *
 *   白名单 knownModelParams(id).thinkingLevels（人工确证的口径，赶在其余两级
 *   前面纠错——例：目录查不到的快速通道模型如 glm-5.3-flash，或目录给出错误
 *   支持集的情形）
 *   > observed（开轮事件回的真值，含 clamp 事实；调用方传 session.thinkingSupported）
 *   > 目录（BuiltinModel.supportedThinkingLevels，agent 进程在 pi 旁算好过线）
 *
 * 三者都没有 = 未知：调用方按「全量显示、不禁用」处理，不替 pi 撒谎——开轮后
 * 由 thinking 事件纠真。
 */
export function modelThinkingLevels(
  modelId: string,
  catalog: readonly BuiltinProvider[],
  observed?: readonly ThinkingLevel[] | null,
): readonly ThinkingLevel[] | null {
  const known = knownModelParams(modelId).thinkingLevels;
  if (known !== undefined) return known;
  if (observed != null) return observed;
  const entry = catalog.flatMap((provider) => provider.models).find((model) => model.id === modelId);
  return entry?.supportedThinkingLevels ?? null;
}

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
 *
 * 与 `resolveThinkingLevel` 的差别在「档从哪来」：那个是**用户手选**过的（手选不
 * 该被悄悄改掉，换了型号也只在他手选的档发不出去时才退）；这个是**会话自己记的**——
 * 打开一条旧会话、或换模型时它当前那一档——没有手选可尊重，只问「发得出去吗」。
 *
 * 存在这条纠偏的理由是真实发生过的一类账：会话记的档可以是**这个型号进白名单之前**
 * 选的（step-5-preview 在 pi 眼里曾经是不能思考的型号，于是会话账里留着 off），也
 * 可以是上一个型号留下的。不纠的话 chip 说 Off、模型其实一直在思考——两处说法不一致。
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
