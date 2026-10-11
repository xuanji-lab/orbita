import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CITE_HREF_PREFIX,
  citationIdOfHref,
  citationTitle,
  collectCitations,
  linkCitationMarkers,
} from "./citation-markers.ts";

interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

const paragraph = (...children: Node[]): Node => ({ type: "root", children: [{ type: "paragraph", children }] });

describe("linkCitationMarkers", () => {
  it("标记切成链接，按出场序号编号，重复编号沿用首次序号", () => {
    const tree = paragraph({ type: "text", value: "采用双缓冲[^c4k2]。另见[^c1z9][^c4k2]。" });
    linkCitationMarkers(tree);
    const children = tree.children?.[0]?.children ?? [];
    assert.deepEqual(
      children.map((node) => (node.type === "link" ? `${node.url}=${node.children?.[0]?.value}` : node.value)),
      ["采用双缓冲", `${CITE_HREF_PREFIX}c4k2=1`, "。另见", `${CITE_HREF_PREFIX}c1z9=2`, `${CITE_HREF_PREFIX}c4k2=1`, "。"],
    );
  });

  it("行内代码、已有链接里不动；人写的数字脚注不认", () => {
    const tree = paragraph(
      { type: "inlineCode", value: "[^c000]" },
      { type: "link", url: "https://x", children: [{ type: "text", value: "[^c111]" }] },
      { type: "text", value: "footnote [^1] stays" },
    );
    const before = JSON.stringify(tree);
    linkCitationMarkers(tree);
    assert.equal(JSON.stringify(tree), before);
  });

  it("嵌套在强调里的标记也会处理", () => {
    const tree = paragraph({ type: "strong", children: [{ type: "text", value: "关键[^cabc]" }] });
    linkCitationMarkers(tree);
    const strong = tree.children?.[0]?.children?.[0];
    assert.equal(strong?.children?.[1]?.type, "link");
  });
});

describe("citationIdOfHref / citationTitle", () => {
  it("只认引用锚点", () => {
    assert.equal(citationIdOfHref(`${CITE_HREF_PREFIX}c4k2`), "c4k2");
    assert.equal(citationIdOfHref("https://example.com"), null);
    assert.equal(citationIdOfHref(`${CITE_HREF_PREFIX}bad`), null);
    assert.equal(citationIdOfHref(undefined), null);
  });

  it("悬停提示带页码与截断的原文", () => {
    assert.equal(citationTitle(3, "abc"), "p.3 · “abc”");
    assert.equal(citationTitle(1, "abcdef", 3), "p.1 · “abc…”");
  });
});

describe("collectCitations", () => {
  const citation = { id: "c4k2", path: "/a.pdf", page: 2, start: 0, end: 4, text: "原文" };
  it("只收 cite_pdf 的终态结果，后来的覆盖先前的", () => {
    const table = collectCitations([
      { role: "tool", toolName: "cite_pdf", status: "done", details: { pdfCitations: [citation] } },
      { role: "tool", toolName: "read_pdf", status: "done", details: { pdfCitations: [{ ...citation, id: "c999" }] } },
      { role: "tool", toolName: "cite_pdf", status: "running" },
      { role: "tool", toolName: "cite_pdf", status: "done", details: { pdfCitations: [{ ...citation, page: 5 }] } },
      { role: "assistant" },
    ]);
    assert.deepEqual([...table.keys()], ["c4k2"]);
    assert.equal(table.get("c4k2")?.page, 5);
  });
});
