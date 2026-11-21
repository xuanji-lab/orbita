/**
 * 系统提示词的段装配。抽成纯函数后，测试可以直接比较「派出 / 删除子会话前后」
 * 整份提示词的字节。
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
import { CHAT_ONLY_GUIDELINE, describeChannelRole } from "./channel-tools.ts";
import { hasModule, isChatOnly } from "../shared/capabilities.ts";
import { formatCapabilityCatalog, type CatalogGroup } from "./capability-catalog.ts";
import { storeToolsGuideline } from "./store-tools.ts";
import { gitAttributionGuideline } from "./git-attribution.ts";
import { REPLY_LANGUAGE_GUIDELINE } from "./prompt-narration.ts";
import { MEMORY_TOOLS_GUIDELINE } from "./memory-tools.ts";

/**
 * bash 的 timeout 指引。数字与工具闸门同源（shared 的 `gatedCommandTimeout`）：小于下限的抬到下限，
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
 * 自动化工具是延迟工具（要先 tool_search 才发给模型）：这段规矩仍每轮在提示里，所以不会因为工具没加载就想不起来；括号里明说先加载。
 */
const LONG_TASK_AUTOMATION_GUIDELINE =
  "When a command you are about to run will likely take more than about 10 minutes (a long training run, a large build, a full scan), " +
  "do not wait it out in a foreground bash call. Start it in the background with its output redirected to a log file, " +
  "create a this_session automation (the automation tools are not loaded by default: load them with tool_search first; one-shot around the expected finish time, or a short interval) whose instruction tells you to read that log " +
  "and check whether the job finished (cancel the automation once it has), then end your turn. " +
  "Tell the user in one sentence what is running, where the log is, and that you will come back to it on your own.";

/**
 * 常驻主智能体的身份与规矩（2026-11-17）。只给工作区的主智能体会话（命令带 mainAgent）；别的会话这一段为空、
 * 整份提示词一字不差。写成英文与其它段一致（模型对英文规矩的遵从更稳；回复语言另有 reply-language 段管）。
 *
 * 内容来源：用户定稿的主智能体设计（小事自己做、大事派出去；只告诉用户结果；拿不准说的是哪件就自己判断、
 * 在回复开头点明——能撤回的动作猜了就做、事后点明，撤不回或要花钱的才问一句），
 * 加上论文 DynaFlow 提炼的三条派活规矩（不把没核实的结论当前提塞给子会话；复核不给预期答案；传话给上游原文）。
 */
export const MAIN_AGENT_GUIDELINE = `<orbita-main-agent>
You are the resident main agent of this workspace: the one place where the user talks to Orbita about
anything in it. The conversation with you is long-lived and spans many days; sub-sessions you delegate
are your tools, not separate conversations the user has to follow.
- Small things (one answer, a quick lookup, a small edit) you do yourself. Larger work you split and
  delegate with the delegate tool, then come back to the user; you do not sit and wait on it.
- When you delegate, write the task in the user's own words wherever possible, and say what done looks
  like. Do not pass an unverified conclusion to a sub-session as an established premise: mark it as a
  guess to check. When you ask a sub-session to review or verify something, do not tell it the answer
  you expect and do not stop it from changing things independently. When you pass information on, give
  the upstream output itself (quote or point to the file), not your own retelling of a value.
- Tell the user results, not process: what is done, what it found, where the output is, and what needs
  them. Do not relay a sub-session's step-by-step progress or paste its messages back. Answer a
  sub-session's question yourself when the user's earlier words or the project already answer it; ask
  the user only when they do not.
- When it is unclear which piece of work the user's message is about, decide yourself and name it at the
  start of your reply. If the action is reversible (stopping or pausing work, changing the wording of a
  plan) do it on your best guess and say what you assumed. If it is irreversible or costly (deleting,
  pushing or publishing, rerunning hours of work, spending money) and you are not sure, ask one short
  question first.
- Decide capabilities every time you delegate: leaving it out gives the work everything you have. When the
  user says what a piece of work should or should not get, pass exactly that, and never tell the user it
  lacks something you did not leave out. Pass capabilities so the work carries only what it needs: changing code or files →
  [] (the basics: read, write, edit, bash); looking things up online → ["browser"], plus "pdf-docx" for
  papers and reports; slides or documents → ["docs-slides"]; something that only needs thinking or
  writing an answer, without touching any file → ["none"]. Add skill:<name> or mcp:<server> when the work
  needs one of yours. Leave capabilities out only when you cannot tell what the work will need.
- When a piece of work asks for something it was not given (a question saying it needs, say, the browser):
  if it really needs it, hand the work out again with that capability added (pause the old one); if not,
  reply with reply_subsession that it should do without. Answer it yourself; do not pass it to the user.
- To hold a piece of work you delegated (the user says to stop or wait, or it rests on a misunderstanding),
  use pause_subsession: it keeps everything done so far, and reply_subsession later lets it carry on.
- How you talk to the user: in the first person and in plain words, as the one responsible for the work
  ("I have someone checking the citations", "the citation check is done"). Call a delegated piece of work
  "this piece of work" or by what it is about (in Chinese: 这件活). Do not say sub-session, sub-task,
  delegate or channel; do not quote status codes (running, idle, waiting, done), ids or tool names; do not
  name the model or thinking level a piece of work runs on. Only when the user asks about exactly that.
- When the user asks how things are going, read work_cards (one card per piece of work) and answer in a
  sentence or two in those plain words; do not read the sub-sessions' transcripts for that.
- Earlier sessions in this workspace are still there; read one with read_task when the user wants to
  continue it or asks about it.
</orbita-main-agent>`;

export interface SystemPromptInput {
  /** pi 基底，已由 adaptSystemPrompt 处理 */
  piBase: string;
  /** 受保护的单文件（自动化记录）：受保护数据说明里点名它们 */
  protectedFiles?: readonly string[];
  role: "root" | "child";
  /** 这条会话是工作区的常驻主智能体（命令带 mainAgent 且是根会话）：加 main-agent 一段 */
  mainAgent?: boolean;
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
  /**
   * 这件活的能力集（shared/capabilities.ts，规范化后的）与其中点名了却没有的技能 / MCP。
   * 缺席 = 全带：段与以前逐字节相同。纯聊天只留身份与回复语言两段；别的按模块跳过对应段（store-tools、quote）。
   */
  capabilities?: { list: readonly string[]; missing: readonly string[] };
  /**
   * 能力目录的原料（turn-tools.ts 的 selectTurnTools 选出的非空分组）与这一轮技能索引里真有的技能名。
   * 不给 / 没有分组 = 没有目录这一段（纯聊天在上面已提前返回，本来就不到这里）。
   */
  capabilityCatalog?: { groups: readonly CatalogGroup[]; skills: readonly string[] };
}

export interface PromptSegment {
  name: string;
  text: string;
}

/** 段序就是线上字节序：已有段不重排，避免无意义地打断整份前缀缓存。 */
export function orbitaSystemSegments(input: SystemPromptInput): PromptSegment[] {
  const capabilities = input.capabilities;
  if (capabilities !== undefined && isChatOnly(capabilities.list)) {
    return [
      { name: "chat-only", text: CHAT_ONLY_GUIDELINE },
      { name: "reply-language", text: REPLY_LANGUAGE_GUIDELINE },
    ];
  }
  const list = capabilities?.list;
  return [
    { name: "pi-base", text: input.piBase },
    { name: "permission", text: describeProtectedData(input.protectedFiles) },
    { name: "directories", text: describeDirectories(input.cwd, input.directories) },
    { name: "channel-role", text: describeChannelRole(input.role, capabilities) },
    // 新段只给主智能体；普通会话没有这一段，已有段的字节与顺序不变（不打断前缀缓存）
    ...(input.mainAgent === true ? [{ name: "main-agent", text: MAIN_AGENT_GUIDELINE }] : []),
    ...(input.memoryToolsGuideline ? [{ name: "memory-tools", text: MEMORY_TOOLS_GUIDELINE }] : []),
    // 讲 create_skill / add_mcp_server 的：没带 store 模块就没有这两个工具，这段也不讲
    ...(hasModule(list, "store") ? [{ name: "store-tools", text: storeToolsGuideline(input.workspace, input.cwd) }] : []),
    // 能力目录放在身份 / 通道 / 主智能体 / 记忆 / store 各段之后、通用工具规矩之前：前面各段字节不动；
    // 目录随这一轮的组集与 MCP 服务集变（同一件活相邻两轮不变），只会让它之后的段重新计缓存
    ...(input.capabilityCatalog === undefined
      ? []
      : [{ name: "capability-catalog", text: formatCapabilityCatalog(input.capabilityCatalog.groups, input.capabilityCatalog.skills) }]),
    { name: "tool-guidelines", text: TOOL_GUIDELINES },
    { name: "expected-seconds", text: EXPECTED_SECONDS_GUIDELINE },
    ...(input.longTaskAutomationGuideline ? [{ name: "long-task-automation", text: LONG_TASK_AUTOMATION_GUIDELINE }] : []),
    ...(input.intentGuideline ? [{ name: "intent", text: INTENT_CONTEXT_GUIDELINE }] : []),
    // 引用块讲的是文档面板里选中的段落与 PDF 原文：读文件的两个模块都没带就不讲
    ...(hasModule(list, "pdf-docx") || hasModule(list, "docs-slides") ? [{ name: "quote", text: QUOTE_GUIDELINE }] : []),
    {
      name: "git-attribution",
      text: gitAttributionGuideline(input.gitAttribution, input.attributionLanguage ?? "en"),
    },
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
