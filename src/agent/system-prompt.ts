/**
 * 系统提示词的段装配。抽成纯函数后，测试可以直接比较「派出 / 删除子会话前后」
 * 整份提示词的字节；prompt-stability 也吃同一份段名单，变化能归因到具体段。
 *
 * attached、受保护数据说明、cwd、本会话工作台与浏览器下载目录仍按原行为留在这里；
 * 父子会话清单不进系统提示词，对方工作台由 delegate 回执和通道信封告知。
 */
import type { TurnDirectories } from "../shared/agent-ipc.ts";
import { COMMAND_TIMEOUT_DEFAULT_SECONDS, COMMAND_TIMEOUT_FLOOR_SECONDS } from "../shared/permission.ts";
import { QUOTE_GUIDELINE } from "../shared/quote.ts";
import type { Language } from "../shared/settings.ts";
import { INTENT_CONTEXT_GUIDELINE } from "../shared/intent-recall.ts";
import { describeProtectedData } from "./permission.ts";
import { describeDirectories } from "./directories-prompt.ts";
import { describeChannelRole } from "./channel-tools.ts";
import { storeToolsGuideline } from "./store-tools.ts";
import { gitAttributionGuideline } from "./git-attribution.ts";
import { REPLY_LANGUAGE_GUIDELINE } from "./prompt-narration.ts";
import { MEMORY_TOOLS_GUIDELINE } from "./memory-tools.ts";
import { describeSubAgentIdentity, SUB_AGENTS_MAIN_GUIDELINE } from "./sub-agent-tools.ts";
import type { SubAgentTurnIdentity } from "../shared/sub-agent.ts";
import { computerUseBudgetGuideline, computerUseNetworkGuideline } from "./computer-network.ts";
import { computerUseToolsActive } from "../shared/computer-use-platform.ts";
import type { ComputerUseTurnContext } from "../shared/agent-ipc.ts";

/**
 * bash 的 timeout 指引。数字与权限闸门同源（shared 的 `gatedCommandTimeout`）：小于下限的抬到下限，
 * 不填的补默认上限。后半句要讲：模型不知道有这条上限，就会把真要跑一小时以上的命令（长训练、
 * 大构建）也不带 timeout 发出去，到点被杀。
 */
const TOOL_GUIDELINES =
  "For commands that may take a while (installing dependencies, builds, tests), do not pass a short timeout to bash/powershell: " +
  `these are slow on Windows and a short timeout kills a normal slow command halfway; values under ${COMMAND_TIMEOUT_FLOOR_SECONDS} seconds are raised to ${COMMAND_TIMEOUT_FLOOR_SECONDS}. ` +
  `A command without a timeout is stopped after ${COMMAND_TIMEOUT_DEFAULT_SECONDS} seconds; pass a larger timeout only when a command really needs to run longer than that.`;

const EXPECTED_SECONDS_GUIDELINE =
  "When calling bash/powershell with a command you expect to run longer than 10 seconds (tests, builds, installs, sleep, " +
  "scanning large directories), you may add expected_seconds (a number of seconds, your estimate) to the arguments. " +
  "It only drives the UI (progress hint and auto-expand) and does not affect execution or timeouts.";

/**
 * 自动化工具（automation_create）已注册时的长任务指引：用户 2026-11-05 裁决——这类建议要写进系统提示词，
 * 不能只靠工具 description（模型想不起来就不会去读）。没注册自动化时不讲（讲了模型也做不了，只会干等）。
 */
const LONG_TASK_AUTOMATION_GUIDELINE =
  "When a command you are about to run will likely take more than about 10 minutes (a long training run, a large build, a full scan), " +
  "do not wait it out in a foreground bash call. Start it in the background with its output redirected to a log file, " +
  "create a this_session automation (one-shot around the expected finish time, or a short interval) whose instruction tells you to read that log " +
  "and check whether the job finished (cancel the automation once it has), then end your turn. " +
  "Tell the user in one sentence what is running, where the log is, and that you will come back to it on your own.";

/**
 * 回答里的图（2026-11-26 用户：「内嵌交互图可以做一下。提示词优化一下」）。Orbita 的回答把 ```mermaid 画成静态图、
 * 把 ```html-embed 画成沙箱里的交互图（renderer/features/chat/HtmlEmbedBlock.tsx）；模型不知道就一张也不画
 * ——改前实测 Kimi / GLM 讲数据流、走算法、做对比 8 道题 0 张图。这一段讲三件事：什么时候画（讲流程 / 架构 /
 * 逐步演示 / 结构性对比）、mermaid 够用就用 mermaid、闲聊与表格能说清的不画；以及 html-embed 的写法约束，
 * 每一条都对着沙箱的真实限制：不能联网（CSP default-src 'none'）、颜色走宿主下发的主题变量（深浅主题切换跟着变）、
 * 宽度随对话列高度随内容（上限 720）、不放常驻动画（离开视口会被暂停，常驻动画只会白耗 GPU）、体积有上限。
 * 写法里的「片段不写整页 / style→内容→script 最后 / 文字写在回答里、图里只放图 / 逐步演示用 stepper」学自
 * Claude 内联可视化的设计规范。
 */
const INLINE_VISUALS_GUIDELINE = [
  "<orbita-inline-visuals>",
  "Your answers render as Markdown, and two kinds of fenced blocks render as pictures instead of code:",
  "- ```mermaid: a static diagram (flowchart, sequence, state, class, ER, gantt, pie).",
  "- ```html-embed: an interactive figure, a small HTML/SVG/JS fragment run in a sandbox inside the answer, as wide as the " +
    "conversation column, its height fitted to its content (at most 720px).",
  "Draw one on your own, without being asked, when a picture explains better than prose: a process, data flow or " +
    "architecture where order and connections matter; an algorithm, protocol or lifecycle walked through step by step; " +
    "two things whose difference is in how they flow or are built (draw them side by side). When the explanation has " +
    "stages, prefer an html-embed stepper: the whole diagram stays visible (every stage as a box, arrows between them), " +
    "Previous / Next buttons and a position marker such as 2 / 5 move a highlight from stage to stage, and one short " +
    "caption under the diagram says what happens in the current stage; not a slideshow of text cards. When a single " +
    "static picture of boxes and arrows is enough, use mermaid. Do not draw for small talk, plain facts, short answers or " +
    "lists, or when a table says it (a list of attributes side by side is a table). One figure per answer is the norm, two at " +
    "most. The explanation stays in your prose; the figure holds only the visual (labels and one short caption per step).",
  "Writing html-embed:",
  "- A fragment, not a page: no <!doctype>, <html>, <head> or <body>. A short <style>, then the markup, then one <script> " +
    "at the end. Under 30 KB.",
  "- Self-contained: the sandbox blocks all network and file access, so no external scripts, stylesheets, fonts, images " +
    "or fetch. Inline SVG and data: URIs only.",
  "- Colours come only from the host theme variables, never hard-coded, so light and dark themes both work: " +
    "--color-text-primary / -secondary / -tertiary, --color-bg-muted (fills), --color-border-subtle / -default / -strong, " +
    "--color-accent (only for the current or highlighted element), --color-info, --color-success, --color-warning, " +
    "--color-danger; fonts --font-family-base and --font-family-mono; sizes --font-size-base / -sm / -xs; " +
    "radius --radius-md. The host paints the ground behind the figure (--color-bg-panel); leave your outermost element unpainted. Plain <button> " +
    "elements are already styled.",
  "- Size follows the container, which is 480 to 900px wide: width 100%, rows that wrap (flex-wrap) rather than shrink, " +
    "SVG with a viewBox and width=\"100%\", no fixed pixel widths, no 100vh, no position: fixed; keep it under about 600px tall.",
  "- No continuous animation (no infinite CSS animation, requestAnimationFrame loop or setInterval); a short transition " +
    "when the step changes is fine. No emoji. Text inside the figure is in the user's language.",
  "</orbita-inline-visuals>",
].join("\n");

export interface SystemPromptInput {
  /** pi 基底，已由 adaptSystemPrompt 处理 */
  piBase: string;
  role: "root" | "child";
  workspace: { name?: string } | null;
  cwd: string;
  directories: TurnDirectories | undefined;
  gitAttribution: boolean;
  attributionLanguage: Language | undefined;
  intentGuideline: boolean;
  /** 本会话注册了记忆工具（根会话且记忆开着）：讲一段固定的使用说明 */
  memoryToolsGuideline: boolean;
  /** 本会话注册了 automation_create（根会话且自动化开着）：讲长任务放后台、建自动化回来看的指引 */
  longTaskAutomationGuideline: boolean;
  /** 本会话注册了子智能体工具（编排形态的主智能体）：讲一段「有子智能体可派、怎么建」；缺席 = 不讲 */
  subAgentsGuideline?: boolean;
  /** 这条会话替哪个子智能体干活（指名派活）：它的职能整段进提示；缺席 = 普通会话 */
  subAgent?: SubAgentTurnIdentity;
  /**
   * 电脑使用的现场（settings.experimentalFeatures["computer-use"] + 平台支持 + 出网两个事实）。
   * **只在工具组真注册时讲**（computerUseToolsActive：开着且是 Windows）：否则沙箱工具
   * 根本没注册，讲它等于给模型一句假话。三种其余情形：出网开着 → 空串（零噪音）；
   * 关着且后端做得到 → 「你没有出网」；关着但后端断不了（L2b）→ 「这个后端断不了网」。
   * 后两者都由 computerUseNetworkGuideline 分叉，段会被下面滤掉空串。
   */
  computerUse?: ComputerUseTurnContext;
}

export interface PromptSegment {
  name: string;
  text: string;
}

/** 段序就是线上字节序：已有段不重排，避免无意义地打断整份前缀缓存。 */
export function orbitaSystemSegments(input: SystemPromptInput): PromptSegment[] {
  // 「这次沙箱不能上网」逐轮重讲：改设置下一轮即生效；出网开着时是空串（下面滤掉）
  const computerUseNetwork = computerUseNetworkGuideline(input.computerUse);
  return [
    { name: "pi-base", text: input.piBase },
    { name: "permission", text: describeProtectedData() },
    { name: "directories", text: describeDirectories(input.cwd, input.directories) },
    { name: "channel-role", text: describeChannelRole(input.role) },
    // 子智能体两段只在用到时出现：普通会话的整份提示逐字节不变（不打断已有会话的前缀缓存）
    ...(input.subAgent === undefined ? [] : [{ name: "sub-agent", text: describeSubAgentIdentity(input.subAgent) }]),
    ...(input.subAgentsGuideline === true ? [{ name: "sub-agents", text: SUB_AGENTS_MAIN_GUIDELINE }] : []),
    ...(input.memoryToolsGuideline ? [{ name: "memory-tools", text: MEMORY_TOOLS_GUIDELINE }] : []),
    { name: "store-tools", text: storeToolsGuideline(input.workspace, input.cwd) },
    { name: "tool-guidelines", text: TOOL_GUIDELINES },
    { name: "expected-seconds", text: EXPECTED_SECONDS_GUIDELINE },
    ...(input.longTaskAutomationGuideline ? [{ name: "long-task-automation", text: LONG_TASK_AUTOMATION_GUIDELINE }] : []),
    ...(input.intentGuideline ? [{ name: "intent", text: INTENT_CONTEXT_GUIDELINE }] : []),
    { name: "quote", text: QUOTE_GUIDELINE },
    ...(computerUseNetwork !== "" ? [{ name: "computer-use-network", text: computerUseNetwork }] : []),
    // 「每轮动作预算」只在工具组真注册时讲（预算随工具组注册才存在，非 Windows 上工具也不注册）；
    // 数字与闸门同源（shared/computer-guard.ts）
    ...(computerUseToolsActive(input.computerUse) ? [{ name: "computer-use-budget", text: computerUseBudgetGuideline() }] : []),
    {
      name: "git-attribution",
      text: gitAttributionGuideline(input.gitAttribution, input.attributionLanguage ?? "en"),
    },
    // 插在 reply-language 之前（那段锁在最末）：前面已有段的字节不动，前缀缓存只从这里断开
    { name: "inline-visuals", text: INLINE_VISUALS_GUIDELINE },
    { name: "reply-language", text: REPLY_LANGUAGE_GUIDELINE },
  ];
}

/** 空段滤掉，其余用空行相连，与 runtime 原来的内联拼接一致。 */
export function joinSystemPrompt(segments: readonly PromptSegment[]): string {
  return segments
    .map((segment) => segment.text)
    .filter((text) => text !== "")
    .join("\n\n");
}
