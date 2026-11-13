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

  it("C3 重复句、追踪丢了：紧贴着复制出一模一样的一句——不猜，标 ambiguous（划选时第 5 行，现在 5 与 7 两处）", () => {
    const quote = select(base, SENTENCE); // 第 5 行
    // 原句行首紧贴着插入复制句：复制句占了第 5 行，原句被挤到第 7 行。
    // 复制句的前文与划选时的前文一模一样（相似度反而最高），旧的打分正是因此改错了位置
    const edited = base.replace(SENTENCE, `${SENTENCE}\n\n${SENTENCE}`);
    const moved = relocateQuote(edited, quote);
    assert.deepEqual(moved.ambiguous, { was: 5, at: [5, 7] });
    assert.equal(moved.occurrence, undefined);
    const message = composeQuotedMessage([moved], "改成英文");
    assert.match(message, / ambiguous="true" was_line="5" occurs_at_lines="5,7">/);
    assert.deepEqual(parseQuotedMessage(message).quotes[0]?.ambiguous, { was: 5, at: [5, 7] });
    assert.match(QUOTE_GUIDELINE, /ambiguous="true"/);
  });

  it("重复句、周围一个字没动（复制句加在远处）：前后文与划选时完全一致的那一处就是它，带上第几处", () => {
    const long = `# 标题\n\n${"前文铺垫一段话，写得足够长。".repeat(3)}\n\n${SENTENCE}\n\n${"后文收尾一段话，写得足够长。".repeat(3)}\n`;
    const quote = select(long, SENTENCE);
    const edited = `${long}\n${SENTENCE}\n`; // 复制句加在文末，原句前后 20 字都没动
    const moved = relocateQuote(edited, quote);
    assert.equal(moved.ambiguous, undefined);
    assert.deepEqual(moved.lines, quote.lines);
    assert.deepEqual(moved.occurrence, { index: 1, of: 2 });
    const message = composeQuotedMessage([moved], "改成英文");
    assert.match(message, / occurrence="1\/2">\n<before>[^<]*写得足够长。\n\n<\/before>\n<quoted>重复句：这一句会出现两次。<\/quoted>\n<after>\n\n后文收尾/);
    assert.doesNotMatch(message, /before="|after="|\\n/, "前后文逐字写在块体里，不放属性、不转义");
    assert.equal(parseQuotedMessage(message).quotes[0]?.text, SENTENCE, "芯片显示的引用正文只取 <quoted> 里的");
    assert.match(QUOTE_GUIDELINE, /occurrence="k\/n"/);
    // 只有一处：不带这些
    const unique = composeQuotedMessage([relocateQuote(long, select(long, SENTENCE))], "x");
    assert.doesNotMatch(unique, /occurrence|before=|ambiguous/);
  });

  it("没有上下文可比（旧引用）且出现多次：同样不猜", () => {
    const text = `${SENTENCE}\n${SENTENCE}\n${SENTENCE}\n`;
    const quote = { ...select(text, SENTENCE, 1), context: undefined };
    assert.deepEqual(relocateQuote(text, quote).ambiguous, { was: 2, at: [1, 2, 3] });
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

  it("追踪的区间还在、里面的字已经变了（x-editquoted）：不走「只出现一次就认」——文件里剩的那一处只是另一处恰好相同", () => {
    // 紧贴着复制了一句，再把被引用的原句（现在在第 7 行）改了几个字：文件里原文只剩复制句那一处
    const dup = base.replace(SENTENCE, `${SENTENCE}\n\n${SENTENCE}`);
    const from = dup.lastIndexOf(SENTENCE);
    const edited = `${dup.slice(0, from)}${SENTENCE.replace("这一句", "这句话")}${dup.slice(from + SENTENCE.length)}`;
    const [resolved] = resolveDocQuotes(edited, "/ws/a.md", () => ({ from, to: from + SENTENCE.replace("这一句", "这句话").length }), [quote]);
    assert.equal(resolved?.missing, true);
    assert.equal(resolved?.occurrence, undefined);
    assert.match(composeQuotedMessage([resolved as TextQuote], "改成英文"), / missing="true">/);
  });

  it("追踪的区间还在、原句被整句删掉（x-delorig）：文件里只剩复制句，同样标 missing，不认它", () => {
    const dup = base.replace(SENTENCE, `${SENTENCE}\n\n${SENTENCE}`);
    const from = dup.lastIndexOf(SENTENCE);
    const deleted = `${dup.slice(0, from)}${dup.slice(from + SENTENCE.length)}`; // 区间塌成一个点
    const [resolved] = resolveDocQuotes(deleted, "/ws/a.md", () => ({ from, to: from }), [quote]);
    assert.equal(resolved?.missing, true);
  });

  it("没有追踪区间（追踪丢了）：才走「周围没动」的兜底，原文仍唯一就找到它，否则 missing", () => {
    const other = resolveDocQuotes(base, "/ws/a.md", () => null, [quote]);
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
