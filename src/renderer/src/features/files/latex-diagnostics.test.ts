/**
 * 行内诊断映射的账：只画本文件、只画 error / warning、一行一条。
 * 路径夹具模拟真实来源（日志给相对路径，面板给 Windows 绝对路径）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LatexIssue } from "../../../../shared/latex.ts";
import { inlineDiagnostics, issueAbsolutePath, lineStarts } from "./latex-diagnostics.ts";

const issue = (file: string | null, line: number | null, kind: LatexIssue["kind"], message: string): LatexIssue => ({
  file,
  line,
  kind,
  message,
});

describe("lineStarts", () => {
  test("每行起点 + 末行", () => {
    assert.deepEqual(lineStarts("ab\ncd\n"), [0, 3, 6]);
    assert.deepEqual(lineStarts(""), [0]);
  });
});

describe("issueAbsolutePath", () => {
  test("相对路径拼项目目录；绝对路径原样", () => {
    assert.equal(issueAbsolutePath("C:\\paper", "sections/intro.tex"), "C:\\paper/sections/intro.tex");
    assert.equal(issueAbsolutePath("/paper/", "./main.tex"), "/paper/main.tex");
    assert.equal(issueAbsolutePath("/paper", "D:/other/x.tex"), "D:/other/x.tex");
  });
});

describe("inlineDiagnostics", () => {
  const doc = "line one\nline two\nline three\n";

  test("只保留本文件的问题，行号转成字符区间", () => {
    const out = inlineDiagnostics(
      [
        issue("main.tex", 2, "error", "Undefined control sequence."),
        issue("sections/intro.tex", 1, "error", "其他文件"),
      ],
      doc,
      "/paper/main.tex",
      "/paper",
    );
    assert.deepEqual(out, [{ from: 9, to: 17, severity: "error", message: "Undefined control sequence." }]);
  });

  test("Windows 路径大小写与反斜杠都能对上", () => {
    const out = inlineDiagnostics(
      [issue("Main.TEX", 1, "warning", "Font shape undefined")],
      doc,
      "C:\\Paper\\Main.TEX",
      "C:\\Paper",
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.severity, "warning");
  });

  test("layout 不画（Overfull 会把整篇涂满）", () => {
    assert.deepEqual(inlineDiagnostics([issue("main.tex", 1, "layout", "Overfull \\hbox (12pt too wide)")], doc, "/paper/main.tex", "/paper"), []);
  });

  test("没有文件 / 行号的问题不画；越界行号不画", () => {
    const out = inlineDiagnostics(
      [
        issue(null, 1, "error", "x"),
        issue("main.tex", null, "error", "y"),
        issue("main.tex", 99, "error", "z"),
      ],
      doc,
      "/paper/main.tex",
      "/paper",
    );
    assert.deepEqual(out, []);
  });

  test("同一行同一条消息只画一次；空行不画", () => {
    const out = inlineDiagnostics(
      [
        issue("main.tex", 2, "error", "same"),
        issue("main.tex", 2, "error", "same"),
        issue("main.tex", 3, "error", "empty line"),
      ],
      "a\nb\n\nc",
      "/paper/main.tex",
      "/paper",
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.message, "same");
  });
});
