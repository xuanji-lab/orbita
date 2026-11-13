import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { placeInsertion } from "./insert-placement.ts";

const apply = (doc: string, from: number, to: number, text: string): string => {
  const p = placeInsertion(doc, from, to, text);
  return doc.slice(0, p.from) + p.insert + doc.slice(p.to);
};

describe("插图的落点", () => {
  it("光标在文首 / frontmatter 里：挪到属性区之后", () => {
    const doc = "---\ntags: [a]\n---\n# 标题\n";
    assert.equal(apply(doc, 0, 0, "![[a.png]]"), "---\ntags: [a]\n---\n![[a.png]]\n\n# 标题\n");
    assert.equal(apply(doc, 6, 6, "![[a.png]]").startsWith("---\ntags: [a]\n---\n"), true);
  });

  it("空行原样；行尾 / 行首另起一段；句中就地", () => {
    assert.equal(apply("甲\n\n乙", 2, 2, "![[a.png]]"), "甲\n![[a.png]]\n乙");
    assert.equal(apply("甲乙", 2, 2, "![[a.png]]"), "甲乙\n\n![[a.png]]");
    assert.equal(apply("甲乙", 0, 0, "![[a.png]]"), "![[a.png]]\n\n甲乙");
    assert.equal(apply("甲乙", 1, 1, "![[a.png]]"), "甲![[a.png]]乙");
  });

  it("选中了整行：替换它", () => {
    assert.equal(apply("甲\n乙\n丙", 2, 3, "![[a.png]]"), "甲\n![[a.png]]\n丙");
  });
});
