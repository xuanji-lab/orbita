import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyElementRefs, formatAxOutline, type AxNode } from "./page-outline.ts";

/** 一棵小树：根 → main（含标题、无名 generic 包着的列表、链接、输入框）→ 页脚 */
const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  childIds,
  ...extra,
});

const tree: AxNode[] = [
  { ...node("1", "RootWebArea", "Scopus - Search", ["2", "9"]) },
  { ...node("2", "main", "", ["3", "4", "8"]), parentId: "1" },
  { ...node("3", "heading", "Search results", [], { properties: [{ name: "level", value: { value: 1 } }] }), parentId: "2" },
  { ...node("4", "generic", "", ["5"]), parentId: "2" },
  { ...node("5", "list", "", ["6"]), parentId: "4" },
  { ...node("6", "listitem", "", ["7"]), parentId: "5" },
  { ...node("7", "link", "Deep learning for systematic reviews", ["70"]), parentId: "6" },
  { ...node("70", "StaticText", "Deep learning for systematic reviews"), parentId: "7" },
  {
    ...node("8", "searchbox", "Search documents", [], {
      value: { value: "LLM" },
      properties: [{ name: "required", value: { value: true } }],
    }),
    parentId: "2",
  },
  { ...node("9", "contentinfo", "", ["10", "11"]), parentId: "1" },
  { ...node("10", "button", "Export", [], { properties: [{ name: "disabled", value: { value: true } }] }), parentId: "9" },
  { ...node("11", "image", "", []), parentId: "9" },
];

test("地标缩进子节点；无名列表只作缩进锚；generic 不占行不加深；正文不印", () => {
  const { text, omitted } = formatAxOutline(tree, 100);
  assert.equal(
    text,
    [
      "- main",
      '  - heading "Search results" [level 1]',
      '    - link "Deep learning for systematic reviews"',
      '  - searchbox "Search documents" value="LLM" [required]',
      "- contentinfo",
      '  - button "Export" [disabled]',
    ].join("\n"),
  );
  assert.equal(omitted, 0);
});

test("超过行数预算：截断并数出省略的行数", () => {
  const { text, lines, omitted } = formatAxOutline(tree, 2);
  assert.equal(lines, 2);
  assert.equal(text.split("\n").length, 2);
  assert.equal(omitted, 4);
});

test("ignored 节点自己不印，子节点照常下钻", () => {
  const nodes: AxNode[] = [
    node("1", "RootWebArea", "", ["2"]),
    { ...node("2", "button", "Hidden wrapper", ["3"]), ignored: true, parentId: "1" },
    { ...node("3", "link", "Real link"), parentId: "2" },
  ];
  assert.equal(formatAxOutline(nodes, 10).text, '- link "Real link"');
});

test("长名字截断；空树不炸", () => {
  const nodes: AxNode[] = [node("1", "RootWebArea", "", ["2"]), { ...node("2", "link", "x".repeat(300)), parentId: "1" }];
  const line = formatAxOutline(nodes, 10).text;
  assert.ok(line.length < 140, line);
  assert.ok(line.endsWith('…"'));
  assert.deepEqual(formatAxOutline([], 10), { text: "", lines: 0, omitted: 0 });
});

test("传了引用表：可交互且没禁用的节点带 [ref=eN]；标题与禁用按钮不带；只给印出来的行发", () => {
  const withIds = tree.map((n) => ({ ...n, backendDOMNodeId: Number(n.nodeId) * 10 }));
  const refs = emptyElementRefs();
  const { text } = formatAxOutline(withIds, 100, refs);
  assert.match(text, /link "Deep learning for systematic reviews" \[ref=e1\]/);
  assert.match(text, /searchbox "Search documents" value="LLM" \[required\] \[ref=e2\]/);
  assert.doesNotMatch(text, /heading[^\n]*ref=/);
  assert.doesNotMatch(text, /Export[^\n]*ref=/);
  assert.equal(refs.byRef.get("e1"), 70);
  assert.equal(refs.byRef.get("e2"), 80);
  // 行预算外的节点不发引用
  const tight = emptyElementRefs();
  formatAxOutline(withIds, 3, tight);
  assert.deepEqual([...tight.byRef.keys()], ["e1"]);
});

test("同一个节点在多次 observe 之间保持同一个引用；新节点接着编号", () => {
  const refs = emptyElementRefs();
  const nodes: AxNode[] = [
    node("1", "RootWebArea", "", ["2", "3"]),
    { ...node("2", "button", "Search"), parentId: "1", backendDOMNodeId: 200 },
    { ...node("3", "link", "Next"), parentId: "1", backendDOMNodeId: 300 },
  ];
  formatAxOutline(nodes, 10, refs);
  const reordered: AxNode[] = [
    node("1", "RootWebArea", "", ["4", "3", "2"]),
    { ...node("4", "checkbox", "Open access"), parentId: "1", backendDOMNodeId: 400 },
    { ...node("3", "link", "Next"), parentId: "1", backendDOMNodeId: 300 },
    { ...node("2", "button", "Search"), parentId: "1", backendDOMNodeId: 200 },
  ];
  const { text } = formatAxOutline(reordered, 10, refs);
  assert.equal(
    text,
    ['- checkbox "Open access" [ref=e3]', '- link "Next" [ref=e2]', '- button "Search" [ref=e1]'].join("\n"),
  );
});

test("不传引用表（读「你的」tab）：不发引用", () => {
  const withIds = tree.map((n) => ({ ...n, backendDOMNodeId: Number(n.nodeId) }));
  assert.doesNotMatch(formatAxOutline(withIds, 100).text, /ref=/);
});
