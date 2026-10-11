/**
 * 主循环系统提示词的「进度说明」改写（2026-10-12 用户裁决）。
 *
 * 背景：工具调用和思考在界面上默认折叠，用户只能看到正文。pi 0.84.3 的基础
 * 系统提示词里写死了 `Be concise in your responses`（system-prompt.js:79），统计
 * claude-opus-5-5 有 92% 的工具轮不写任何正文——用户看不出 agent 在干什么。
 *
 * 两件事（都在 orbita 侧做，不改 pi 的 patch）：
 * 1. 把 `- Be concise in your responses` 整行替换成 `- Be concise in your final answers.`
 *    ——简洁的是最终答复，过程要说话；
 * 2. 追加一段进度说明要求（措辞用户已认可），讲清楚折叠机制下何时写正文。
 *
 * 健壮性：替换按**整行精确匹配**——pi 升级改了措辞就匹配不到，此时只追加、
 * 不报错（升级后首次跑回归测试会发现，线上不炸）。追加段幂等：输入里已含
 * 该段（防御性，正常流程每轮都从 pi 的原版基底开始）就不再追加，保证只出现一次。
 *
 * 与 cc-billing-patch 的关系：那边在 wire 层（before_provider_request）只洗
 * OAuth 请求里的 pi 自称词，本段的替换句与中文追加段都不含触发词，互不冲突。
 */

/** pi 0.84.3 基础提示词里的原句（guidelines 列表渲染成 `- ` 前缀的行） */
const CONCISE_LINE = "- Be concise in your responses";

/** 替换后的句：简洁的是最终答复，不是过程 */
const CONCISE_LINE_REPLACEMENT = "- Be concise in your final answers.";

/** 进度说明段（措辞用户已认可，一字不改；prompt-narration.test.ts 锚定全文） */
export const PROGRESS_NARRATION_GUIDELINE =
  "工具调用和思考在界面上默认折叠，用户只能看到你写出的正文。\n" +
  "开始一组工具调用前，用一句话说明接下来要做什么；每完成一个阶段（调研结束、定位到原因、改完、验证完），用一两句话写出阶段性结论。\n" +
  "不要逐个工具复述命令，也不要把思考原文搬进正文。";

/**
 * 改写主循环的系统提示词：替换 concise 行 + 追加进度说明段。
 * 纯函数；`before_agent_start` 每轮对 pi 现拼的基底跑一遍。
 */
export function adaptSystemPrompt(base: string): string {
  // 整行精确匹配才替换：前缀相同但更长的行（如文档里引用的变体）不动
  const replaced = base
    .split("\n")
    .map((line) => (line.trim() === CONCISE_LINE ? CONCISE_LINE_REPLACEMENT : line))
    .join("\n");
  if (replaced.includes(PROGRESS_NARRATION_GUIDELINE)) return replaced;
  return `${replaced}\n\n${PROGRESS_NARRATION_GUIDELINE}`;
}
