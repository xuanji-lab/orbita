/**
 * 系统提示词的**装配**：段落顺序集中在这里，runtime 只管给出各段内容。
 *
 * 为什么单独一个模块：顺序是契约，而 runtime.ts 顶层有副作用（读 parentPort、没有就
 * 退出进程），测试不能 import 它——把顺序留在那边的数组里就没人能钉住它。
 *
 * 三条顺序约束，改这里之前先读：
 * 1. **身份段恒在最前**（紧跟 pi 基底）：产品身份是模型读到的第一件事，也不允许调用方
 *    漏掉——它由本模块自己拼，不在入参里。
 * 2. **回复语言段恒在最末**：离对话最近、权重最高。放中间时，前面整篇提示词与工作区
 *    AGENTS.md 的中文会把模型往中文带（2026-10-12 实测：英文提问仍回中文）。
 * 3. **空串段被滤掉**（Git 标识关了、意图上下文缺席都是空串），否则提示词里多出空行。
 *    段之间的分隔符也只有这里说了算。
 */
import { ORBITA_IDENTITY_GUIDELINE } from "./identity-prompt.ts";

/**
 * 各段内容。**顺序不在这里**——对象字面量的键序不构成契约，本模块按下面的固定顺序
 * 拼；调用方怎么排这些字段都不影响结果。
 */
export interface SystemPromptParts {
  /** pi 基底，已过 adaptSystemPrompt */
  base: string;
  /** 权限档说明：describePermissionMode */
  permission: string;
  /** 开轮目录清单：describeDirectories */
  directories: string;
  /** 通道角色说明：describeChannelRole（root / child 各一段） */
  channelRole: string;
  /** 工作区归属（store 工具）：storeToolsGuideline */
  storeTools: string;
  /** 工具选型 + 非编程能力主动提及：TOOL_SELECTION_GUIDELINE + PROACTIVE_CAPABILITY_GUIDELINE */
  toolSelection: string;
  /** bash 参数纪律：TOOL_GUIDELINES */
  toolGuidelines: string;
  /** expected_seconds：EXPECTED_SECONDS_GUIDELINE */
  expectedSeconds: string;
  /** 意图上下文说明：只在开轮带意图载荷时给，否则空串 */
  intent: string;
  /** 编号引用读法：QUOTE_GUIDELINE */
  quote: string;
  /** Git 归属标识：gitAttributionGuideline */
  gitAttribution: string;
  /** 回复语言：REPLY_LANGUAGE_GUIDELINE（恒在最末） */
  replyLanguage: string;
}

/** 按固定顺序拼出一轮的系统提示词；空串段被滤掉。 */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  return [
    parts.base,
    ORBITA_IDENTITY_GUIDELINE,
    parts.permission,
    parts.directories,
    parts.channelRole,
    parts.storeTools,
    parts.toolSelection,
    parts.toolGuidelines,
    parts.expectedSeconds,
    parts.intent,
    parts.quote,
    parts.gitAttribution,
    parts.replyLanguage,
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}
