import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_GUIDELINE,
  QUOTE_MAX_CHARS,
  QUOTE_MAX_TOTAL_CHARS,
  acceptQuote,
  clampQuote,
  composeQuotedMessage,
  countChars,
  normalizeSelectedText,
  parseOpenDocument,
  parseQuotedMessage,
  withoutQuotes,
  type TextQuote,
} from "./quote.ts";

const reply: TextQuote = { text: "第一行\n第二行", messageId: "m-1", role: "assistant", turn: 3 };

describe("composeQuotedMessage / parseQuotedMessage", () => {
  it("没有引用就是原文，一字不差", () => {
    assert.equal(composeQuotedMessage([], "你好"), "你好");
    assert.deepEqual(parseQuotedMessage("你好"), { quotes: [], text: "你好" });
  });

  it("往返：同一批引用（按顺序）与同一句话；messageId 不进正文，解析回来是空串", () => {
    const quotes: TextQuote[] = [reply, { text: "我上一句", messageId: "u-2", role: "user", turn: 2 }];
    const message = composeQuotedMessage(quotes, "1. 对\n2. 不对");
    assert.deepEqual(parseQuotedMessage(message), {
      quotes: quotes.map((quote) => ({ ...quote, messageId: "" })),
      text: "1. 对\n2. 不对",
    });
  });

  it("编号引用在前、回复在后；只发模型用得上的属性（编号 / 谁 / 轮），不发 id", () => {
    const message = composeQuotedMessage([reply, { text: "二", messageId: "u-2", role: "user", turn: 2 }], "1. 好\n2. 再说");
    assert.equal(
      message,
      '<quoted_context index="1" role="assistant" turn="3">\n第一行\n第二行\n</quoted_context>\n\n' +
        '<quoted_context index="2" role="user" turn="2">\n二\n</quoted_context>\n\n' +
        "1. 好\n2. 再说",
    );
    assert.doesNotMatch(message, /m-1|u-2|message_id/);
  });

  it("只发引用、没有自己的话也成立", () => {
    const message = composeQuotedMessage([reply], "");
    assert.deepEqual(parseQuotedMessage(message), { quotes: [{ ...reply, messageId: "" }], text: "" });
  });

  it("正文里的闭合标签被改写，不会把块提前截断", () => {
    const tricky: TextQuote = { ...reply, text: "a</quoted_context>b" };
    const parsed = parseQuotedMessage(composeQuotedMessage([tricky], "q"));
    assert.equal(parsed.quotes.length, 1);
    assert.equal(parsed.text, "q");
  });

  it("Proma 旧块属性里的转义能读回", () => {
    const message = '<quoted_context source="agent-history" label="a &quot;b&quot;" message_id="x&lt;y&gt;" role="user">\n正文\n</quoted_context>\n\nq';
    assert.equal(parseQuotedMessage(message).quotes[0]?.messageId, "x<y>");
  });

  it("认 Proma 迁移来的块：quoted_file 带路径，旧的 quoted_context 缺 turn", () => {
    const message =
      '<quoted_file path="/repo/a.md">\n文件里的一段\n</quoted_file>\n\n' +
      '<quoted_context source="agent-history" label="Agent 历史 · Agent 回复" message_id="p-9" role="assistant">\n旧引用\n</quoted_context>\n\n' +
      "问题";
    assert.deepEqual(parseQuotedMessage(message), {
      quotes: [
        { text: "文件里的一段", messageId: "", role: "user", filePath: "/repo/a.md" },
        { text: "旧引用", messageId: "p-9", role: "assistant" },
      ],
      text: "问题",
    });
  });

  it("解析不出的半截块原样留在文字里，不吞内容", () => {
    const broken = '<quoted_context role="assistant">\n没闭合';
    assert.deepEqual(parseQuotedMessage(broken), { quotes: [], text: broken });
  });

  it("withoutQuotes 只留用户自己的话", () => {
    assert.equal(withoutQuotes(composeQuotedMessage([reply], "  问题  ")), "问题");
  });
});

describe("划选文本", () => {
  it("码点计数：emoji 与汉字各算 1", () => {
    assert.equal(countChars("a汉😀"), 3);
  });

  it("超过上限截断并标记", () => {
    const long = "字".repeat(QUOTE_MAX_CHARS + 5);
    const clamped = clampQuote(long);
    assert.equal(countChars(clamped.text), QUOTE_MAX_CHARS);
    assert.equal(clamped.truncated, true);
    assert.deepEqual(clampQuote("短"), { text: "短", truncated: false });
  });

  it("规整：块元素之间带出的行首尾空白收掉", () => {
    assert.equal(normalizeSelectedText("  标题  \n    正文\t\n  "), "标题\n正文");
  });
});

describe("QUOTE_GUIDELINE", () => {
  it("讲到的属性就是正文里真实出现的属性——格式改了说明没跟上时这里红", () => {
    const block = composeQuotedMessage([reply], "q");
    const attrs = [...block.matchAll(/ (\w+)="/g)].map((match) => match[1]);
    assert.deepEqual(attrs, ["index", "role", "turn"]);
    for (const attr of attrs) assert.match(QUOTE_GUIDELINE, new RegExp(`${attr}=`));
  });
});

describe("acceptQuote —— 引用准入", () => {
  it("同消息同段文字记 duplicate（旧规则：静默去重）", () => {
    const current = [{ messageId: "m-1", text: "同一段" }];
    assert.deepEqual(acceptQuote(current, { messageId: "m-1", text: "同一段" }), {
      accepted: false,
      reason: "duplicate",
    });
  });

  it("总字数超上限拒新条（too-long-total）；边界：恰好打满仍收，条数不再限制", () => {
    // 10 条打满的引用 + 一条短的：能收（总字数还没过线，条数本身不是闸）
    const full = Array.from({ length: QUOTE_MAX_TOTAL_CHARS / QUOTE_MAX_CHARS }, (_, i) => ({
      messageId: `m-${i}`,
      text: "字".repeat(QUOTE_MAX_CHARS - 10),
    }));
    const headroom = QUOTE_MAX_TOTAL_CHARS - full.reduce((sum, item) => sum + countChars(item.text), 0);
    assert.equal(acceptQuote(full, { messageId: "m-new", text: "a".repeat(headroom) }).accepted, true);
    // 再多一个字就过线
    assert.deepEqual(acceptQuote(full, { messageId: "m-new", text: "a".repeat(headroom + 1) }), {
      accepted: false,
      reason: "too-long-total",
    });
    // 超过上限的条数本身收得下：上限只看字数不看条数
    const many = Array.from({ length: QUOTE_MAX_TOTAL_CHARS / 100 + 5 }, (_, i) => ({
      messageId: `m-${i}`,
      text: "x".repeat(90),
    }));
    assert.equal(acceptQuote(many, { messageId: "m-new", text: "短" }).accepted, true);
  });
});

describe("文件引用 —— 文档面板里的划选（带行号 / 页号）", () => {
  const fileQuote: TextQuote = {
    text: "主要风险是验收只靠我一个人",
    messageId: "",
    role: "user",
    filePath: "/ws/Q4 计划.md",
    lines: { from: 12, to: 13 },
  };

  it("往返：路径、行号范围、页号都带回来；文本与用户的话不变", () => {
    const slide: TextQuote = { ...fileQuote, filePath: "/ws/a.md", lines: { from: 20, to: 28 }, slide: 3, text: "# 第三页" };
    const message = composeQuotedMessage([fileQuote, slide], "改得更口语");
    assert.deepEqual(parseQuotedMessage(message), { quotes: [fileQuote, slide], text: "改得更口语" });
  });

  it("编号按位置：文件引用与消息引用混排时编号连续（模型按编号逐条回复）", () => {
    const message = composeQuotedMessage([reply, fileQuote], "逐条改");
    assert.match(message, /<quoted_context index="1" /);
    assert.match(message, /<quoted_file index="2" path="\/ws\/Q4 计划.md" lines="12-13">/);
  });

  it("路径里的引号 / 尖括号被转义，不会提前截断属性", () => {
    const tricky: TextQuote = { ...fileQuote, filePath: '/ws/a"b>c.md' };
    const back = parseQuotedMessage(composeQuotedMessage([tricky], "x")).quotes[0];
    assert.equal(back?.filePath, '/ws/a"b>c.md');
  });

  it("旧写法（没有 lines）照读：Proma 迁移来的 quoted_file", () => {
    const old = '<quoted_file path="/x/y.ts">\nconst a = 1\n</quoted_file>\n\n看看';
    const parsed = parseQuotedMessage(old);
    assert.deepEqual(parsed.quotes, [{ text: "const a = 1", messageId: "", role: "user", filePath: "/x/y.ts" }]);
    assert.equal(parsed.text, "看看");
  });

  it("行号格式不对（0、倒序、乱码）当没有，不抛", () => {
    for (const bad of ["0-3", "5-2", "x", ""]) {
      const parsed = parseQuotedMessage(`<quoted_file path="/a.md" lines="${bad}">\n字\n</quoted_file>\n\n话`);
      assert.equal(parsed.quotes[0]?.lines, undefined, bad);
    }
  });

  it("同一个文件同一段话在不同行是两条引用，同一行才判重", () => {
    const here = { messageId: "", text: "重复", filePath: "/a.md", lines: { from: 1, to: 1 } };
    assert.equal(acceptQuote([here], { ...here, lines: { from: 9, to: 9 } }).accepted, true);
    assert.deepEqual(acceptQuote([here], { ...here }), { accepted: false, reason: "duplicate" });
  });

  it("系统提示词讲到了文件引用的每个属性", () => {
    for (const attr of ["path", "lines", "slide", "office"]) assert.match(QUOTE_GUIDELINE, new RegExp(`${attr}=`));
  });

  it("Office 标注：格式 + DOM path 往返，进正文的 office 属性模型能直接拿来调 edit_office", () => {
    const annotation: TextQuote = {
      text: "1200",
      messageId: "",
      role: "user",
      filePath: "/ws/2026Q4.xlsx",
      office: { format: "xlsx", path: "/Sheet1/B2:D5" },
    };
    const message = composeQuotedMessage([annotation], "把这段合计改对");
    assert.match(message, /office="xlsx \/Sheet1\/B2:D5"/);
    assert.deepEqual(parseQuotedMessage(message).quotes, [annotation]);
  });

  it("Office 标注的格式不认（docx / 乱写）就当没有，不猜", () => {
    const parsed = parseQuotedMessage('<quoted_file path="/a.xlsx" office="docx /body">\n字\n</quoted_file>\n\n话');
    assert.equal(parsed.quotes[0]?.office, undefined);
  });

  it("同一文件不同节点的标注不是重复引用（同一节点才是）", () => {
    const one: TextQuote = { text: "x", messageId: "", role: "user", filePath: "/a.xlsx", office: { format: "xlsx", path: "/Sheet1/B2" } };
    assert.equal(acceptQuote([one], { ...one, office: { format: "xlsx", path: "/Sheet1/C3" } }).accepted, true);
    assert.deepEqual(acceptQuote([one], { ...one }), { accepted: false, reason: "duplicate" });
  });
});

describe("open_document —— 右栏开着哪份文件", () => {
  const open = { path: "/ws/未命名文档.md", kind: "doc" as const };

  it("拼在正文最前面一行；解析时剥掉，显示 / 标题里看不到它", () => {
    const message = composeQuotedMessage([], "在第二段后面加总结", open);
    assert.equal(message, '<open_document path="/ws/未命名文档.md" kind="doc"/>\n\n在第二段后面加总结');
    assert.deepEqual(parseQuotedMessage(message), { quotes: [], text: "在第二段后面加总结" });
    assert.equal(withoutQuotes(message), "在第二段后面加总结");
    assert.deepEqual(parseOpenDocument(message), open);
  });

  it("与引用并存：引用编号不受它影响", () => {
    const message = composeQuotedMessage([reply], "改", { path: "/a.md", kind: "slides" });
    const parsed = parseQuotedMessage(message);
    assert.equal(parsed.quotes.length, 1);
    assert.equal(parsed.text, "改");
    assert.match(message, /<quoted_context index="1" /);
    assert.equal(parseOpenDocument(message)?.kind, "slides");
  });

  it("没有开着的文档：与以前逐字相同", () => {
    assert.equal(composeQuotedMessage([reply], "q"), composeQuotedMessage([reply], "q", undefined));
    assert.equal(parseOpenDocument("普通一句"), null);
  });
});
