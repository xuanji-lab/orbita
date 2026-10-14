/**
 * 轮后蒸馏（memory v1）——把这一轮对话蒸成 0–5 条原子记忆条目。**纯模块**，
 * 不 import electron / pi 运行时，可被 `node --test` 直接加载。
 *
 * 表征即杠杆（atommem 的原子事实 ≡ mandol 的 God Mode 改写，两家实测共同指向）：
 * 入库的不是对话原文，而是自包含、第三人称、时间绝对的陈述句——召回是词法的
 * （main/memory/retrieve.ts），条目质量就是召回质量的全部来源。
 *
 * 失败纪律同标题生成（title.ts）：蒸馏是易耗品，解析失败 / 模型出错都返回空、
 * 静默跳过，没有任何报错通路打到对话上。
 *
 * **只蒸正常结束的轮**（completedTurnAssistantText）：被打断（无论有没有半截
 * 回答）或以报错收场的轮不蒸——半截与张冠李戴的条目比没有更糟。
 */
import type { MemoryDraft } from "../shared/memory.ts";

/** 一轮最多蒸出的条目数。蒸馏是摘录不是转写——超过这个数说明这轮该拆会话。 */
const ENTRY_LIMIT = 5;
/** 契约的关键词上限（shared/memory.ts），落盘侧同样会截，这里先截干净。 */
const KEYWORD_LIMIT = 8;
/** 喂给蒸馏模型的输入上限：用户文本取头部、助手文本取尾部（结论往往在尾巴上）。 */
const USER_TEXT_CHARS = 4000;
const ASSISTANT_TEXT_CHARS = 8000;

export const DISTILL_SYSTEM_PROMPT = `你是记忆蒸馏器。把一轮用户与 agent 的对话蒸馏成 0–5 条原子记忆条目，供以后的会话检索参照。

每条必须：
- 自包含：不读原对话也能看懂；消解所有指代（它 / 那个 / 上面说的 → 具体名字）；
- 第三人称：称「用户」与「agent」，不用「我 / 你」；
- 时间绝对：「今天 / 明天 / 上周」按给出的当前日期换算成 YYYY-MM-DD；
- 只记将来有用的：用户的偏好与决定、项目事实、达成的结论、踩过的坑与解法；
  寒暄、客套、过程性闲聊不记；
- 不记关于本轮对话机制本身的元讨论（比如对记忆系统、蒸馏、工具行为的议论）——
  那是过程的噪音，不是用户世界的事实；
- 每条附 ≤8 个检索关键词（术语优先，中英文都可）。

只输出 JSON 数组，除此之外不要有任何输出：
[{"text": "……", "keywords": ["……"]}]
没有值得记的内容时输出 []。`;

/** 组装蒸馏调用的用户消息。`now` 用于把相对时间锚成绝对日期。 */
export function buildDistillPrompt(input: { userText: string; assistantText: string; now: number }): string {
  const date = formatDate(input.now);
  const user = input.userText.slice(0, USER_TEXT_CHARS);
  const assistant =
    input.assistantText.length <= ASSISTANT_TEXT_CHARS
      ? input.assistantText
      : `……（中段略）${input.assistantText.slice(-ASSISTANT_TEXT_CHARS)}`;
  return `<date>${date}</date>\n<user>\n${user}\n</user>\n<assistant>\n${assistant}\n</assistant>`;
}

/**
 * 模型输出 → 蒸馏草稿。容错顺序：剥 markdown 围栏 → 取首个 `[` 到末个 `]` →
 * JSON.parse → 逐条校验。**任何一步失败都返回空数组**——坏输出蒸馏不出东西，
 * 静默跳过，下轮自然有新内容。
 */
export function parseDistillReply(raw: string, timestamp: number): MemoryDraft[] {
  const fenced = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const drafts: MemoryDraft[] = [];
  for (const item of parsed) {
    if (drafts.length >= ENTRY_LIMIT) break;
    if (typeof item !== "object" || item === null) continue;
    const suspect = item as { text?: unknown; keywords?: unknown };
    if (typeof suspect.text !== "string" || suspect.text.trim() === "") continue;
    const keywords = Array.isArray(suspect.keywords)
      ? suspect.keywords.filter((k): k is string => typeof k === "string" && k.trim() !== "").slice(0, KEYWORD_LIMIT)
      : [];
    drafts.push({ text: suspect.text.trim(), keywords, timestamp });
  }
  return drafts;
}

/**
 * 判「本轮是否正常结束」要看的消息形状（结构收窄，不认 pi 的具体类型，
 * 只看 role / content / stopReason 形状）——本模块保持纯。
 */
export interface TurnMessage {
  role: string;
  content?: unknown;
  stopReason?: string;
}

/** 拼一条 assistant 消息里全部 text 块（think / toolCall 块不算回答文本） */
function assistantTextOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const suspect = block as { type?: unknown; text?: unknown };
      if (suspect.type === "text" && typeof suspect.text === "string") parts.push(suspect.text);
    }
  }
  return parts.join("\n");
}

/**
 * 本轮的最终回答文本——**只在「本轮正常结束」时非 null**，两个条件缺一不蒸：
 *
 * 1. 只认 `messages[baseline..]`（prompt 前消息数之后新增的）：「还没开始回答
 *    就被打断」时本轮没有新增 assistant，这里返回 null，绝不回落到上一轮的
 *    回答——否则上一轮的回答拼上本轮的提问，蒸出来的是张冠李戴的条目；
 * 2. 新增段里最后一条 assistant 的 stopReason 不是 aborted / error：半截回答
 *    与报错轮的空回答都不是「这轮聊清楚了」的形状，蒸了只有噪音。
 *
 * 返回空串（纯工具轮，没有文本）是合法的「正常但无事可蒸」，由调用方跳过。
 */
export function completedTurnAssistantText(
  messages: readonly TurnMessage[],
  /** prompt 前 session.messages 的长度 */
  baseline: number,
): string | null {
  for (let i = messages.length - 1; i >= baseline; i -= 1) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant") continue;
    if (message.stopReason === "aborted" || message.stopReason === "error") return null;
    return assistantTextOf(message.content);
  }
  return null;
}

/** YYYY-MM-DD（本地时区）——注入块与蒸馏 prompt 共用的日期格式。 */
export function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
