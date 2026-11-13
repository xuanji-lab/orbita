/**
 * BibTeX 词法器的账：条目类型 / 字段名 / 值 / 注释各归哪一类着色。
 * 用假流（真 StringStream 的同样几个方法）跑，不需要编辑器实例。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bibTexToken, type BibTokenStream } from "./bibtex-language.ts";

/** 最小 StringStream：只实现词法器用到的方法，并暴露游标给测试读 */
function streamOf(input: string): BibTokenStream & { pos: number } {
  return {
    pos: 0,
    eatSpace() {
      const start = this.pos;
      while (this.pos < input.length && /\s/.test(input[this.pos] ?? "")) this.pos += 1;
      return this.pos > start;
    },
    peek() {
      return input[this.pos];
    },
    next() {
      const ch = input[this.pos];
      this.pos += 1;
      return ch;
    },
    skipToEnd() {
      this.pos = input.length;
    },
    match(pattern, consume = true) {
      const found = pattern.exec(input.slice(this.pos));
      if (found === null || found.index !== 0) return false;
      if (consume) this.pos += found[0].length;
      return true;
    },
  };
}

/** 一行 → `[token, text]` 序列（纯空白不进结果） */
function tokenize(line: string): [string, string][] {
  const stream = streamOf(line);
  const out: [string, string][] = [];
  for (let guard = 0; guard < 200 && stream.pos < line.length; guard += 1) {
    const start = stream.pos;
    const token = bibTexToken(stream);
    if (stream.pos === start) break; // 词法器没有推进：防死循环，也让测试当场失败
    if (token !== null) out.push([token, line.slice(start, stream.pos)]);
  }
  return out;
}

describe("bibTexToken", () => {
  test("@article 是条目类型，条目 key 是普通值", () => {
    assert.deepEqual(tokenize("@article{smith2020,"), [
      ["tagName", "@article"],
      ["bracket", "{"],
      ["atom", "smith2020"],
      ["operator", ","],
    ]);
  });

  test("字段名靠后面的 = 认出来（propertyName），值里的花括号是括号", () => {
    assert.deepEqual(tokenize("  title = {A}"), [
      ["propertyName", "title"],
      ["operator", "="],
      ["bracket", "{"],
      ["atom", "A"],
      ["bracket", "}"],
    ]);
  });

  test("引号字符串、数字、% 注释", () => {
    assert.deepEqual(tokenize('journal = "Foundations of"'), [
      ["propertyName", "journal"],
      ["operator", "="],
      ["string", '"Foundations of"'],
    ]);
    assert.deepEqual(tokenize("year = 2020"), [
      ["propertyName", "year"],
      ["operator", "="],
      ["number", "2020"],
    ]);
    assert.deepEqual(tokenize("% a note"), [["comment", "% a note"]]);
  });
});
