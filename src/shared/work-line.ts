/**
 * 每件在跑的活一句话（2026-11-16 用户验收后台状态位：「显示的是 bash 命令和网址」，看不懂）。
 * 主会话自己、每条子会话都用它；子会话面板第二行是第一个消费者，输入框旁的后台状态位（#488）、语音线回答
 * 「做到哪了」以后读的是同一句。
 *
 * 来源顺序（路线图「计划要在一轮之内往前走」一节）：
 *   1. 它刚说的那句话（最近一条回答的最后一段的第一句）
 *   2. 计划里在做的那一步（在等的步带上在等谁）
 *   3. 书记员写的（接口留着，这次没有来源）
 *   4. 「正在跑命令」「正在读文件」这类不带参数的说法
 * 每一级先过 sanitizeWorkLine：**永远不露出命令、网址、路径、英文代号**——一句里有任何这类东西就整句作废、往下取，不拼补。
 *
 * 「没动静」：同时满足「N 分钟没有新动作」和「正在跑的命令也没有新输出」才算——两者都会让会话收到 progress 事件
 * （新的条目 / 工具输出更新），所以按「最后一次收到 progress 的时间」算一个数就够；长命令持续有输出不算。
 *
 * 纯模块：不 import React，node --test 直接测。
 */
import type { TranscriptItem } from "./transcript.ts";
import type { PlanItem } from "./plan.ts";

/** 不带参数的动作说法的种类（工具名映射过来，界面文案在 messages） */
export type WorkActivity = "command" | "read" | "edit" | "web" | "delegate" | "think" | "work";

export type WorkLineSource = "said" | "plan" | "clerk" | "activity";

export interface WorkLine {
  text: string;
  source: WorkLineSource;
}

export interface WorkLineWords {
  activity: Record<WorkActivity, string>;
  /** 在等的那步：步骤 + 在等谁 */
  waiting: (step: string, waitingFor: string) => string;
}

/** 一句话最多多少字（行里放得下一句；超出截断加省略号） */
export const WORK_LINE_MAX = 40;
/** 「没动静」的阈值：5 分钟没有任何 progress（新动作或命令新输出） */
export const QUIET_AFTER_MS = 5 * 60_000;

const URL = /\b(?:https?|ftp|file):\/\/\S+|\bwww\.\S+/gi;
const FENCE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`?/g;
/** 带路径分隔符的片段（/a/b、~/x、./x、C:\x、src/foo.ts、a\b）：整个非空白片段去掉 */
const PATHISH = /(?:^|(?<=[\s(（「"'“]))[^\s()（）「」"'“”，。；：！？,;]*[/\\][^\s()（）「」"'“”，。；：！？,;]*/g;
/**
 * 英文代号：字母数字混写（e6、M0、B-1、v1.2）、带 - _ . 连接的标识（feat-main、kernel_e6、index.ts）、驼峰（runTurn）、
 * 命令行开关（--force、-rf）、#编号、十六进制提交号（3da955ce）。普通英文单词（English 界面的正文）不动。
 */
const CODENAME =
  /(?<![\p{L}\p{N}])(?:--?[A-Za-z][\w-]*|#\d+|[A-Za-z]+\d[\w.-]*|\d+[A-Za-z][\w.-]*|[A-Za-z][\w]*(?:[-_.][\w]+)+|[a-z]+[A-Z][A-Za-z\d]*|(?=[0-9a-f]*\d)[0-9a-f]{7,40})(?![\p{L}\p{N}])/gu;
/** 一句话至少剩多少字才算数；计划步骤本来就是短标题（动词 + 对象），门槛低 */
const SENTENCE_MINIMUM = { han: 5, letters: 8 };
const TITLE_MINIMUM = { han: 2, letters: 3 };
const SHELL_LINE = /&&|\|\||\s\|\s|^\s*\$\s|(?:^|\s)(?:sudo|rm|cd|git|bun|npm|node|python3?)\s+-/;
const MARKDOWN = /\*\*|__|^#+\s*|^\s*(?:[-*+]|\d+[.)])\s+|^>\s*/gm;

/**
 * 一句话能不能原样用：**只要里面有任何要洗掉的东西**（代码块、反引号内容、网址、带路径分隔符的片段、英文代号、全大写错误码、
 * 中文句子里夹的小写英文词 / 全大写缩写、整句是命令）就整句不用、返回 ""，调用方落到下一级来源。不去拼补——洗掉一截留下的
 * 残句（「我先读一下里的，看投递从哪进来。」）比不显示更糟（主会话 2026-11-17）。
 * 原话干净时：只去掉 markdown 记号、收拢空白（不算改字），超长截断加省略号；剩的字太少（中文不到 5 个、英文不到 8 个字母；
 * 计划步骤这类短标题门槛 2 / 3）同样作废。所以输出要么是原话（去掉 markdown 记号、可能截断），要么是 ""。
 */
export function sanitizeWorkLine(text: string, minimum: { han: number; letters: number } = SENTENCE_MINIMUM): string {
  const out = text.replace(MARKDOWN, "").replace(/\s+/g, " ").trim();
  if (out === "" || hasCodeLike(text) || hasCodeLike(out)) return "";
  const han = out.replace(/[^\p{Script=Han}]/gu, "").length;
  const letters = out.replace(/[^\p{L}]/gu, "").length;
  if (han > 0 ? han < minimum.han : letters < minimum.letters) return "";
  return out.length > WORK_LINE_MAX ? `${out.slice(0, WORK_LINE_MAX - 1).trimEnd()}…` : out;
}

/** 有没有要洗掉的东西（search 不受 /g 的 lastIndex 影响） */
function hasCodeLike(text: string): boolean {
  if (SHELL_LINE.test(text)) return true;
  for (const pattern of [FENCE, INLINE_CODE, URL, PATHISH, CODENAME]) if (text.search(pattern) !== -1) return true;
  // 全大写的长词（ETIMEDOUT、ENOENT）是错误码一类的代号，哪种语言里都算
  if (/(?<![\p{L}\p{N}])[A-Z]{4,}(?![\p{L}\p{N}])/u.test(text)) return true;
  // 中文句子里夹的英文小写词与全大写缩写（HEAD、worktree、push）几乎都是技术代号；首字母大写的专名（Windows）不算。纯英文句子不看这条
  return /\p{Script=Han}/u.test(text) && /(?<![\p{L}\p{N}])(?:[a-z]+|[A-Z]{2,})(?![\p{L}\p{N}])/u.test(text);
}

/** 一段话里「最后一段的第一句」：刚说的那句话（叙述在动手前说，最后一段最贴近现在） */
export function latestSentence(text: string): string {
  const withoutCode = text.replace(FENCE, " ");
  const paragraphs = withoutCode.split(/\n\s*\n|\n/).map((line) => line.trim()).filter((line) => line !== "");
  const last = paragraphs[paragraphs.length - 1] ?? "";
  const match = /^.*?(?:[。！？]|[.!?](?=\s|$))/u.exec(last);
  return (match?.[0] ?? last).trim();
}

/** 工具名 → 不带参数的动作种类 */
export function activityOfTool(name: string): WorkActivity {
  if (name === "bash" || name.startsWith("terminal_")) return "command";
  if (name === "read" || name === "read_pdf" || name === "read_docx" || name === "read_task") return "read";
  if (name === "edit" || name === "write" || name.startsWith("doc_") || name.startsWith("slides_")) return "edit";
  if (name.startsWith("browser_") || name.includes("search")) return "web";
  if (name === "delegate" || name === "reply_subsession") return "delegate";
  return "work";
}

/** 一条会话的转录 → 选句的原料（最近一条回答的正文、在做的动作） */
export function workFacts(items: readonly TranscriptItem[], running: boolean): { said: string | null; activity: WorkActivity | null } {
  let said: string | null = null;
  let activity: WorkActivity | null = null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item === undefined) continue;
    if (item.role === "user") break;
    if (activity === null && running && item.role === "tool" && item.toolName !== "update_plan") {
      activity = item.status === "running" ? activityOfTool(item.toolName) : "think";
    }
    if (said === null && item.role === "assistant") {
      const text = item.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
      if (text !== "") said = latestSentence(text);
      else if (activity === null && running) activity = "think";
    }
    if (said !== null && activity !== null) break;
  }
  return { said, activity: activity ?? (running ? "work" : null) };
}

/** 计划里在做的那一步（in_progress 优先，其次在等的那步） */
export function currentPlanStep(items: readonly PlanItem[] | null): PlanItem | null {
  if (items === null) return null;
  return items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status === "waiting") ?? null;
}

/** 按来源顺序取第一句洗得出来的；全都没有 = null（调用方用它原来的说法） */
export function workLine(
  input: { said: string | null; planStep: PlanItem | null; clerk: string | null; activity: WorkActivity | null },
  words: WorkLineWords,
): WorkLine | null {
  const said = input.said === null ? "" : sanitizeWorkLine(input.said);
  if (said !== "") return { text: said, source: "said" };
  if (input.planStep !== null) {
    const step = sanitizeWorkLine(input.planStep.text, TITLE_MINIMUM);
    if (step !== "") {
      const who = input.planStep.status === "waiting" && input.planStep.waitingFor !== undefined ? sanitizeWorkLine(input.planStep.waitingFor, TITLE_MINIMUM) : "";
      return { text: who === "" ? step : words.waiting(step, who), source: "plan" };
    }
  }
  const clerk = input.clerk === null ? "" : sanitizeWorkLine(input.clerk);
  if (clerk !== "") return { text: clerk, source: "clerk" };
  if (input.activity !== null) return { text: words.activity[input.activity], source: "activity" };
  return null;
}

/** 没动静：在跑、知道最后一次动静的时间、且已过阈值。不知道（窗口晚于它开起来、还没收到过事件）= 不算 */
export function isQuiet(now: number, running: boolean, lastActivityAt: number | null, thresholdMs = QUIET_AFTER_MS): boolean {
  return running && lastActivityAt !== null && now - lastActivityAt >= thresholdMs;
}
