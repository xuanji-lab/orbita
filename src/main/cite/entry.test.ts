/**
 * BibTeX 排版与 key 的回归网。
 *
 * 这一层的错都不会当场报：一个没转义的 `%` 会把字段后半截注释掉，一个重名的 key
 * 会让 `\cite` 指向两条中的某一条——都要到编译（甚至到投稿）才发现。所以规则
 * 写死在这里，每一条都有实例。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CiteCandidate } from "../../shared/cite.ts";
import { appendBibEntry, bibAuthors, bibKeyBase, escapeBib, formatBibEntry, uniqueBibKey } from "./entry.ts";

function candidate(patch: Partial<CiteCandidate> = {}): CiteCandidate {
  return {
    source: "crossref",
    title: "Attention Is All You Need",
    authors: [
      { given: "Ashish", family: "Vaswani" },
      { given: "Noam", family: "Shazeer" },
    ],
    year: "2017",
    venue: "Advances in Neural Information Processing Systems",
    doi: "10.5555/3295222.3295349",
    arxivId: null,
    type: "inproceedings",
    volume: "30",
    pages: "5998-6008",
    primaryClass: null,
    ...patch,
  };
}

describe("escapeBib —— 字段值里的语法字符", () => {
  test("& % _ # $ 逐个转义", () => {
    assert.equal(escapeBib("A & B: 100% of _x_ #1 $5"), "A \\& B: 100\\% of \\_x\\_ \\#1 \\$5");
  });

  test("已经转义过的不再叠一层", () => {
    assert.equal(escapeBib("50\\% done"), "50\\% done");
  });

  test("上标 / 非断行空格也转义（O(n^2) 原样进 .bib 会 Missing $）", () => {
    assert.equal(escapeBib("O(n^2) and 50~Hz"), "O(n\\textasciicircum{}2) and 50\\textasciitilde{}Hz");
  });

  test("落单的花括号转义，配对的原样留着（大小写保护 / 重音写法）", () => {
    assert.equal(escapeBib("a}b"), "a\\}b");
    assert.equal(escapeBib("{GPU story"), "\\{GPU story");
    assert.equal(escapeBib("The {GPU} story"), "The {GPU} story");
    assert.equal(escapeBib("a {b} c"), "a {b} c");
  });

  test("HTML 实体与标签先还原再转义（Crossref 会给标记）", () => {
    assert.equal(escapeBib("Fast &amp; Slow: <i>a</i> study"), "Fast \\& Slow: a study");
  });

  test("空白折叠：接口给的标题里会有换行", () => {
    assert.equal(escapeBib("Two\n  lines"), "Two lines");
  });
});

describe("bibAuthors —— 姓在前、and 分隔", () => {
  test("按结构化 given / family 拼，不从显示串里猜姓", () => {
    assert.equal(
      bibAuthors([
        { given: "Ashish", family: "Vaswani" },
        { given: "Noam", family: "Shazeer" },
      ]),
      "Vaswani, Ashish and Shazeer, Noam",
    );
  });

  test("复姓不被拍平（评审 F7：García Márquez, Gabriel 曾变成 Márquez, Gabriel García）", () => {
    assert.equal(bibAuthors([{ given: "Gabriel", family: "García Márquez" }]), "García Márquez, Gabriel");
  });

  test("机构作者只有一边时就用那一边", () => {
    assert.equal(bibAuthors([{ given: "OpenAI", family: "" }]), "OpenAI");
    assert.equal(bibAuthors([{ given: "", family: "Google Brain" }]), "Google Brain");
  });

  test("名字里的特殊字符照样转义", () => {
    assert.equal(bibAuthors([{ given: "C", family: "A&B" }]), "A\\&B, C");
  });
});

describe("bibKeyBase —— 第一作者姓 + 年 + 标题第一个实词", () => {
  test("标准情形", () => {
    assert.equal(bibKeyBase(candidate()), "vaswani2017attention");
  });

  test("跳过冠词与介词：The 不算标题的第一个实词", () => {
    assert.equal(bibKeyBase(candidate({ title: "The Theory of Everything" })), "vaswani2017theory");
  });

  test("重音去掉、复姓连写（García Márquez → garciamarquez），姓取 family", () => {
    assert.equal(
      bibKeyBase(candidate({ authors: [{ given: "José", family: "García Márquez" }], title: "On Things" })),
      "garciamarquez2017things",
    );
  });

  test("只有整名（arXiv）时末尾一词当姓", () => {
    assert.equal(
      bibKeyBase(candidate({ authors: [{ given: "Gabriel García Márquez", family: "" }], title: "On Things" })),
      "marquez2017things",
    );
  });

  test("缺作者 / 缺年份：用 anon 与 nd，不丢 key", () => {
    assert.equal(bibKeyBase(candidate({ authors: [], year: null })), "anonndattention");
  });

  test("标题全是虚词时退到第一个词", () => {
    assert.equal(bibKeyBase(candidate({ title: "The Of And" })), "vaswani2017the");
  });

  test("中文标题没有 ASCII 词：key 仍然可用（不会变成空串或带非 ASCII）", () => {
    assert.equal(bibKeyBase(candidate({ title: "论注意力机制" })), "vaswani2017");
  });
});

describe("uniqueBibKey —— 重名加 a / b", () => {
  test("不重名就是 base", () => {
    assert.equal(uniqueBibKey("vaswani2017attention", ["other2020x"]), "vaswani2017attention");
  });

  test("重名依次 a / b", () => {
    assert.equal(uniqueBibKey("vaswani2017attention", ["vaswani2017attention"]), "vaswani2017attentiona");
    assert.equal(
      uniqueBibKey("vaswani2017attention", ["vaswani2017attention", "vaswani2017attentiona"]),
      "vaswani2017attentionb",
    );
  });

  test("大小写不同也算重名（引用时不会有人靠大小写区分）", () => {
    assert.equal(uniqueBibKey("vaswani2017attention", ["Vaswani2017Attention"]), "vaswani2017attentiona");
  });
});

describe("formatBibEntry —— 三种条目类型的字段", () => {
  test("inproceedings：booktitle / volume / pages / doi；页码区间用两个连字符", () => {
    assert.equal(
      formatBibEntry(candidate(), "vaswani2017attention"),
      [
        "@inproceedings{vaswani2017attention,",
        "  title = {Attention Is All You Need},",
        "  author = {Vaswani, Ashish and Shazeer, Noam},",
        "  year = {2017},",
        "  booktitle = {Advances in Neural Information Processing Systems},",
        "  volume = {30},",
        "  pages = {5998--6008},",
        "  doi = {10.5555/3295222.3295349},",
        "}",
      ].join("\n"),
    );
  });

  test("article：journal", () => {
    const text = formatBibEntry(candidate({ type: "article", venue: "Nature" }), "key1");
    assert.match(text, /^@article\{key1,/);
    assert.match(text, /\n {2}journal = \{Nature\},/);
    assert.doesNotMatch(text, /booktitle/);
  });

  test("arXiv 的 @misc：eprint / archivePrefix / primaryClass", () => {
    const text = formatBibEntry(
      candidate({
        source: "arxiv",
        type: "misc",
        venue: "arXiv",
        arxivId: "1706.03762",
        primaryClass: "cs.CL",
        volume: null,
        pages: null,
        doi: "10.48550/arXiv.1706.03762",
      }),
      "vaswani2017attention",
    );
    assert.match(text, /^@misc\{vaswani2017attention,/);
    assert.match(text, /\n {2}eprint = \{1706\.03762\},/);
    assert.match(text, /\n {2}archivePrefix = \{arXiv\},/);
    assert.match(text, /\n {2}primaryClass = \{cs\.CL\},/);
    // @misc 不该带 journal / booktitle
    assert.doesNotMatch(text, /journal|booktitle/);
  });

  test("没有的字段不写（不是空 {}）", () => {
    const text = formatBibEntry(
      candidate({ venue: null, doi: null, volume: null, pages: null, authors: [] }),
      "key2",
    );
    assert.doesNotMatch(text, /author|journal|booktitle|doi|volume|pages/);
  });
});

describe("appendBibEntry —— 追加而不是覆盖", () => {
  test("空文件：不留前导空行", () => {
    assert.equal(appendBibEntry("", "@misc{a,\n}"), "@misc{a,\n}\n");
    assert.equal(appendBibEntry("\n  \n", "@misc{a,\n}"), "@misc{a,\n}\n");
  });

  test("已有条目：空一行再接，原有内容原样留着", () => {
    assert.equal(
      appendBibEntry("@misc{a,\n}\n", "@misc{b,\n}"),
      "@misc{a,\n}\n\n@misc{b,\n}\n",
    );
  });

  test("CRLF 的 .bib 保持 CRLF（Windows 上常见）", () => {
    assert.equal(
      appendBibEntry("@misc{a,\r\n}\r\n", "@misc{b,\n}"),
      "@misc{a,\r\n}\r\n\r\n@misc{b,\r\n}\r\n",
    );
  });
});
