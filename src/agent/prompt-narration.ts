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
 * 2. 追加一段进度说明要求，讲清楚折叠机制下何时写正文，并要求正文跟随用户当前使用的语言。
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

/**
 * 进度说明段 + 回复语言（2026-10-12 用户裁决：正文跟随用户当前使用的语言）。
 *
 * **用英文写**：上一版是中文段落，提示词本身的语言会把模型往中文带——英文提问也回中文。
 * 段落语言中立化后，再明说「跟随用户最近一条消息的语言」，进度说明与最终答复都算。
 * prompt-narration.test.ts 锚定全文。
 */
export const PROGRESS_NARRATION_GUIDELINE =
  "Tool calls and thinking are collapsed by default in the UI; the user only sees the text you write.\n" +
  "Before a group of tool calls, say in one sentence what you are about to do; after each stage (research done, cause found, change made, verification done), state the outcome in one or two sentences.\n" +
  "Do not narrate every tool call, and do not paste your thinking into the reply.\n";

/**
 * 回复语言（2026-10-12 用户裁决：正文跟随用户当前使用的语言）。单独成段、由 runtime
 * 拼在系统提示词**最末**：离对话最近的指令权重最高；放在进度说明段里时，前面整篇
 * 提示词与工作区 AGENTS.md 的中文会把模型往中文带（实测英文提问仍回中文）。
 */
export const REPLY_LANGUAGE_GUIDELINE =
  "Reply language: write all user-visible text, progress notes and final answers alike, in the language of the user's latest message, " +
  "even if these instructions, project files or earlier messages are in another language. Switch only if the user asks you to.";

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
