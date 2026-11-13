/**
 * 模型给引用标记补了脚注定义时的兜底（2026-11-08 会话 96d38d）：
 * 用 MarkdownBlock 的同款管线（remark-parse → remark-gfm → remarkCitationMarkers）钉死——
 * 标记仍是可点的引用链接、重复的来源列表被删掉、人写的脚注不动、代码里不动。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { CITE_HREF_PREFIX, remarkCitationMarkers } from "./citation-markers.ts";
import { SESSION_96D38D_ANSWER } from "./citation-footnote-fixture.ts";

interface Node {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Node[];
}

/** 解析并跑引用插件；返回变换后的树 */
function run(markdown: string): Node {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkCitationMarkers);
  return processor.runSync(processor.parse(markdown)) as unknown as Node;
}

function collect(node: Node, type: string, out: Node[] = []): Node[] {
  if (node.type === type) out.push(node);
  for (const child of node.children ?? []) collect(child, type, out);
  return out;
}

const citeLinks = (tree: Node): string[] =>
  collect(tree, "link")
    .filter((node) => node.url?.startsWith(CITE_HREF_PREFIX))
    .map((node) => `${node.url?.slice(CITE_HREF_PREFIX.length)}=${node.children?.[0]?.value}`);

describe("引用标记带脚注定义", () => {
  it("没有插件时 remark-gfm 确实把它认成脚注（复现根因）", () => {
    const tree = unified().use(remarkParse).use(remarkGfm).parse("采用双缓冲[^c4k2]。\n\n[^c4k2]: a.pdf, p. 1\n") as unknown as Node;
    assert.equal(collect(tree, "footnoteReference").length, 1);
    assert.equal(collect(tree, "footnoteDefinition").length, 1);
  });

  it("标记仍是引用链接，定义被删，序号按出场排", () => {
    const tree = run("甲[^c1z9]。乙[^c4k2]。丙[^c1z9]。\n\n[^c4k2]: b.pdf, p. 2\n[^c1z9]: a.pdf, p. 1\n");
    assert.deepEqual(citeLinks(tree), ["c1z9=1", "c4k2=2", "c1z9=1"]);
    assert.equal(collect(tree, "footnoteReference").length, 0);
    assert.equal(collect(tree, "footnoteDefinition").length, 0);
  });

  it("只给部分标记补了定义：有定义的走脚注路径、没有的走文本路径，序号连续", () => {
    const tree = run("甲[^c1z9]，乙[^c4k2]。\n\n[^c4k2]: b.pdf, p. 2\n");
    assert.deepEqual(citeLinks(tree), ["c1z9=1", "c4k2=2"]);
    assert.equal(collect(tree, "footnoteDefinition").length, 0);
  });

  it("人写的脚注（[^1]、[^note]）原样保留，与引用标记混用互不干扰", () => {
    const tree = run("事实[^1]，另一点[^note]，原文[^c4k2]。\n\n[^1]: 数字脚注\n[^note]: 命名脚注\n[^c4k2]: x.pdf, p. 1\n");
    assert.deepEqual(citeLinks(tree), ["c4k2=1"]);
    assert.deepEqual(
      collect(tree, "footnoteReference").map((node) => node.identifier),
      ["1", "note"],
    );
    assert.deepEqual(
      collect(tree, "footnoteDefinition").map((node) => node.identifier),
      ["1", "note"],
    );
  });

  it("没有定义时行为不变（文本路径）", () => {
    const tree = run("采用双缓冲[^c4k2]。");
    assert.deepEqual(citeLinks(tree), ["c4k2=1"]);
  });

  it("大写标签不认（与文本路径一致）", () => {
    const tree = run("甲[^C4K2]。\n\n[^C4K2]: x\n");
    assert.deepEqual(citeLinks(tree), []);
    assert.equal(collect(tree, "footnoteReference").length, 1);
  });

  it("代码块、行内代码里的标记与定义写法不动", () => {
    const markdown = "语法是 `[^c4k2]`。\n\n```\n[^c4k2]: x.pdf\n```\n";
    const tree = run(markdown);
    assert.deepEqual(citeLinks(tree), []);
    assert.equal(collect(tree, "footnoteDefinition").length, 0);
    assert.deepEqual(
      collect(tree, "code").map((node) => node.value),
      ["[^c4k2]: x.pdf"],
    );
    assert.deepEqual(
      collect(tree, "inlineCode").map((node) => node.value),
      ["[^c4k2]"],
    );
  });

  it("真实回答（会话 96d38d）：15 处标记全是引用链接，15 条定义全部去掉", () => {
    const tree = run(SESSION_96D38D_ANSWER);
    const links = citeLinks(tree);
    assert.equal(links.length, 15);
    assert.deepEqual(
      links.map((link) => link.split("=")[1]),
      Array.from({ length: 15 }, (_, i) => String(i + 1)),
    );
    assert.equal(collect(tree, "footnoteReference").length, 0);
    assert.equal(collect(tree, "footnoteDefinition").length, 0);
  });
});
