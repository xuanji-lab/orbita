/**
 * 通话里「它说」的文字怎么来（纯函数，node --test 直接加载）：
 *   1. 从对话里找到这次语音发出去的那条用户消息（锚点），把它之后 agent 写出的正文按顺序拼起来；
 *   2. 正文在流式长大：每次只看还没念过的那截，按句切出完整的句子先送去合成（降低等待）；
 *   3. 念之前去掉 Markdown 记号、代码块与链接地址——念出来的是话，不是符号。
 */

/** 对话里一条记录的最小形状（与 pi 的 TranscriptItem 兼容，只取这里用到的字段） */
export interface SpokenItem {
  role: string;
  content: readonly { type: string; text?: string }[];
}

/** 一条记录里的正文（只取 text 块；思考、工具调用不念） */
function textOf(item: SpokenItem): string {
  return item.content
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

/**
 * 锚点：从后往前找正文等于 asked 的那条用户消息。找不到回 -1（回显还没到）。
 * 用正文比而不是记下标：对话是尾窗，翻页会让下标漂。
 */
export function findAskedIndex(items: readonly SpokenItem[], asked: string): number {
  const target = asked.trim();
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && item.role === "user" && textOf(item).trim() === target) return index;
  }
  return -1;
}

/** 锚点之后 agent 写出的全部正文，按出现顺序；两条记录之间用换行隔开（换行本身就是句界） */
export function answerTextAfter(items: readonly SpokenItem[], anchor: number): string {
  if (anchor < 0) return "";
  const parts: string[] = [];
  for (const item of items.slice(anchor + 1)) {
    if (item.role !== "assistant") continue;
    const text = textOf(item);
    if (text.trim() !== "") parts.push(text);
  }
  return parts.join("\n");
}

/** 句末：中文句号问号叹号分号、英文的 .!?;（后面跟空白或到头）、换行 */
const SENTENCE_END = /[。！？；…]+["”’」』）)]*|[.!?;]+["”’)]*(?=\s|$)|\n+/g;

/** 太短的句子并到下一句一起念：一个字一段，合成开销与停顿都不划算 */
export const MIN_SPOKEN_CHARS = 6;

/**
 * 从「还没念过的那截」里切出完整的句子。done = 回答已经出完：剩下不成句的尾巴也一起交出去。
 * consumed = 这次切走了多少字（调用方把读到的位置往后挪这么多）。
 */
export function takeSentences(pending: string, done: boolean): { sentences: string[]; consumed: number } {
  const sentences: string[] = [];
  let consumed = 0;
  let start = 0;
  let buffer = "";
  for (const match of pending.matchAll(SENTENCE_END)) {
    const end = (match.index ?? 0) + match[0].length;
    buffer += pending.slice(start, end);
    start = end;
    if (buffer.trim().length >= MIN_SPOKEN_CHARS) {
      sentences.push(buffer.trim());
      consumed = end;
      buffer = "";
    }
  }
  if (done) {
    const rest = pending.slice(consumed).trim();
    if (rest !== "") sentences.push(rest);
    consumed = pending.length;
  }
  return { sentences, consumed };
}

/**
 * 念之前清掉的东西：围起来的代码块整段不念（念代码没人听得懂）、链接只念文字、裸网址不念、
 * 标题 / 列表 / 引用 / 强调 / 表格的记号去掉。清完是空的就不念。
 */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|\*|_)(?=\S)([^*_~]+?)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/^\s*[-:]{3,}\s*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 念的底稿：围起来的代码块换成一个换行（句界）；还没合上的代码块从开头起整段先不看——
 * 否则流式里代码一行一行地被当成句子念出来。底稿的前缀随正文增长保持不变，读取位置才对得上。
 */
export function proseOf(fullText: string): string {
  const closed = fullText.replace(/```[\s\S]*?```/g, "\n");
  const open = closed.indexOf("```");
  return open === -1 ? closed : closed.slice(0, open);
}

/**
 * 跟着回答长大的读取位置：每次给最新的完整正文，回新切出来要念的句子（已清理、非空）。
 * 正文被改写得比读过的还短（极少：重试换了一版回答）时从头重读。
 */
export class AnswerReader {
  private read = 0;

  next(fullText: string, done: boolean): string[] {
    const prose = proseOf(fullText);
    if (prose.length < this.read) this.read = 0;
    const { sentences, consumed } = takeSentences(prose.slice(this.read), done);
    this.read += consumed;
    return sentences.map(speakable).filter((sentence) => sentence !== "");
  }
}
