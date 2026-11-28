/**
 * .blg 解析：bibtex / biber 的真根因只在这一份里。
 *
 * bibtex 的夹具是本机 TeX Live 2025 真跑出来的 `main.blg` 原文（`refs.bib` 少一个
 * 花括号）；biber 的措辞**本机没有跑过**，按官方日志的 `INFO/WARN/ERROR - ` 前缀
 * 构造用例——解析必须是容错的，认不出的行不许读成 error。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseBlg } from "./parse-blg.ts";

const fixture = (name: string): string => readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8");

describe("parseBlg —— 真实 bibtex 日志", () => {
  test("Illegal end of database file：error + 文件名 + 数据库行号", () => {
    const issues = parseBlg(fixture("real-bibfail.blg.txt"));
    const first = issues[0];
    assert.ok(first !== undefined);
    assert.equal(first.kind, "error");
    assert.equal(first.file, "refs.bib");
    assert.equal(first.line, 5);
    assert.equal(first.code, "bib-error");
    assert.equal(first.source, "blg");
    assert.equal(first.step, "bibtex");
    assert.match(first.message, /Illegal end of database file/);
  });

  test("bibtex 的 Warning-- 收成 warning，不丢也不升成 error", () => {
    const issues = parseBlg(fixture("real-bibfail.blg.txt"));
    const warnings = issues.filter((issue) => issue.kind === "warning");
    assert.ok(warnings.length >= 5);
    assert.ok(warnings.every((issue) => issue.source === "blg" && issue.step === "bibtex"));
    assert.ok(issues.some((issue) => /empty author in levy2019/.test(issue.message)));
  });
});

describe("parseBlg —— 四类失败行", () => {
  test("打不开数据库文件：error、文件就是那个名字、code=missing-file", () => {
    const [issue] = parseBlg("I couldn't open database file nosuch.bib\n");
    assert.ok(issue !== undefined);
    assert.equal(issue.kind, "error");
    assert.equal(issue.file, "nosuch.bib");
    assert.equal(issue.code, "missing-file");
  });

  test("找不到条目：warning + citation-undefined（与 .log 里的 Citation undefined 同根）", () => {
    const [issue] = parseBlg('Warning--I didn\'t find a database entry for "levy2019"\n');
    assert.ok(issue !== undefined);
    assert.equal(issue.kind, "warning");
    assert.equal(issue.code, "citation-undefined");
    assert.match(issue.message, /levy2019/);
  });

  test("biber：WARN - / ERROR - 各自成条，INFO 不收（本机未实测，按前缀容错）", () => {
    const issues = parseBlg(
      [
        "INFO - This is Biber 2.19",
        "WARN - I didn't find a database entry for 'levy2019' (section 0)",
        "ERROR - Cannot find 'refs.bib'!",
      ].join("\n"),
    );
    assert.equal(issues.length, 2);
    assert.deepEqual(
      issues.map((issue) => issue.kind),
      ["warning", "error"],
    );
    assert.ok(issues.every((issue) => issue.source === "blg" && issue.step === "biber"));
    assert.equal(issues[0]?.code, "citation-undefined");
    assert.equal(issues[1]?.code, "bib-error");
    assert.match(issues[1]?.message ?? "", /^biber ERROR: Cannot find/);
  });

  test("空日志 / 纯样板行不报错", () => {
    assert.deepEqual(parseBlg(""), []);
    assert.deepEqual(parseBlg("This is BibTeX, Version 0.99d\nYou've used 1 entry,\n"), []);
  });

  test("同一行重复出现只留一条", () => {
    const issues = parseBlg(
      ["Illegal end of database file---line 5 of file refs.bib", "Illegal end of database file---line 5 of file refs.bib"].join("\n"),
    );
    assert.equal(issues.length, 1);
  });
});
