import assert from "node:assert/strict";
import test from "node:test";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { ofmToPlainMarkdown } from "./plain.ts";
import { parseProperties, splitFrontmatter } from "./properties.ts";
import { remarkOfm } from "./remark-ofm.ts";
import { normalizeRel, resolveOfmTarget } from "./resolve.ts";
import {
  calloutKind,
  findWikiLinks,
  isImageName,
  parseCalloutHead,
  parseEmbedHint,
  splitCode,
  wikiLinkLabel,
} from "./syntax.ts";

interface Node {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

function mdast(source: string, properties = true): Node {
  const processor = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).use(remarkGfm).use(remarkOfm, { properties });
  return processor.runSync(processor.parse(source)) as Node;
}

/** 把一棵树压成「类型:文字」的扁平串，方便断言 */
function flat(node: Node): string {
  if (node.value !== undefined) return node.type === "text" ? node.value : `${node.type}:${node.value}`;
  const inner = (node.children ?? []).map(flat).join("|");
  return node.children === undefined ? node.type : `${node.type}(${inner})`;
}

test("wikilink：目标 / 小节 / 别名 / 嵌入", () => {
  const found = findWikiLinks("见 [[设计系统#颜色|配色]] 与 ![[a.png|300]] 与 [[#本页]]");
  assert.equal(found.length, 3);
  assert.deepEqual(
    found.map((l) => [l.embed, l.target, l.fragment, l.alias]),
    [
      [false, "设计系统", "颜色", "配色"],
      [true, "a.png", null, "300"],
      [false, "", "本页", null],
    ],
  );
  assert.equal(wikiLinkLabel(found[0]!), "配色");
  assert.equal(wikiLinkLabel({ target: "页", fragment: "小节", alias: null }), "页 > 小节");
  assert.equal(wikiLinkLabel({ target: "页.md", fragment: null, alias: null }), "页");
});

test("嵌入尺寸与图注、图片判定", () => {
  assert.deepEqual(parseEmbedHint("300"), { width: 300 });
  assert.deepEqual(parseEmbedHint("300x200"), { width: 300, height: 200 });
  assert.deepEqual(parseEmbedHint("流程图"), { alt: "流程图" });
  assert.equal(isImageName("图.PNG"), true);
  assert.equal(isImageName("笔记.md"), false);
});

test("提醒框头与别名", () => {
  assert.deepEqual(parseCalloutHead("[!warning] 风险"), { type: "warning", fold: null, title: "风险" });
  assert.deepEqual(parseCalloutHead("[!tip]- 折叠"), { type: "tip", fold: "-", title: "折叠" });
  assert.deepEqual(parseCalloutHead("[!NOTE]+"), { type: "note", fold: "+", title: "" });
  assert.equal(parseCalloutHead("普通引用"), null);
  assert.equal(calloutKind("caution"), "warning");
  assert.equal(calloutKind("unknown-type"), "note");
});

test("splitCode：围栏与行内代码是代码，拼回等于原文", () => {
  const text = "前 `a [[b]]` 后\n```js\n[[x]] ==y==\n```\n尾 [[z]]";
  const pieces = splitCode(text);
  assert.equal(pieces.map((p) => p.text).join(""), text);
  assert.deepEqual(
    pieces.filter((p) => p.code).map((p) => p.text),
    ["`a [[b]]`", "```js\n[[x]] ==y==\n```\n"],
  );
});

test("frontmatter 切分与属性解析", () => {
  const text = "---\ntitle: 周报\ntags: [周报, orbita]\naliases:\n  - W45\n  - 第45周\ndate: 2026-11-07\nnested:\n  a: 1\n---\n# 正文";
  const split = splitFrontmatter(text);
  assert.equal(text.slice(split.bodyStart), "# 正文");
  const props = parseProperties(split.yaml ?? "");
  assert.deepEqual(props.map((p) => p.key), ["title", "tags", "aliases", "date", "nested"]);
  assert.deepEqual(props[1], { key: "tags", values: ["周报", "orbita"], list: true });
  assert.deepEqual(props[2], { key: "aliases", values: ["W45", "第45周"], list: true });
  assert.equal(props[4]?.values[0], "a: 1");
  assert.equal(splitFrontmatter("没有\n---\n不是头").yaml, null);
  assert.equal(splitFrontmatter("---\n没收尾").yaml, null);
});

test("remark-ofm：双链 / 嵌入 / 高亮 / 标签进 AST", () => {
  const tree = mdast("见 [[页|别名]] ![[图.png|300]] ==高亮== #周报 与 PR #460");
  const para = tree.children?.[0] as Node;
  const kinds = (para.children ?? []).map((n) => n.type);
  assert.deepEqual(kinds, ["text", "ofmWikiLink", "text", "ofmEmbed", "text", "ofmHighlight", "text", "ofmTag", "text"]);
  const link = para.children?.[1] as Node;
  assert.equal(link.data?.hProperties?.["data-ofm-target"], "页");
  assert.equal(flat(link), "ofmWikiLink(别名)");
  const embed = para.children?.[3] as Node;
  assert.equal(embed.data?.hName, "img");
  assert.equal(embed.data?.hProperties?.["data-ofm-embed"], "图.png");
  assert.equal(embed.data?.hProperties?.width, 300);
  // #460 纯数字不是标签
  assert.equal(flat(para).includes("ofmTag(#460)"), false);
});

test("remark-ofm：代码块与行内代码里不转换", () => {
  const tree = mdast("`[[不转]]` 与 `==不转==`\n\n```\n[[不转]] ==不转== #不转\n```\n");
  assert.equal(JSON.stringify(tree).includes("ofmWikiLink"), false);
  assert.equal(JSON.stringify(tree).includes("ofmHighlight"), false);
  assert.equal(JSON.stringify(tree).includes("ofmTag"), false);
});

test("remark-ofm：高亮可跨行内节点，不成对的 == 原样", () => {
  const cross = mdast("==**粗** 字==").children?.[0] as Node;
  assert.equal(flat(cross), "paragraph(ofmHighlight(strong(粗)| 字))");
  const lonely = mdast("a == b").children?.[0] as Node;
  assert.equal(flat(lonely), "paragraph(a == b)");
  const spaced = mdast("== a ==").children?.[0] as Node;
  assert.equal(flat(spaced).includes("ofmHighlight"), false);
});

test("remark-ofm：链接文字里不再嵌套转换、注释被拿掉", () => {
  const tree = mdast("[点这里 [[x]]](https://e.com) %%私货%% 完");
  assert.equal(JSON.stringify(tree).includes("ofmWikiLink"), false);
  assert.equal(JSON.stringify(tree).includes("私货"), false);
});

test("remark-ofm：frontmatter 变属性表，tags 变胶囊；关掉就丢弃", () => {
  const on = mdast("---\ntags: [周报]\ndate: 2026-11-07\n---\n\n正文");
  assert.equal(on.children?.[0]?.type, "ofmProperties");
  assert.equal(flat(on.children?.[0] as Node), "ofmProperties(ofmProperty(ofmPropertyKey(tags)|ofmPropertyValue(ofmTag(#周报)))|ofmProperty(ofmPropertyKey(date)|ofmPropertyValue(2026-11-07)))");
  const off = mdast("---\ntags: [周报]\n---\n\n正文", false);
  assert.equal(off.children?.[0]?.type, "paragraph");
});

test("通用 md：双链变文字、嵌入变图片、提醒框变引用、高亮变 mark、代码不动", () => {
  const source = [
    "---",
    "tags: [a]",
    "---",
    "见 [[页|别名]] 与 [[页#小节]] 与 [[#本页]]。",
    "![[图.png|300]] ![[笔记]]",
    "> [!warning] 风险",
    "> 内容",
    "> [!tip]-",
    "",
    "==亮== %%注释%% #标签",
    "`[[代码]]` ==不动?",
    "```",
    "[[围栏]] ==围栏==",
    "```",
  ].join("\n");
  const out = ofmToPlainMarkdown(source, { imagePath: (name) => (name === "图.png" ? "attachments/图 1.png" : null) });
  assert.match(out, /^---\ntags: \[a\]\n---\n/);
  assert.match(out, /见 别名 与 页 > 小节 与 本页。/);
  assert.match(out, /!\[\]\(<attachments\/图 1\.png>\) 笔记/);
  assert.match(out, /> \*\*风险\*\*\n>\n> 内容/);
  assert.match(out, /> \*\*Tip\*\*/);
  assert.match(out, /<mark>亮<\/mark>  #标签/);
  assert.match(out, /`\[\[代码\]\]`/);
  assert.match(out, /```\n\[\[围栏\]\] ==围栏==\n```/);
  assert.equal(/\[\[(?!代码|围栏)/.test(out.replace(/`[^`]*`/g, "").replace(/```[\s\S]*?```/g, "")), false);
  assert.equal(out.includes("> [!"), false);
});

test("目标解析：同目录优先、再工作区同名、不带扩展名找 md、越界为 null", () => {
  const files = ["周报/2026-W45.md", "周报/pipeline.png", "attachments/pipeline.png", "attachments/other.png", "设计系统迭代记录.md", "笔记/设计系统迭代记录.md", "docs/a.csv"];
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "pipeline.png", "image"), "周报/pipeline.png");
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "other.png", "image"), "attachments/other.png");
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "设计系统迭代记录", "link"), "设计系统迭代记录.md");
  assert.equal(resolveOfmTarget(files, "笔记/x.md", "设计系统迭代记录", "link"), "笔记/设计系统迭代记录.md");
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "docs/a.csv", "link"), "docs/a.csv");
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "不存在", "link"), null);
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "../../../etc/passwd", "image"), null);
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "https://e.com/a.png", "image"), null);
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "../attachments/other.png", "image"), "attachments/other.png");
  assert.equal(resolveOfmTarget(files, "周报/2026-W45.md", "attachments/pipeline%2Epng", "image"), "attachments/pipeline.png");
  assert.equal(normalizeRel("a/./b/../c"), "a/c");
  assert.equal(normalizeRel("../a"), null);
});
