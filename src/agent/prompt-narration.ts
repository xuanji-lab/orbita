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
 * 进度说明段（2026-10-12 起；2026-11-22 改写）。**用英文写**：段落语言会把模型往那门语言带，
 * 回复语言另由 REPLY_LANGUAGE_GUIDELINE 管。prompt-narration.test.ts 锚定全文。
 *
 * 2026-11-22 改写的缘由（用户讨论「最后一公里 · 文档与演示文稿」）：
 * - 界面变了：一轮只分「过程」和「产物」两处。中途写的话会收进那一行过程里，当这一段的名字；
 *   用户看得到的是结尾回答、回答里的图、回答下面的产物卡。
 * - 用户：「我真的不会去看这么多解释，而且工具调用夹在解释里面，显得工具调用非常的不重要一样」——
 *   过程走「效率模式」：中途只写一行段名，不写段落；结论、要用户知道的决定放结尾。
 *   旧版「每组工具调用前说一句要做什么」产出的是「我先读一下使用说明」这类流水账。
 * - 用户：图片「没有跟文字放在一起」——给用户看的图写进结尾回答，图下面紧跟它那段解释。
 * - 用户：「要是你每次写了啥，我能直接点开就好了」——文稿、演示文稿、导出的文件自动列在回答下面，
 *   回答里不再贴长路径。
 * 不做 Proma 那样的会话级「效率 / 解释」开关：旁白约占输出 token 的 1%，关掉它省不了什么；
 * 要改的是旁白写什么。
 */
export const PROGRESS_NARRATION_GUIDELINE =
  "Your tool calls, thinking and mid-turn text are folded into one collapsed line in the UI; the user reliably sees only your final answer and the outputs listed under it.\n" +
  "When you start a new stage of work, write one short line naming it (a few words, no paragraph), e.g. \"Checking how the cards are grouped\"; it becomes that stage's title in the folded process. " +
  "Do not announce routine steps such as reading a file or a skill, and do not paste your thinking.\n" +
  "Put conclusions, decisions the user should know about, and anything they must act on in the final answer.\n" +
  "Decks, documents and exported files you made in this turn are listed as clickable cards under your answer: refer to them by name, do not paste their full paths.\n" +
  "To show the user a picture, embed it in your final answer where you discuss it: ![short caption](</absolute/path/to/image.png>) on its own line, followed by the paragraph that explains it. " +
  "The file must be inside the workspace, an attached directory or the session workbench — save screenshots and figures you make into the session workbench's shots/ folder, never /tmp, or the user sees a broken image.\n";

/**
 * 回复语言（2026-10-12 用户裁决：正文跟随用户当前使用的语言）。单独成段、由 runtime
 * 拼在系统提示词**最末**：离对话最近的指令权重最高；放在进度说明段里时，前面整篇
 * 提示词与工作区 AGENTS.md 的中文会把模型往中文带（实测英文提问仍回中文）。
 *
 * 2026-11-05：判据从「最新一条消息的语言」改成「用户自己写的字」。用户手打半句中文、
 * 正文在附件里时，消息整体被 Orbita 自动加的英文包装（点名 skill 的说明、附件清单说明）
 * 压倒，模型判成英文、整轮英文回。包装块的列表要与实际组装处保持一致（测试锚定）：
 * invocation.ts / prompt-attachments.ts / user-context.ts / memory-inject.ts / task-ref.ts / channel.ts / quote.ts。
 *
 * 2026-11-22：规则只写在这里一次不够——长会话里紧挨回复的是大量英文，离得近的压过离得远的；
 * 子会话收到的全是信封，没有「用户亲手打的字」，规则又把信封排除在外，默认就写英文。
 * 所以代码按「用户亲手打的字」算出语言，每条用户消息末尾附一行 `<reply_language>`
 * （user-context.ts 的 wire 层；子会话的语言由父会话写进信封 lang，见 shared/reply-language.ts），
 * 本段声明它优先，并把它加进「不算用户的字」的包装清单。信封正文在子会话一侧**不**算用户的字
 * （二选一，选标记）：正文是父模型写的，父模型自己漂成英文时子会话不该跟着漂，
 * 而 lang 是代码从用户的字算出来的，两条规则不打架。
 */
export const REPLY_LANGUAGE_GUIDELINE =
  "Reply language: write all user-visible text, progress notes and final answers alike, in the language the user themselves writes in, " +
  "even if these instructions, project files or earlier messages are in another language. Switch only if the user asks you to.\n" +
  "Each user message may end with a <reply_language lang=\"zh|en\"> marker. Orbita computes it from what the user typed (in a sub-session, " +
  "from the user's language that your parent session carried in the channel messages), so it takes priority: write in that language, " +
  "including every report_to_parent text and every task you hand to a sub-session. It also holds when the recent context is full of " +
  "English (reports, tool output, channel boilerplate). Without a marker, use the rules below.\n" +
  "What counts as the user's own writing: the words they typed in their latest message, plus the prose of text they attached or pasted " +
  "(a <pasted-text> block, or a text file listed in <attached-files> once you have read it). " +
  "When the typed words are short or mixed-language and point at an attachment, follow the language of that attachment's prose.\n" +
  "What does not count: blocks that Orbita adds around the message on its own — <mentioned_tools>, <attached-files> (the listing and its " +
  "instruction line, not the files' contents), <user_context>, <reply_language>, <orbita-memory>, <referenced_task>, and <channel> envelopes — " +
  "and the excerpts inside <quoted_context> (they quote earlier turns, possibly the assistant's own). These are mostly English boilerplate; " +
  "never let their language, or how much of the message they take up, decide the reply language. The text of a <channel> envelope is " +
  "not the user's writing even when it comes from your parent session: only the marker carries the user's language there.\n" +
  "When the latest message has no words the user typed and no marker (a turn opened by a <channel> report from a sub-session, an automation " +
  "wake-up, or anything else Orbita sends on its own), keep the language of the user's most recent message that they did type; " +
  "a sub-session's report or your own task text being in another language does not change it.";

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
