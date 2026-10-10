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
 * 本轮助手的最终文本：从消息列表尾部找最后一条 assistant，拼接它的 text 块。
 * 结构性收窄（不认 pi 的具体类型，只看 role/content 形状）——本模块保持纯。
 * 没有 assistant 消息或它没有文本（纯工具轮）返回空串，调用方跳过蒸馏。
 */
export function lastAssistantText(messages: readonly { role: string; content?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message === undefined || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const parts: string[] = [];
    for (const block of message.content) {
      if (typeof block === "object" && block !== null) {
        const suspect = block as { type?: unknown; text?: unknown };
        if (suspect.type === "text" && typeof suspect.text === "string") parts.push(suspect.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** YYYY-MM-DD（本地时区）——注入块与蒸馏 prompt 共用的日期格式。 */
export function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
