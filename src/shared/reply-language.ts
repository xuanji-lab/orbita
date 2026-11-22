/**
 * 回复语言锚点：从「用户亲手打的字」算出用户在用哪种语言，随每条用户消息附给模型。
 *
 * 为什么要纯代码算：回复语言规则（agent/prompt-narration.ts 的 REPLY_LANGUAGE_GUIDELINE）
 * 只在系统提示词里写一次，而长会话里紧挨着回复的是大量英文（子会话汇报、工具输出、
 * 通道信封说明），离得近的压过离得远的，模型会漂成英文；子会话一侧更糟——它收到的每条
 * 消息都是通道信封，规则又把信封排除在「用户的字」之外，于是一个「用户的字」都没有。
 * 所以由代码算出语言，附在每条消息旁边（agent/user-context.ts 的 wire 层），子会话
 * 的语言由父会话那边算好、写进通道消息的 `lang`（见 channel.ts）。
 *
 * 只识别 zh / en：这是本产品当前的两种使用语言。含日文假名或韩文的文字返回 null——
 * 宁可不附，也不把日语用户钉成英语（规则段在没有标记时回到「跟随用户的字」）。
 *
 * 纯模块：不 import 任何东西（channel.ts 要用它的类型，不能反向依赖），可被 `node --test` 直接加载。
 * 从整条消息里取「用户亲手打的字」那一步在 agent/reply-language.ts。
 */
export type ReplyLang = "zh" | "en";

export function isReplyLang(value: unknown): value is ReplyLang {
  return value === "zh" || value === "en";
}

const HAN = /\p{Script=Han}/gu;
const KANA_OR_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LATIN_WORD = /[A-Za-z]{2,}/g;

/**
 * 识别一段「用户亲手打的字」的语言（入参已经剥过 Orbita 的包装，见 userTypedLang）。
 *
 * 判据：先抹掉不属于自然语言的东西（代码块、行内代码、URL / 路径、`/skill:x` 点名记号），
 * 再数汉字个数与拉丁单词数（≥2 个字母的连续串）——一个汉字约等于一个英文单词的信息量，
 * 所以直接比个数：**汉字数 ≥ 拉丁单词数 → zh，否则 en**。混排例：
 * 「帮我 review 一下这个 PR」汉字 7 > 单词 2 → zh；「Check why 子会话 is English」汉字 3 < 单词 4 → en。
 * 一个汉字都没有且没有拉丁单词（纯数字、符号、emoji、单字母）→ null；含假名 / 韩文 → null。
 */
export function detectReplyLang(text: string): ReplyLang | null {
  if (KANA_OR_HANGUL.test(text)) return null;
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/(^|\s)\/(?:skill|mcp|plugin):\S+/g, " ")
    // 含斜杠的记号：URL、文件路径、a/b——拉丁字母多半不是在「说英语」
    .replace(/\S*[/\\]\S*/g, " ");
  const han = prose.match(HAN)?.length ?? 0;
  const words = prose.match(LATIN_WORD)?.length ?? 0;
  if (han === 0 && words === 0) return null;
  return han >= words ? "zh" : "en";
}

/** 给模型看的一行：标记 + 一句英文说明（模型读得懂，措辞固定——前缀缓存要逐字节稳定） */
export function replyLanguageNote(lang: ReplyLang): string {
  const name = lang === "zh" ? "Chinese" : "English";
  return `<reply_language lang="${lang}">Write all user-visible text in ${name} (the language the user writes in).</reply_language>`;
}
