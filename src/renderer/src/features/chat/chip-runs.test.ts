import { deepStrictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { rehypeBubbleChips, splitChipRuns, type HastNode } from "./chip-runs.ts";

describe("splitChipRuns —— 气泡文本节点的切分", () => {
  it("中英混排：token 成 chip，散文原样", () => {
    deepStrictEqual(splitChipRuns("先调用 /skill:pdf-tools 处理", true), [
      { kind: "text", text: "先调用 " },
      { kind: "chip", chipKind: "skill", text: "/skill:pdf-tools", target: "pdf-tools" },
      { kind: "text", text: " 处理" },
    ]);
  });

  it("多 token、多行", () => {
    deepStrictEqual(splitChipRuns("/skill:a 再\n/skill:b", true), [
      { kind: "chip", chipKind: "skill", text: "/skill:a", target: "a" },
      { kind: "text", text: " 再\n" },
      { kind: "chip", chipKind: "skill", text: "/skill:b", target: "b" },
    ]);
  });

  it("/mcp: token 也画，kind 随 token", () => {
    deepStrictEqual(splitChipRuns("用 /mcp:filesystem 读", true), [
      { kind: "text", text: "用 " },
      { kind: "chip", chipKind: "mcp", text: "/mcp:filesystem", target: "filesystem" },
      { kind: "text", text: " 读" },
    ]);
  });

  it("token 在节点开头且前面是词（如前一个兄弟是 strong）→ 不画", () => {
    deepStrictEqual(splitChipRuns("/skill:x 后面", false), [
      { kind: "text", text: "/skill:x 后面" },
    ]);
  });

  it("token 在节点开头且前面是边界（段首 / 前一个文本节点以空白收尾）→ 画", () => {
    deepStrictEqual(splitChipRuns("/skill:x 后面", true), [
      { kind: "chip", chipKind: "skill", text: "/skill:x", target: "x" },
      { kind: "text", text: " 后面" },
    ]);
  });

  it("节点开头的 token 被拒后，节点后面的 token 照画", () => {
    deepStrictEqual(splitChipRuns("/skill:x 然后 /skill:y", false), [
      { kind: "text", text: "/skill:x 然后 " },
      { kind: "chip", chipKind: "skill", text: "/skill:y", target: "y" },
    ]);
  });

  it("破损 token（空 target、词内 /、缺冒号）不成 chip", () => {
    deepStrictEqual(splitChipRuns("a /skill: b用/skill:c https://x/skill:d /mcp:", true), [
      { kind: "text", text: "a /skill: b用/skill:c https://x/skill:d /mcp:" },
    ]);
  });

  it("无 token 的节点返回单段，调用方据此跳过替换", () => {
    deepStrictEqual(splitChipRuns("普通一句话", true), [{ kind: "text", text: "普通一句话" }]);
  });
});

describe("rehypeBubbleChips —— hast 树上的替换", () => {
  /** 最小 hast：一段 <p>，children 里混文本与 strong */
  const p = (children: HastNode[]): HastNode => ({ type: "element", tagName: "p", children, properties: {} });
  const text = (value: string): HastNode => ({ type: "text", value });
  const strong = (children: HastNode[]): HastNode => ({ type: "element", tagName: "strong", children, properties: {} });
  const root = (children: HastNode[]): HastNode => ({ type: "root", children });

  it("段落里的 token 替换成 chip span，前后文本保留", () => {
    const tree = root([p([text("先 /skill:pdf 后")])]);
    rehypeBubbleChips()(tree);
    deepStrictEqual((tree.children?.[0] as { children: HastNode[] }).children, [
      text("先 "),
      {
        type: "element",
        tagName: "span",
        properties: { className: ["bubble-chip", "bubble-chip-skill"] },
        children: [text("/skill:pdf")],
      },
      text(" 后"),
    ]);
  });

  it("/mcp: token 换成 bubble-chip-mcp", () => {
    const tree = root([p([text("用 /mcp:fs 帮忙")])]);
    rehypeBubbleChips()(tree);
    deepStrictEqual((tree.children?.[0] as { children: HastNode[] }).children, [
      text("用 "),
      {
        type: "element",
        tagName: "span",
        properties: { className: ["bubble-chip", "bubble-chip-mcp"] },
        children: [text("/mcp:fs")],
      },
      text(" 帮忙"),
    ]);
  });

  it("strong 之后的文本节点：token 贴着行内元素（源文本里前一个字符是 *）不画", () => {
    const tree = root([p([text("看这个"), strong([text("重点")]), text("/skill:x 后")])]);
    rehypeBubbleChips()(tree);
    const kids = (tree.children?.[0] as { children: HastNode[] }).children;
    deepStrictEqual(kids[kids.length - 1], text("/skill:x 后"));
  });

  it("code 与 pre 里的 token 不画（代码块里的字面 token 画成 chip 是事故）", () => {
    const code: HastNode = { type: "element", tagName: "code", properties: {}, children: [text("run /skill:x now")] };
    const pre: HastNode = { type: "element", tagName: "pre", properties: {}, children: [code] };
    const tree = root([p([pre])]);
    rehypeBubbleChips()(tree);
    deepStrictEqual(code.children, [text("run /skill:x now")]);
  });

  it("br 之后的文本节点：token 在节点头照画（br = 源文本里的换行）", () => {
    const br: HastNode = { type: "element", tagName: "br", properties: {}, children: [] };
    const tree = root([p([text("第一行"), br, text("/skill:x 二行")])]);
    rehypeBubbleChips()(tree);
    const kids = (tree.children?.[0] as { children: HastNode[] }).children;
    deepStrictEqual(kids[2], {
      type: "element",
      tagName: "span",
      properties: { className: ["bubble-chip", "bubble-chip-skill"] },
      children: [text("/skill:x")],
    });
  });
});
