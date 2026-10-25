/**
 * `\cite{` 现场的识别与候选排序（纯逻辑）。CodeMirror 那一层只把这些结论转成
 * `Completion`，不再自己判断。
 *
 * 夹具取自真实论文写法：natbib 的可选参数（`\citep[see][p.~3]{`）、一行多个 key、
 * 注释掉的 `\cite`、以及 biblatex 的 `\textcite`。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { CiteEntry } from "../../../../shared/cite.ts";
import { citeArgumentBefore, citeDetail, citeInfo, citeInsertion, suggestCites } from "./cite-suggest.ts";

const entry = (key: string, patch: Partial<CiteEntry> = {}): CiteEntry => ({
  key,
  type: "article",
  title: null,
  author: null,
  year: null,
  doi: null,
  eprint: null,
  file: "refs.bib",
  ...patch,
});

describe("citeArgumentBefore —— 认不认得出 \\cite 现场", () => {
  test("\\cite{ 刚打完：替换点就在 { 之后，查询词为空", () => {
    assert.deepEqual(citeArgumentBefore("\\cite{"), { from: 6, query: "" });
  });

  test("已经打了几个字母：查询词是那几个字母", () => {
    assert.deepEqual(citeArgumentBefore("See \\cite{vas"), { from: 10, query: "vas" });
  });

  test("逗号之后继续给候选（\\cite{a,b}）", () => {
    assert.deepEqual(citeArgumentBefore("\\cite{vaswani2017, he"), {
      from: "\\cite{vaswani2017, ".length,
      query: "he",
    });
  });

  test("逗号后紧跟空格：替换点跳过空白，不把空格算进查询词", () => {
    assert.deepEqual(citeArgumentBefore("\\cite{a,   "), {
      from: "\\cite{a,   ".length,
      query: "",
    });
  });

  test("natbib 的可选参数（含逗号）不影响识别", () => {
    const text = "\\citep[see, e.g.,][p.~3]{kn";
    assert.deepEqual(citeArgumentBefore(text), { from: text.length - 2, query: "kn" });
  });

  test("星号变体与 biblatex 命令", () => {
    assert.deepEqual(citeArgumentBefore("\\Citet*{doe"), { from: 8, query: "doe" });
    assert.deepEqual(citeArgumentBefore("\\textcite{doe"), { from: 10, query: "doe" });
    assert.deepEqual(citeArgumentBefore("\\nocite{"), { from: 8, query: "" });
  });

  test("评审 F4 补的命令：natbib 大写 / 复数写法与 AASTeX", () => {
    // 每条都只验「认出来 + 替换点对」：名单里的命令不该互相抢（\cite 不能吃掉 \cites）
    for (const command of [
      "Cite",
      "cites",
      "parencites",
      "textcites",
      "citeA",
      "citeN",
      "shortcite",
      "supercite",
      "footcitetext",
    ]) {
      const text = `\\${command}{doe`;
      assert.deepEqual(
        citeArgumentBefore(text),
        { from: text.length - 3, query: "doe" },
        `命令 \\${command} 没被认出来`,
      );
    }
  });

  test("一行一个 key 的长引用：换行后继续给候选", () => {
    const text = "\\cite{a1,\n  b2";
    assert.deepEqual(citeArgumentBefore(text), { from: text.length - 2, query: "b2" });
  });

  test("注释里的 \\cite 不补全；转义的百分号不算注释", () => {
    assert.equal(citeArgumentBefore("% \\cite{doe"), null);
    // "50\% "（5 个字符）+ "\cite{"（6 个）→ 查询词从第 11 格开始
    assert.deepEqual(citeArgumentBefore("50\\% \\cite{doe"), { from: 11, query: "doe" });
  });

  test("不是引用命令 / 已经写了 } / 不在参数里：都不弹", () => {
    assert.equal(citeArgumentBefore("\\citex{doe"), null);
    assert.equal(citeArgumentBefore("\\cite{doe}"), null);
    assert.equal(citeArgumentBefore("\\cite{doe} and \\ref{se"), null);
    assert.equal(citeArgumentBefore("\\section{Introduction"), null);
    assert.equal(citeArgumentBefore("plain text"), null);
  });
});

describe("suggestCites —— 过滤与排序", () => {
  const library = [
    entry("zhou2021", { title: "Graph Neural Networks", author: "Zhou, Jie", year: "2021" }),
    entry("bengio2003", { title: "A Neural Language Model", author: "Bengio, Yoshua", year: "2003" }),
    entry("attention2017", { title: "Attention Is All You Need", author: "Vaswani, Ashish", year: "2017" }),
  ];

  test("空查询给全库，按 key 排序", () => {
    assert.deepEqual(
      suggestCites(library, "").map((item) => item.key),
      ["attention2017", "bengio2003", "zhou2021"],
    );
  });

  test("按 key / 标题 / 作者三处命中，大小写不敏感", () => {
    assert.deepEqual(suggestCites(library, "zhou").map((item) => item.key), ["zhou2021"]);
    assert.deepEqual(suggestCites(library, "graph").map((item) => item.key), ["zhou2021"]);
    assert.deepEqual(suggestCites(library, "vaswani").map((item) => item.key), ["attention2017"]);
    assert.deepEqual(suggestCites(library, "ATTENTION").map((item) => item.key), ["attention2017"]);
  });

  test("多项命中时仍按 key 排序", () => {
    // "neural" 同时命中 bengio2003 的标题与 zhou2021 的标题（Graph Neural Networks）
    assert.deepEqual(
      suggestCites(library, "neural").map((item) => item.key),
      ["bengio2003", "zhou2021"],
    );
    assert.deepEqual(
      suggestCites(
        [
          entry("b", { title: "Neural nets" }),
          entry("a", { title: "Neural nets" }),
          entry("c", { title: "Neural nets" }),
        ],
        "neural",
      ).map((item) => item.key),
      ["a", "b", "c"],
    );
  });

  test("没有命中时是空数组（弹层不出现）", () => {
    assert.deepEqual(suggestCites(library, "quantum"), []);
  });

  test("条数上限：大库只给前 N 条", () => {
    const big = Array.from({ length: 200 }, (_, index) => entry(`k${String(index).padStart(3, "0")}`));
    const suggested = suggestCites(big, "", 10);
    assert.equal(suggested.length, 10);
    assert.equal(suggested[0]?.key, "k000");
  });

  test("标题 / 作者为 null 的条目不会因字段缺失被漏掉", () => {
    assert.deepEqual(suggestCites([entry("bare")], "ba").map((item) => item.key), ["bare"]);
  });
});

describe("候选行的显示", () => {
  test("detail 是「标题 (年)」；缺标题退成类型，缺年份不画空括号", () => {
    assert.equal(citeDetail(entry("a", { title: "Deep Learning", year: "2015" })), "Deep Learning (2015)");
    assert.equal(citeDetail(entry("b", { title: "Deep Learning" })), "Deep Learning");
    assert.equal(citeDetail(entry("c", { type: "misc", year: "1999" })), "misc (1999)");
  });

  test("info 是标题 + 作者 + 来源文件（标题在行里会被省略号截断，这里给全文）", () => {
    assert.equal(
      citeInfo(entry("a", { title: "Deep Learning", author: "Doe, John", file: "refs/a.bib" })),
      "Deep Learning\nDoe, John\nrefs/a.bib",
    );
    assert.equal(citeInfo(entry("b", { file: "refs/b.bib" })), "refs/b.bib");
    assert.equal(citeInfo(entry("c", { author: null, file: "" })), "");
  });

  test("接受候选时补右括号；后面已经有一个就不重复（评审 F3）", () => {
    assert.equal(citeInsertion("vaswani2017", undefined), "vaswani2017}");
    assert.equal(citeInsertion("vaswani2017", "}"), "vaswani2017");
    // 后面是逗号（\cite{a,b} 继续写第二个 key）或空白，都要补
    assert.equal(citeInsertion("vaswani2017", ","), "vaswani2017}");
    assert.equal(citeInsertion("vaswani2017", " "), "vaswani2017}");
  });
});
