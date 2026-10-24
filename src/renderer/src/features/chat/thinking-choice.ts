/**
 * 「一个型号支持哪些思考档」「这一次开工该用哪一档」「芯片那一句话该说什么」——
 * 三个纯函数，ComposerBar（输入框底栏的思考档菜单）与 useChatSession（新任务槽起档）
 * 共用同一份判定，两处不该对同一个模型说出两个支持集，也不该各写一份默认档规则。
 */
import type { BuiltinProvider } from "@shared/agent-ipc";
import type { ThinkingLevel } from "@shared/thinking";
// 值 import 必须走相对路径：node --test 解析不了 @shared 别名（type import 剥离后无此问题）
import { clampThinkingLevel } from "../../../../shared/thinking.ts";
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
 * 思考档芯片这一格该说什么。**文字与 title 必须出自同一份支持集**——否则同一枚
 * 芯片会同时说「中」和「这个模型不支持思考」（2026-10-24 实测的成对现象：自定义 id
 * 被 pi 按非推理模型注册，支持集只有 `off`，而文字取的是意图档）。
 *
 * - `level`：支持集已知且不含意图档时，显示 pi 会夹到的那一档（`clampThinkingLevel`，
 *   与 pi 同规则：先往深、再往浅）——芯片报真正会发生的档，不是点了却没生效的意图。
 *   支持集未知（null）时不替 pi 做主，原样显示意图档。
 * - `offOnly`：支持集只有 `off`（推理关着的模型）→ title 说「这个模型不支持思考」。
 *   此时文字必然是「关」，两句话不再互相打脸。
 */
export function resolveThinkingChip(options: {
  level: ThinkingLevel;
  supported: readonly ThinkingLevel[] | null;
}): { level: ThinkingLevel; offOnly: boolean } {
  const { level, supported } = options;
  return {
    level: clampThinkingLevel(level, supported),
    offOnly: supported !== null && supported.length > 0 && supported.every((one) => one === "off"),
  };
}
