/**
 * .bib 排序 / 等号对齐：稳定、原位保留、幂等。夹具是真实文献库的形状
 * （文件头注释、@string 块、条目之间的注释、跨行字段值）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { parseBibtex } from "./bib.ts";
import { alignBib, sortBib } from "./bib-edit.ts";

const HEADER = `% refs.bib — 我自己维护的文献库
% 下一行是宏
@string{acm = "ACM Press"}
`;

function keys(source: string): string[] {
  return parseBibtex(source).entries.map((entry) => entry.key);
}

describe("sortBib —— 排序", () => {
  const source = `${HEADER}@article{zeta, title = {Z}, year = {2020}}
% 中文文献
@book{alpha, title = {A}, year = {2018}, author = {Zed}}
@misc{mid, title = {M}, year = {2019}}
`;

  test("按 key 稳定排序；文件头注释与 @string 块原位不动", () => {
    const result = sortBib(source, "key");
    assert.equal(result.changed, true);
    assert.deepEqual(keys(result.source), ["alpha", "mid", "zeta"]);
    assert.equal(result.moved, 3);
    assert.deepEqual(result.before, ["zeta", "alpha", "mid"]);
    assert.deepEqual(result.after, ["alpha", "mid", "zeta"]);
    // 文件头（两行注释 + @string）一个字节都没动
    assert.ok(result.source.startsWith(HEADER));
    // @string 仍在原来的字符位置之前：注释块在条目之间原地留着
    assert.ok(result.source.includes("% 中文文献"));
    assert.ok(result.source.indexOf("@string") < result.source.indexOf("@book"));
  });

  test("by=year：year → author → key", () => {
    const result = sortBib(source, "year");
    assert.deepEqual(keys(result.source), ["alpha", "mid", "zeta"]);
  });

  test("同 key 的重复条目保持原顺序（稳定）", () => {
    const dup = "@article{dup, title = {First}}\n@article{dup, title = {Second}}\n";
    const result = sortBib(dup, "key");
    assert.equal(result.changed, false);
    assert.deepEqual(parseBibtex(result.source).entries.map((entry) => entry.title), ["First", "Second"]);
  });

  test("已经有序：changed=false，一个字都不改", () => {
    const ordered = "@article{a}\n@article{b}\n@article{c}\n";
    const result = sortBib(ordered, "key");
    assert.equal(result.changed, false);
    assert.equal(result.moved, 0);
    assert.equal(result.source, ordered);
  });

  test("坏条目 / @comment 留在原位，不参与排序", () => {
    const mixed = "@comment{keep}\n@article{b, title={B}}\n@book{a, title={A}}\n";
    const result = sortBib(mixed, "key");
    assert.ok(result.source.startsWith("@comment{keep}"));
    assert.deepEqual(keys(result.source), ["a", "b"]);
  });
});

describe("alignBib —— 等号对齐", () => {
  const source = `@article{a,
  title = {A},
  author = {X},
  year = {2020},
}
`;

  test("等号对齐到该条目最长字段名之后；值原样", () => {
    const result = alignBib(source);
    assert.equal(result.changed, true);
    const lines = result.source.split("\n");
    const columns = lines
      .filter((line) => line.includes("="))
      .map((line) => line.indexOf("="));
    assert.deepEqual(new Set(columns), new Set([9]));
    assert.ok(result.source.includes("title  = {A}"));
    assert.ok(result.source.includes("author = {X}"));
    assert.ok(result.source.includes("year   = {2020}"));
  });

  test("幂等：对齐过的文件再跑一次没有 diff", () => {
    const once = alignBib(source);
    const twice = alignBib(once.source);
    assert.equal(twice.source, once.source);
    assert.equal(twice.changed, false);
    assert.equal(twice.moved, 0);
  });

  test("跨行字段值 / 嵌套花括号里的 `xxx =` 不被当成字段", () => {
    const nested = `@article{a,
  title = {Line one
    and year = {not a field}},
  year = {2020},
}
`;
    const result = alignBib(nested);
    assert.ok(result.source.includes("title = {Line one"));
    assert.ok(result.source.includes("year  = {2020}"));
    // 值里的那一段原样保留（没有被补空格）
    assert.ok(result.source.includes("and year = {not a field}"));
  });

  test("CRLF 行尾原样保留", () => {
    const crlf = ["@article{a,", "  title = {A},", "  year = {2020},", "}"].join(String.fromCharCode(13, 10));
    const result = alignBib(crlf);
    assert.ok(result.source.includes(String.fromCharCode(13, 10)));
    assert.equal(result.source.split(String.fromCharCode(13, 10)).length, 4);
  });

  test("% 注释行不参与对齐，也没有被改写", () => {
    const commented = `@article{a,
% title = {commented out}
  title = {A},
  year = {2020},
}
`;
    const result = alignBib(commented);
    assert.ok(result.source.includes("% title = {commented out}"));
    assert.ok(result.source.includes("title = {A}"));
  });
});
