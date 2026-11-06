import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeQuotedMessage, parseQuotedMessage, QUOTE_GUIDELINE, type TextQuote } from "./quote.ts";
import { contextAround, relocateQuote, resolveDocQuotes } from "./quote-anchor.ts";

const SENTENCE = "重复句：这一句会出现两次。";

function select(text: string, needle: string, nth = 0): TextQuote {
  let at = -1;
  for (let i = 0; i <= nth; i += 1) at = text.indexOf(needle, at + 1);
  const line = text.slice(0, at).split("\n").length;
  return {
    text: needle,
    messageId: "",
    role: "user",
    filePath: "/ws/a.md",
    lines: { from: line, to: line },
    context: contextAround(text, at, at + needle.length),
  };
}

describe("relocateQuote —— 以原文为锚（M3）", () => {
  const base = `# 标题\n\n第一段。\n\n${SENTENCE}\n\n结尾一段。\n`;

  it("原文唯一：用它现在的行号（上方多了几行）", () => {
    const quote = select(base, "结尾一段。");
    const edited = `新增一行\n新增二行\n\n${base}`;
    assert.deepEqual(relocateQuote(edited, quote).lines, { from: 10, to: 10 });
  });

  it("C3 重复句：在上方复制出一模一样的句子——靠上下文仍指到被引用的那一处，不被旧行号带偏", () => {
    const quote = select(base, SENTENCE); // 第 5 行
    const edited = base.replace("# 标题\n\n", `# 标题\n\n${SENTENCE}\n\n`); // 复制出来的在第 3 行，原句挤到第 7 行
    assert.equal(edited.split("\n")[2], SENTENCE);
    assert.equal(edited.split("\n")[6], SENTENCE);
    const moved = relocateQuote(edited, quote);
    assert.deepEqual(moved.lines, { from: 7, to: 7 });
    assert.equal(moved.missing, undefined);
  });

  it("同一段原文出现多次：带上「第几处 / 共几处」与这一处前后的字，进正文（模型数行号不可靠）", () => {
    const edited = base.replace("# 标题\n\n", `# 标题\n\n${SENTENCE}\n\n`);
    const moved = relocateQuote(edited, select(base, SENTENCE));
    assert.deepEqual(moved.occurrence, { index: 2, of: 2 });
    const message = composeQuotedMessage([moved], "改成英文");
    assert.match(message, / occurrence="2\/2" before="[^"]*第一段。\\n\\n" after="\\n\\n结尾一段。\\n">/);
    assert.match(QUOTE_GUIDELINE, /occurrence="k\/n"/);
    // 只有一处：不带这些
    const unique = composeQuotedMessage([relocateQuote(base, select(base, SENTENCE))], "x");
    assert.doesNotMatch(unique, /occurrence|before=/);
  });

  it("重复句在下方出现：同样靠上下文，不被旧行号带偏", () => {
    const text = `甲\n\n${SENTENCE}\n\n乙\n\n${SENTENCE}\n\n丙\n`;
    const second = select(text, SENTENCE, 1);
    assert.deepEqual(relocateQuote(`新增\n\n${text}`, second).lines, { from: 9, to: 9 });
  });

  it("上下文也一样：取离原行号最近的那一处", () => {
    const text = `${SENTENCE}\n${SENTENCE}\n${SENTENCE}\n`;
    const quote = { ...select(text, SENTENCE, 1), context: undefined };
    assert.deepEqual(relocateQuote(text, quote).lines, { from: 2, to: 2 });
  });

  it("找不到：标 missing，行号原样留着只当提示", () => {
    const quote = select(base, SENTENCE);
    const moved = relocateQuote(base.replace(SENTENCE, "整句被改写了"), quote);
    assert.equal(moved.missing, true);
    assert.deepEqual(moved.lines, quote.lines);
  });

  it("之前标过 missing、现在又找得到了：清掉标记", () => {
    const quote: TextQuote = { ...select(base, SENTENCE), missing: true };
    assert.equal(relocateQuote(base, quote).missing, undefined);
  });

  it("多行引用：行号范围跟着原文走；末尾换行不多算一行", () => {
    const text = "甲\n\n乙一\n乙二\n\n丙\n";
    const quote = select(text, "乙一\n乙二");
    assert.deepEqual(relocateQuote(`新\n${text}`, quote).lines, { from: 4, to: 5 });
  });

  it("演示文稿：页号也重算（上方插入了一页）", () => {
    const deck = "---\nmarp: true\n---\n\n# 一\n\n---\n\n# 二\n独特的一句\n";
    const quote: TextQuote = { ...select(deck, "独特的一句"), slide: 2 };
    const edited = deck.replace("# 一\n", "# 一\n\n---\n\n# 插入页\n");
    assert.equal(relocateQuote(edited, quote).slide, 3);
  });

  it("不是文件引用 / 空文本：原样", () => {
    const chat: TextQuote = { text: "x", messageId: "m", role: "assistant" };
    assert.equal(relocateQuote("abc", chat), chat);
  });

  it("missing 进正文、解析回来还在；上下文不进正文", () => {
    const quote = { ...select(base, SENTENCE), missing: true as const };
    const message = composeQuotedMessage([quote], "改成英文");
    assert.match(message, / missing="true">/);
    assert.doesNotMatch(message, /context|before|after/);
    assert.equal(parseQuotedMessage(message).quotes[0]?.missing, true);
  });

  it("系统提示词：以原文为准、行号只是提示、找不到就说明没改", () => {
    assert.match(QUOTE_GUIDELINE, /authoritative/);
    assert.match(QUOTE_GUIDELINE, /locator hint/);
    assert.match(QUOTE_GUIDELINE, /missing="true"/);
  });
});

describe("resolveDocQuotes —— 追踪区间优先，退回上下文", () => {
  const base = `# 标题\n\n第一段。\n\n${SENTENCE}\n\n结尾一段。\n`;
  const quote = { ...select(base, SENTENCE), anchor: "q1" };

  it("追踪到的区间准：紧贴着复制出一句也不会选错（上下文分不出的情形）", () => {
    // 原句行首插入复制句：原句现在在第 7 行，复制句在第 5 行
    const edited = base.replace(SENTENCE, `${SENTENCE}\n\n${SENTENCE}`);
    const from = edited.lastIndexOf(SENTENCE);
    const [resolved] = resolveDocQuotes(edited, "/ws/a.md", () => ({ from, to: from + SENTENCE.length }), [quote]);
    assert.deepEqual(resolved?.lines, { from: 7, to: 7 });
  });

  it("追踪的区间里字被改过：退回上下文定位（原文仍在别处就找到它，否则 missing）", () => {
    const other = resolveDocQuotes(base, "/ws/a.md", () => ({ from: 0, to: 3 }), [quote]);
    assert.deepEqual(other[0]?.lines, { from: 5, to: 5 });
    const gone = resolveDocQuotes(base.replace(SENTENCE, "没了"), "/ws/a.md", () => null, [quote]);
    assert.equal(gone[0]?.missing, true);
  });

  it("别的文件的引用、聊天引用不动", () => {
    const foreign: TextQuote = { ...quote, filePath: "/ws/b.md" };
    const chat: TextQuote = { text: "x", messageId: "m", role: "user" };
    assert.deepEqual(resolveDocQuotes("zzz", "/ws/a.md", () => null, [foreign, chat]), [foreign, chat]);
  });
});
