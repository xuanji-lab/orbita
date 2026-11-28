/**
 * .log 解析的回归网。
 *
 * **夹具是本机 TeX Live 2025 真跑出来的整份 .log 原文**（不是手写摘要）：缺 `$`、
 * 缺包、`\input` 子文件里的错各一份，外加一份成功日志。手写日志只能测到解析器
 * 自己假设的形态——上一版就是用它测 `! Undefined control sequence.`，而
 * `-file-line-error` 开着时真实日志写的是 `./chapters/two.tex:2: Undefined control sequence.`
 * （评审 B1：整条错被丢掉）。
 *
 * 夹具名是 `*.log.txt` 而不是 `*.log`：仓的 .gitignore 把 `*.log` 当运行产物忽略，
 * 叫 `*.log` 会被静默吞掉（AGENTS.md 工程陷阱史 #1）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasContentWarnings, parseLatexLog } from "./parse-log.ts";

const fixture = (name: string): string => readFileSync(new URL(`./testdata/${name}`, import.meta.url), "utf8");

/** 所有 issue 的 file 都不许带 `./` 前缀（模型拿它拼路径） */
function assertNoDotSlash(issues: readonly { file: string | null }[]): void {
  for (const issue of issues) {
    if (issue.file !== null) assert.ok(!issue.file.startsWith("./"), `file 带了 ./：${issue.file}`);
  }
}

describe("parseLatexLog —— 真实成功日志", () => {
  test("无错、1 页、产物路径来自 Output written", () => {
    const parsed = parseLatexLog(fixture("real-success.log.txt"));
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.warnings, []);
    assert.equal(parsed.pages, 1);
    assert.equal(parsed.output, "build/main.pdf");
  });
});

describe("parseLatexLog —— -file-line-error 的真实错误（B1）", () => {
  test("缺 $：`./main.tex:4: Missing $ inserted.` 进 errors，file 不带 ./", () => {
    const parsed = parseLatexLog(fixture("real-missing-dollar.log.txt"));
    const first = parsed.errors[0];
    assert.ok(first !== undefined, "缺 $ 的错误被整条丢掉了");
    assert.equal(first.file, "main.tex");
    assert.equal(first.line, 4);
    assert.equal(first.kind, "error");
    assert.match(first.message, /^Missing \$ inserted\.$/);
    // TeX 在 nonstopmode 下带着错继续排版，PDF 仍然产出（页数来自同一份日志）
    assert.equal(parsed.pages, 1);
    assert.equal(parsed.output, "build/main.pdf");
    assertNoDotSlash(parsed.errors);
    assertNoDotSlash(parsed.warnings);
  });

  test("嵌套 \\input 里的错归属到子文件", () => {
    const parsed = parseLatexLog(fixture("real-subfile-error.log.txt"));
    const first = parsed.errors[0];
    assert.ok(first !== undefined, "子文件里的 Undefined control sequence 被丢掉了");
    assert.equal(first.file, "chapters/two.tex");
    assert.equal(first.line, 2);
    assert.match(first.message, /Undefined control sequence/);
    assertNoDotSlash(parsed.errors);
  });

  test("缺包：文件来自括号栈、行号用同文件后续定位点", () => {
    const parsed = parseLatexLog(fixture("real-missing-package.log.txt"));
    const first = parsed.errors[0];
    assert.ok(first !== undefined);
    assert.equal(first.file, "main.tex");
    assert.equal(first.line, 3);
    assert.match(first.message, /not-a-real-pkg\.sty/);
    assert.equal(parsed.pages, null);
    assert.equal(parsed.output, null);
    assert.ok(parsed.errors.some((issue) => /Fatal error/.test(issue.message)));
    assertNoDotSlash(parsed.errors);
  });

  test("同一行带 Warning 的 file:line 归 warning，不归 error", () => {
    const parsed = parseLatexLog(
      "./main.tex:12: LaTeX Warning: Reference `fig:one' on page 1 undefined on input line 12.\n",
    );
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.warnings.length, 1);
    assert.equal(parsed.warnings[0]?.file, "main.tex");
    assert.equal(parsed.warnings[0]?.line, 12);
    assert.equal(parsed.warnings[0]?.kind, "warning");
  });
});

describe("parseLatexLog —— 边界", () => {
  test("超时被杀的半截日志：能读什么就读什么，不报出假页数", () => {
    const parsed = parseLatexLog(fixture("timeout-partial.log.txt"));
    assert.equal(parsed.pages, null);
    assert.equal(parsed.output, null);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.warnings, []);
  });

  test("去重：同一行错在多轮里重复出现只留一条", () => {
    const log = [
      "./main.tex:4: Missing $ inserted.",
      "./main.tex:4: Missing $ inserted.",
      "./main.tex:4: Missing $ inserted.",
    ].join("\n");
    assert.equal(parseLatexLog(log).errors.length, 1);
  });

  test("上限：layout 独立计数 50，超出的进 omitted（不再挤爆结果）", () => {
    const lines: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      lines.push(`Overfull \\hbox (1.0pt too wide) in paragraph at lines ${index + 1}--${index + 2}`);
    }
    const parsed = parseLatexLog(lines.join("\n"));
    assert.equal(parsed.warnings.length, 50);
    assert.equal(parsed.warnings[49]?.line, 50);
    assert.deepEqual(parsed.omitted, { errors: 0, warnings: 0, layout: 450 });
  });

  test("版式告警不算「值得停一下」的告警", () => {
    const layoutOnly = parseLatexLog(
      "Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--4\nOutput written on build/main.pdf (1 page, 100 bytes).\n",
    );
    assert.equal(layoutOnly.errors.length, 0);
    assert.equal(hasContentWarnings(layoutOnly.warnings), false);
    assert.equal(layoutOnly.pages, 1);
    assert.equal(hasContentWarnings(parseLatexLog("./main.tex:2: LaTeX Warning: X undefined.\n").warnings), true);
  });

  test("空日志与纯噪声不报错", () => {
    for (const log of ["", "This is pdfTeX, Version 3.14\nentering extended mode\n"]) {
      const parsed = parseLatexLog(log);
      assert.deepEqual(parsed.errors, []);
      assert.deepEqual(parsed.warnings, []);
      assert.deepEqual(parsed.diagnostics, []);
      assert.deepEqual(parsed.omitted, { errors: 0, warnings: 0, layout: 0 });
      assert.deepEqual(parsed.outputs, []);
      assert.equal(parsed.pages, null);
      assert.equal(parsed.output, null);
    }
  });

  test("缺字体与 Missing character 算 warning，不算 layout", () => {
    const parsed = parseLatexLog(
      [
        "Missing character: There is no 中 (U+4E2D) in font [lmroman10-regular]:mapping=tex-text!",
        "LaTeX Font Warning: Font shape `T1/cmr/m/n' undefined",
        "Font \\foo not loadable",
      ].join("\n"),
    );
    assert.equal(parsed.errors.length, 0);
    assert.equal(parsed.warnings.length, 3);
    assert.ok(parsed.warnings.every((issue) => issue.kind === "warning"));
  });

  test("MiKTeX 在等用户确认的行不能丢（抽屉靠它说「引擎卡在等你」）", () => {
    const parsed = parseLatexLog(
      [
        "miktex-makepk: The package foo wants to be installed.",
        "Do you want to install the package `foo'?",
        "! LaTeX Error: File `foo.sty' not found.",
      ].join("\n"),
    );
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.warnings.length, 2);
  });
});

describe("parseLatexLog —— 多条 Output written（多产物）", () => {
  test("每一次写出都留一条；pages / output 镜像最后一条", () => {
    const parsed = parseLatexLog(
      [
        "Output written on build/main.pdf (8 pages, 123456 bytes).",
        "Output written on build/appendix.pdf (2 pages, 4000 bytes).",
      ].join("\n"),
    );
    assert.deepEqual(parsed.outputs, [
      { path: "build/main.pdf", pages: 8, bytes: 123456 },
      { path: "build/appendix.pdf", pages: 2, bytes: 4000 },
    ]);
    assert.equal(parsed.pages, 2);
    assert.equal(parsed.output, "build/appendix.pdf");
  });

  test("没有 bytes 的旧写法也算一条（bytes 为 null）", () => {
    const parsed = parseLatexLog("Output written on main.pdf (1 page).");
    assert.deepEqual(parsed.outputs, [{ path: "main.pdf", pages: 1, bytes: null }]);
  });
});

describe("parseLatexLog —— 折行续行（真实字体 / 缺图日志）", () => {
  test("fontspec 的两行错误拼回一句，code=font-missing，raw 带 l.N", () => {
    const parsed = parseLatexLog(fixture("real-missing-font.log.txt"));
    const first = parsed.errors[0];
    assert.ok(first !== undefined, "字体错误被整条丢掉了");
    // 旧解析器只吃单行：第一行是 `Package fontspec Error: `，消息于是变成空串
    assert.match(first.message, /The font "NoSuchFontAvailable" cannot be found/);
    assert.equal(first.code, "font-missing");
    assert.match(first.raw ?? "", /l\.4/);
    // 79 列硬折行也要拼回：`… at 1` + `0.0pt not loadable`
    assert.ok(
      parsed.errors.some((issue) => /at 10\.0pt not loadable/.test(issue.message)),
      "79 列硬折行的半句没有拼回",
    );
  });

  test("缺图：79 列折断的 `using draft setting.` 拼回整句", () => {
    const parsed = parseLatexLog(fixture("real-missing-figure.log.txt"));
    const issue = parsed.errors.find((entry) => /fig\.pdf/.test(entry.message));
    assert.ok(issue !== undefined);
    assert.match(issue.message, /using draft setting\.$/);
    assert.equal(issue.code, "missing-file");
  });
});

describe("parseLatexLog —— 上限按 kind 独立", () => {
  test("210 条 Overfull + 1 条 Citation undefined：引用仍在，状态判据仍为 warning", () => {
    const lines: string[] = [];
    for (let index = 0; index < 210; index += 1) {
      // String.raw：这里要的是 TeX 日志里的字面 \hbox，不能让它被模板字面量转义掉
      lines.push(String.raw`Overfull \hbox (1.0pt too wide) in paragraph at lines ${index + 1}--${index + 2}`);
    }
    lines.push("./main.tex:12: LaTeX Warning: Citation `levy2019' on page 1 undefined on input line 12.");
    const parsed = parseLatexLog(lines.join("\n"));

    const citation = parsed.diagnostics.find((issue) => issue.code === "citation-undefined");
    assert.ok(citation !== undefined, "210 条 Overfull 把「引用未定义」整条挤掉了");
    assert.equal(citation.kind, "warning");
    // 这条是 status 判据：layout 被截断不影响它
    assert.equal(hasContentWarnings(parsed.warnings), true);
    assert.equal(parsed.omitted.layout, 160);
    assert.equal(parsed.omitted.warnings, 0);
    assert.equal(parsed.errors.length, 0);
  });

  test("warning 与 layout 各有各的 200 / 50，互不挤占", () => {
    const lines: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      lines.push(String.raw`Overfull \hbox (1.0pt too wide) in paragraph at lines ${index + 1}--${index + 2}`);
    }
    for (let index = 0; index < 205; index += 1) {
      lines.push(`./main.tex:${index + 1}: LaTeX Warning: Reference \`r${index}' on page 1 undefined on input line ${index + 1}.`);
    }
    const parsed = parseLatexLog(lines.join("\n"));
    assert.equal(parsed.omitted.layout, 10);
    assert.equal(parsed.omitted.warnings, 5);
    assert.equal(parsed.warnings.filter((issue) => issue.kind === "layout").length, 50);
    assert.equal(parsed.warnings.filter((issue) => issue.kind === "warning").length, 200);
  });
});

describe("parseLatexLog —— raw 预算", () => {
  test("raw 只给前 5 条 error", () => {
    const lines: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      lines.push(`./main.tex:${index + 1}: Undefined control sequence.`, `l.${index + 1} foo`);
    }
    const parsed = parseLatexLog(lines.join("\n"));
    assert.equal(parsed.errors.length, 7);
    assert.equal(parsed.errors.filter((issue) => issue.raw !== null).length, 5);
    assert.equal(parsed.errors[5]?.raw, null);
  });
});
