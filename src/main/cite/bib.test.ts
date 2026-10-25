/**
 * BibTeX 解析器的回归网 —— 夹具用的都是**真实论文里会出现的写法**：
 * 花括号嵌套、跨行字段、`#` 拼接、`@string` 宏、括号条目、以及一条坏条目。
 *
 * 这里测「补全与去重需要的事实」：key / type / title / author / year，以及 DOI 与
 * eprint（写 .bib 前判断「这篇是不是已经在库里」要用）；坏条目有没有被跳过并计数，
 * 以及一个坏条目不能吃掉后面的好条目。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanText, mergeBibEntries, parseBibtex } from "./bib.ts";

describe("parseBibtex —— 基本字段", () => {
  test("article：key / 类型 / 标题 / 作者 / 年份", () => {
    const source = `
@article{vaswani2017,
  author  = {Vaswani, Ashish and Shazeer, Noam},
  title   = {Attention Is All You Need},
  journal = {NeurIPS},
  year    = {2017},
  doi     = {10.5555/3295222.3295349},
}
`;
    const { entries, bad } = parseBibtex(source);
    assert.equal(bad, 0);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0], {
      key: "vaswani2017",
      type: "article",
      title: "Attention Is All You Need",
      author: "Vaswani, Ashish and Shazeer, Noam",
      year: "2017",
      doi: "10.5555/3295222.3295349",
      eprint: null,
      file: "",
    });
  });

  test("doi 与 eprint 也解析出来（去重要用），没有时是 null", () => {
    const parsed = parseBibtex("@misc{a, eprint = {1706.03762}, archivePrefix = {arXiv}}");
    assert.equal(parsed.entries[0]?.eprint, "1706.03762");
    assert.equal(parsed.entries[0]?.doi, null);
  });

  test("花括号嵌套：大小写保护的大括号从显示文本里去掉", () => {
    const parsed = parseBibtex("@book{gpu2020, title = {The {GPU} Story of {E}verything}, year = {2020}}");
    assert.equal(parsed.entries[0]?.title, "The GPU Story of Everything");
  });

  test("跨行字段值：换行折叠成一个空格", () => {
    const parsed = parseBibtex(`@inproceedings{long2008,
      title = {A Very Long Title
               Split Across Lines},
      author = {Long, A.},
      year = 2008,
    }`);
    assert.equal(parsed.entries[0]?.title, "A Very Long Title Split Across Lines");
    // 裸数字也是合法字段值（不带花括号）
    assert.equal(parsed.entries[0]?.year, "2008");
  });

  test("`#` 拼接：引号串 + 花括号串 + 宏", () => {
    const source = `
@string{conf = "Proceedings of NeurIPS"}
@article{joined,
  title = "Part " # {Two} # " of " # conf,
  year = 2021,
}`;
    const { entries } = parseBibtex(source);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.title, "Part Two of Proceedings of NeurIPS");
  });

  test("中文标题（XeLaTeX 论文的常态）原样保留", () => {
    const parsed = parseBibtex("@book{zhang2020, title = {深度学习中的注意力机制}, author = {张三 and 李四}, year = {2020}}");
    assert.equal(parsed.entries[0]?.title, "深度学习中的注意力机制");
    assert.equal(parsed.entries[0]?.author, "张三 and 李四");
  });

  test("没有 year 时取 biblatex 的 date 前四位", () => {
    const parsed = parseBibtex("@online{x, title = {T}, date = {2019-04-02}}");
    assert.equal(parsed.entries[0]?.year, "2019");
  });

  test("括号包起来的条目（老 BibTeX 写法）", () => {
    const parsed = parseBibtex("@misc(paren2001, title = {Paren Entry}, year = {2001})");
    assert.equal(parsed.entries[0]?.key, "paren2001");
    assert.equal(parsed.entries[0]?.title, "Paren Entry");
  });
});

describe("parseBibtex —— 跳过的东西", () => {
  test("@comment / @preamble / @string 不产生条目，也不炸", () => {
    const source = `
@comment{这是整段注释，里面有 @article{fake, title={假}} 也不该被当成条目}
@comment 行尾注释可以不带括号
@preamble{ "\\newcommand{\\noopsort}[1]{}" }
@string{acm = "ACM Press"}
@book{real, title = {Real}, year = {2000}}
`;
    const { entries, bad } = parseBibtex(source);
    assert.equal(bad, 0);
    assert.deepEqual(entries.map((entry) => entry.key), ["real"]);
  });

  test("条目外的散落文字被忽略", () => {
    const parsed = parseBibtex("% 我的文献库\n随便写点什么\n@book{a, title={A}, year={2001}} trailing text");
    assert.deepEqual(parsed.entries.map((entry) => entry.key), ["a"]);
  });
});

describe("parseBibtex —— 坏条目", () => {
  test("缺 key / 缺等号 / 括号不闭合：各记一条，后面的条目照常解析", () => {
    const source = `
@article{, title = {No Key}, year = {2000}}
@article{broken1, title {No Equals}, year = {2001}}
@article{broken2, title = {Unclosed, year = {2002}}
@book{good, title = {Still Here}, year = {2003}}
`;
    const { entries, bad } = parseBibtex(source);
    // 坏条目 3 条（缺 key、缺 =、不闭合），好条目一条不少
    assert.equal(bad, 3);
    assert.deepEqual(entries.map((entry) => entry.key), ["good"]);
    assert.equal(entries[0]?.title, "Still Here");
  });

  test("一条坏条目不会让后面的整份文件消失", () => {
    const { entries, bad } = parseBibtex("@article{bad, author = \n@book{after, title = {After}, year = {2000}}");
    assert.equal(bad, 1);
    assert.deepEqual(entries.map((entry) => entry.key), ["after"]);
  });

  test("空文件 / 只有注释：0 条 0 坏", () => {
    assert.deepEqual(parseBibtex(""), { entries: [], bad: 0 });
    assert.deepEqual(parseBibtex("   \n\n  "), { entries: [], bad: 0 });
  });

  test("没有字段的条目算一条（没有可显示的内容，但 key 是真的）", () => {
    const parsed = parseBibtex("@misc{stub}");
    assert.equal(parsed.bad, 0);
    assert.deepEqual(parsed.entries[0], {
      key: "stub",
      type: "misc",
      title: null,
      author: null,
      year: null,
      doi: null,
      eprint: null,
      file: "",
    });
  });
});

describe("mergeBibEntries —— 多文件合并", () => {
  const entry = (key: string, title: string, year = "2000") => ({
    key,
    type: "article",
    title,
    author: null,
    year,
    doi: null,
    eprint: null,
    file: "",
  });

  test("同 key 先出现者为准，并标注它来自哪份文件", () => {
    const merged = mergeBibEntries([
      { path: "refs/a.bib", entries: [entry("dup", "From A"), entry("a-only", "A")] },
      { path: "refs/b.bib", entries: [entry("dup", "From B"), entry("b-only", "B")] },
    ]);
    assert.deepEqual(merged.map((item) => item.key), ["a-only", "b-only", "dup"]);
    const dup = merged.find((item) => item.key === "dup");
    assert.equal(dup?.title, "From A");
    assert.equal(dup?.file, "refs/a.bib");
  });

  test("结果按 key 排序（大小写不敏感，同 key 不同大小写时顺序稳定）", () => {
    const merged = mergeBibEntries([
      { path: "x.bib", entries: [entry("zeta", "Z"), entry("Alpha", "A"), entry("alpha", "a"), entry("beta", "B")] },
    ]);
    assert.deepEqual(merged.map((item) => item.key), ["Alpha", "alpha", "beta", "zeta"]);
  });

  test("没有文件时是空库", () => {
    assert.deepEqual(mergeBibEntries([]), []);
  });
});

describe("cleanText", () => {
  test("去掉花括号与 ~，折叠空白", () => {
    assert.equal(cleanText("  {Deep}~Learning\n\n  Rocks  "), "Deep Learning Rocks");
  });
});
