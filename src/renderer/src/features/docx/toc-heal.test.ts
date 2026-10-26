import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyTocHeal,
  collectTocFacts,
  layoutCoversDocument,
  planTocHeal,
  type TocHealLayout,
  type TocHealNode,
  type TocHealTr,
} from "./toc-heal.ts";

/** 伪造 ProseMirror 节点：只要 type / attrs / text / forEach（与真实 Node 的这些成员同形） */
interface FakeNode extends TocHealNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  text?: string | null;
  forEach: (fn: (node: TocHealNode, offset: number) => void) => void;
}

function text(value: string): FakeNode {
  return { type: { name: "text" }, attrs: {}, text: value, forEach: () => undefined };
}

function atom(name: string, attrs: Record<string, unknown>): FakeNode {
  return { type: { name }, attrs, forEach: () => undefined };
}

/** 段落 / 容器：forEach 的 offset 是子节点的累计 nodeSize，与 ProseMirror 一致 */
function container(name: string, attrs: Record<string, unknown>, children: FakeNode[]): FakeNode {
  return {
    type: { name },
    attrs,
    forEach: (fn) => {
      let offset = 0;
      for (const child of children) {
        fn(child, offset);
        offset += nodeSize(child);
      }
    },
  };
}

function nodeSize(node: FakeNode): number {
  if (node.type.name === "text") return node.text?.length ?? 0;
  if (node.type.name === "doc" || node.type.name === "paragraph") {
    let size = 0;
    node.forEach((child) => {
      size += nodeSize(child as FakeNode);
    });
    return size + 2;
  }
  // 叶子原子（tab / field / bookmarkBoundary）：一个位置
  return 1;
}

function doc(children: FakeNode[]): FakeNode {
  return container("doc", {}, children);
}

function paragraph(attrs: Record<string, unknown>, children: FakeNode[]): FakeNode {
  return container("paragraph", attrs, children);
}

function field(type: string, instruction: string, displayText: string): FakeNode {
  return atom("field", { fieldType: type, instruction, displayText, fieldKind: "complex", dirty: true });
}

function bookmark(name: string): FakeNode {
  return atom("bookmarkBoundary", { type: "start", id: 1, name });
}

const BS = String.fromCharCode(92);

/** 垫长一段正文，把后面的段落推到第二页（书签页码才有变化） */
function filler(chars = 20): FakeNode {
  return paragraph({}, [text("正".repeat(chars))]);
}

/** 三页：p1 覆盖 0–10、p2 覆盖 11–30、p3 覆盖 31–60（片段区间与真实 layout 一样是闭区间） */
const layout: TocHealLayout = {
  pages: [
    { number: 1, fragments: [{ pmStart: 0, pmEnd: 10 }] },
    { number: 2, fragments: [{ pmStart: 11, pmEnd: 30 }] },
    { number: 3, fragments: [{ pmStart: 31, pmEnd: 60 }] },
  ],
};

describe("docx 目录页码自愈：清点事实", () => {
  test("书签 / PAGEREF 域 / 标题 / 静态目录条目各归各位", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [text("第一章 项目背景"), atom("tab", {}), field("PAGEREF", `PAGEREF _Toc1 ${BS}h`, "1")]),
      paragraph({ styleId: "TOC2" }, [text("1.1 现状问题"), atom("tab", {}), text("98")]),
      paragraph({ styleId: "Heading1" }, [bookmark("_Toc1"), text("第一章 项目背景")]),
      paragraph({ styleId: "Heading2" }, [text("1.1 现状问题")]),
    ]);
    const facts = collectTocFacts(d);
    deepStrictEqual(
      facts.fields.map((f) => [f.pos, f.instruction, f.displayText]),
      [[10, `PAGEREF _Toc1 ${BS}h`, "1"]],
    );
    deepStrictEqual(
      facts.headings.map((h) => h.text),
      ["第一章项目背景", "1.1现状问题"],
    );
    deepStrictEqual(
      facts.staticEntries.map((e) => [e.before, e.title]),
      [["98", "1.1现状问题"]],
    );
    // 书签在段落内第一个子节点：段落起点 + 1
    const heading = facts.headings[0];
    ok(heading !== undefined);
    deepStrictEqual(facts.bookmarks, [{ name: "_Toc1", pos: heading.pos + 1 }]);
  });

  test("域形态的目录条目不算静态条目：尾部是 field 原子，不是文字数字", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [text("第一章 项目背景"), atom("tab", {}), field("PAGEREF", `PAGEREF _Toc1 ${BS}h`, "1")]),
    ]);
    const facts = collectTocFacts(d);
    deepStrictEqual(facts.staticEntries, []);
    strictEqual(facts.fields.length, 1);
  });

  test("TOCHeading 与普通段落都不算静态目录条目", () => {
    const d = doc([
      paragraph({ styleId: "TOCHeading" }, [text("目录")]),
      paragraph({ styleId: null }, [text("2024 年度总结")]),
      paragraph({ styleId: "TOC3" }, [text("尾部不是数字")]),
    ]);
    const facts = collectTocFacts(d);
    deepStrictEqual(facts.staticEntries, []);
    deepStrictEqual(facts.headings, []);
  });
});

describe("docx 目录页码自愈：计划", () => {
  test("PAGEREF 按书签所在页改写缓存显示值，指令与 dirty 之外的东西都不动", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [text("第一章 项目背景"), atom("tab", {}), field("PAGEREF", `PAGEREF _Toc1 ${BS}h`, "1")]),
      paragraph({ styleId: "Heading1" }, [bookmark("_Toc1"), text("第一章 项目背景")]),
    ]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    deepStrictEqual(plan.ops, [{ kind: "field", pos: 10, displayText: "2" }]);
    deepStrictEqual([plan.fields, plan.changed, plan.missed], [1, 1, 0]);
  });

  test("页码已经正确 → 不产生 op（第二次保存不动文档）", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [field("PAGEREF", `PAGEREF _Toc1 ${BS}h`, "3")]),
      filler(40),
      paragraph({ styleId: "Heading1" }, [bookmark("_Toc1"), text("第一章 项目背景")]),
    ]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    deepStrictEqual(plan.ops, []);
    deepStrictEqual([plan.fields, plan.changed, plan.missed], [1, 0, 0]);
  });

  test("书签解析不到：不覆盖旧值，只记一条「没定位到」", () => {
    const d = doc([paragraph({ styleId: "TOC1" }, [field("PAGEREF", `PAGEREF _TocX ${BS}h`, "7")])]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    deepStrictEqual(plan.ops, []);
    deepStrictEqual([plan.fields, plan.changed, plan.missed], [1, 0, 1]);
  });

  test("格式开关交给 folio 求值：\\* roman 写罗马数字，\\p 求不出值就不动", () => {
    const d = doc([
      paragraph({}, [field("PAGEREF", `PAGEREF _Toc1 ${BS}* roman ${BS}h`, "1")]),
      paragraph({}, [field("PAGEREF", `PAGEREF _Toc2 ${BS}p ${BS}h`, "5")]),
      filler(5),
      paragraph({}, [bookmark("_Toc1"), text("甲")]),
      paragraph({}, [bookmark("_Toc2"), text("乙")]),
    ]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    deepStrictEqual(
      plan.ops.map((op) => (op.kind === "field" ? [op.pos, op.displayText] : op)),
      [[1, "ii"]],
    );
    deepStrictEqual([plan.changed, plan.missed], [1, 1]);
  });

  test("静态目录：尾部数字换成同名标题的页码，替换范围恰好是那段数字", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [text("第一章 项目背景"), atom("tab", {}), text("99")]),
      paragraph({ styleId: "Heading1" }, [text("第一章 项目背景")]),
    ]);
    const facts = collectTocFacts(d);
    const plan = planTocHeal(facts, layout);
    const entry = facts.staticEntries[0];
    ok(entry !== undefined);
    deepStrictEqual(plan.ops, [{ kind: "text", from: entry.from, to: entry.to, text: "2" }]);
    deepStrictEqual([plan.staticEntries, plan.staticChanged, plan.missed], [1, 1, 0]);
    strictEqual(entry.to - entry.from, 2);
    // 段落起点 + 1 + 「第一章 项目背景」8 字 + 制表符 1 格 = 数字起点
    strictEqual(entry.from, 1 + 8 + 1);
  });

  test("静态目录条目找不到同名标题：不动，记一条没定位到", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [text("第九章 不存在"), atom("tab", {}), text("9")]),
      paragraph({ styleId: "Heading1" }, [text("第一章 项目背景")]),
    ]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    deepStrictEqual(plan.ops, []);
    deepStrictEqual([plan.staticEntries, plan.missed], [1, 1]);
  });

  test("没有目录的文档：标题照常清点，但一条 op 都不产生", () => {
    const d = doc([
      paragraph({ styleId: "Title" }, [text("合同")]),
      paragraph({ styleId: "Heading1" }, [text("第一章 总则")]),
      paragraph({}, [text("正文正文")]),
    ]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    deepStrictEqual(plan.ops, []);
    deepStrictEqual([plan.fields, plan.staticEntries, plan.changed, plan.missed], [0, 0, 0, 0]);
  });

  test("两类 op 可以出现在同一份计划里（写回顺序由 applyTocHeal 管）", () => {
    const d = doc([
      paragraph({ styleId: "TOC1" }, [text("第一章 项目背景"), atom("tab", {}), text("99")]),
      paragraph({}, [field("PAGEREF", `PAGEREF _Toc1 ${BS}h`, "1")]),
      paragraph({ styleId: "Heading1" }, [bookmark("_Toc1"), text("第一章 项目背景")]),
    ]);
    const plan = planTocHeal(collectTocFacts(d), layout);
    strictEqual(plan.ops.length, 2);
  });
});

describe("docx 目录页码自愈：版面是否跟上了这次改动", () => {
  test("版面末尾正好是 content.size - 1：算跟上（真样张实测都是这一个值）", () => {
    strictEqual(layoutCoversDocument(layout, 61), true);
  });

  test("文档比版面长（刚插入了文字）：没跟上", () => {
    // 实测复现：打字后 250 ms 按 Ctrl+S，docSize=1750，而拿到的版面只排到 1315
    strictEqual(layoutCoversDocument(layout, 1751), false);
  });

  test("文档比版面短（刚删了字）：也算没跟上，不能拿旧版面去对书签", () => {
    strictEqual(layoutCoversDocument(layout, 40), false);
  });

  test("空版面：没跟上", () => {
    strictEqual(layoutCoversDocument({ pages: [] }, 61), false);
  });
});

describe("docx 目录页码自愈：写回", () => {
  function fakeTr(nodes: Map<number, { attrs: Record<string, unknown> }>) {
    const calls: string[] = [];
    const tr: TocHealTr = {
      doc: { nodeAt: (pos) => nodes.get(pos) ?? null },
      setNodeMarkup: (pos, _type, attrs) => {
        calls.push(`markup:${pos}:${String(attrs["displayText"])}:${String(attrs["dirty"])}`);
        return tr;
      },
      insertText: (value, from, to) => {
        calls.push(`text:${from}-${to}:${value}`);
        return tr;
      },
    };
    return { tr, calls };
  }

  test("域只改 displayText 与 dirty，指令原样保留", () => {
    const instruction = `PAGEREF _Toc1 ${BS}h`;
    const { tr, calls } = fakeTr(new Map([[1, { attrs: { fieldType: "PAGEREF", instruction, displayText: "1" } }]]));
    const plan = planTocHeal(
      collectTocFacts(
        doc([
          paragraph({ styleId: "TOC1" }, [field("PAGEREF", instruction, "1")]),
          filler(20),
          paragraph({ styleId: "Heading1" }, [bookmark("_Toc1")]),
        ]),
      ),
      layout,
    );
    applyTocHeal(tr, plan);
    deepStrictEqual(calls, ["markup:1:2:false"]);
  });

  test("按计划顺序写：先改靠后的位置（前面的位置不会被推移）", () => {
    const { tr, calls } = fakeTr(new Map([[40, { attrs: { displayText: "1" } }]]));
    applyTocHeal(tr, {
      ops: [
        { kind: "text", from: 20, to: 22, text: "12" },
        { kind: "field", pos: 40, displayText: "3" },
      ],
      fields: 1,
      staticEntries: 1,
      changed: 2,
      staticChanged: 1,
      missed: 0,
    });
    deepStrictEqual(calls, ["markup:40:3:false", "text:20-22:12"]);
  });

  test("位置失效（节点没了）时跳过这一条，不抛出去打断保存", () => {
    const { tr, calls } = fakeTr(new Map());
    applyTocHeal(tr, {
      ops: [{ kind: "field", pos: 99, displayText: "3" }],
      fields: 1,
      staticEntries: 0,
      changed: 1,
      staticChanged: 0,
      missed: 0,
    });
    deepStrictEqual(calls, []);
  });
});
