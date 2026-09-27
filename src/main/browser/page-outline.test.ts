import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAxOutline, type AxNode } from "./page-outline.ts";

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
