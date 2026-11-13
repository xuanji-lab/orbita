/**
 * 编译条纯逻辑的账：状态推导、PDF 过期判定、问题分组（含缺宏包识别）。
 * 夹具用 TeX 的真实日志写法（`! LaTeX Error: File \`ctexart.cls' not found.`），
 * 不是编造的占位串。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { LatexIssue } from "../../../../shared/latex.ts";
import {
  engineLabel,
  formatDuration,
  formatElapsed,
  groupLatexIssues,
  isFailedStatus,
  issueLocation,
  latexBarState,
  missingPackageOf,
  packageLabel,
  packageNoteKind,
  pdfStale,
  shortcutLabel,
} from "./latex-workbench.ts";

const issue = (kind: LatexIssue["kind"], file: string | null, line: number | null, message: string): LatexIssue => ({
  kind,
  file,
  line,
  message,
});

describe("latexBarState", () => {
  const base = { running: false, lastStatus: null, stale: false, hasPdf: true };

  test("running 压过一切（编译中按钮是取消）", () => {
    assert.equal(latexBarState({ ...base, running: true, lastStatus: "compile-error", stale: true }), "running");
  });

  test("还没编过、PDF 是最新的 → idle", () => {
    assert.equal(latexBarState(base), "idle");
  });

  test("源码比 PDF 新 → dirty（唯一的 accent 主操作）", () => {
    assert.equal(latexBarState({ ...base, stale: true }), "dirty");
  });

  test("成功且仍是最新的 → success", () => {
    assert.equal(latexBarState({ ...base, lastStatus: "ok" }), "success");
    assert.equal(latexBarState({ ...base, lastStatus: "warning-only" }), "success");
  });

  test("成功之后又改了源码 → dirty（success 让位给脏）", () => {
    assert.equal(latexBarState({ ...base, lastStatus: "ok", stale: true }), "dirty");
  });

  test("失败（含超时 / 没装 / 找不到主文件）→ error，即使源码也更新", () => {
    for (const status of ["compile-error", "timeout", "not-installed", "no-main-file"] as const) {
      assert.equal(latexBarState({ ...base, lastStatus: status, stale: true }), "error");
      assert.equal(isFailedStatus(status), true);
    }
    assert.equal(isFailedStatus("cancelled"), false);
  });

  test("取消不算失败：没有 PDF 时回 dirty（按钮继续可编）", () => {
    assert.equal(latexBarState({ ...base, lastStatus: "cancelled", stale: true, hasPdf: false }), "dirty");
    assert.equal(latexBarState({ ...base, lastStatus: "cancelled", hasPdf: true }), "idle");
  });
});

describe("pdfStale", () => {
  test("没有 PDF → 过期（编译是主操作）", () => {
    assert.equal(pdfStale(null, 1000), true);
  });

  test("源码比 PDF 新 → 过期；PDF 更新 → 不过期", () => {
    assert.equal(pdfStale(1000, 2000), true);
    assert.equal(pdfStale(2000, 1000), false);
    assert.equal(pdfStale(1000, 1000), false);
  });

  test("没有源码事实时不声称过期（宁可安静）", () => {
    assert.equal(pdfStale(1000, null), false);
    assert.equal(pdfStale(null, null), false);
  });
});

describe("missingPackageOf", () => {
  test("LaTeX 的标准写法（反引号 + 单引号）", () => {
    assert.deepEqual(missingPackageOf("! LaTeX Error: File `ctexart.cls' not found."), {
      missing: "ctexart.cls",
      packageName: "ctexart",
    });
  });

  test("样式包与带路径/版本的写法", () => {
    assert.deepEqual(missingPackageOf("File `booktabs.sty' not found."), {
      missing: "booktabs.sty",
      packageName: "booktabs",
    });
    assert.deepEqual(missingPackageOf("! LaTeX Error: File 'tcolorbox.sty' not found."), {
      missing: "tcolorbox.sty",
      packageName: "tcolorbox",
    });
  });

  test("缺字体不是缺宏包（tlmgr 装不了）", () => {
    assert.equal(missingPackageOf("Font T1-xxx not found"), null);
    assert.equal(missingPackageOf("LaTeX Warning: Citation `lewis2020' undefined"), null);
  });
});

describe("packageNoteKind —— 没查到包名的几种原因必须分开", () => {
  const entry = (patch: Partial<import("../../../../shared/latex.ts").LatexResolvedPackage>) => ({
    missing: "a.sty",
    packageName: null,
    command: null,
    sudo: false,
    installed: false,
    distro: null,
    reason: null,
    ...patch,
  });

  test("还在查（没有结果）≠ 查完了没查到", () => {
    assert.equal(packageNoteKind(undefined), "looking-up");
    assert.equal(packageNoteKind(entry({ reason: "not-found", distro: "texlive" })), "unknown");
  });

  test("文件名不合法不能被说成「没找到 tlmgr / mpm」", () => {
    assert.equal(packageNoteKind(entry({ reason: "invalid-name", distro: null })), "invalid-name");
    assert.equal(packageNoteKind(entry({ reason: "no-tools", distro: null })), "no-tools");
    assert.equal(packageNoteKind(entry({ reason: "tool-error", distro: "texlive" })), "tool-error");
    assert.equal(packageNoteKind(entry({ reason: "not-looked-up" })), "not-looked-up");
  });

  test("有包名就补第二行；本机已有时优先说「已能定位到」", () => {
    assert.equal(packageNoteKind(entry({ packageName: "ctex", reason: null })), "none");
    assert.equal(
      packageNoteKind(entry({ packageName: "ctex", installed: true, reason: null })),
      "installed",
    );
    // 本机已有、但反查也失败：先说「本机已能定位到这个文件」，原因不重要
    assert.equal(packageNoteKind(entry({ installed: true, reason: "no-tools" })), "installed");
  });
});

describe("packageLabel", () => {
  test("反查命中就用包名（文件名不是包名）", () => {
    assert.equal(packageLabel("ctexart.cls", "ctex"), "ctex");
  });

  test("没命中就如实显示文件名（不把文件名冒充成包名）", () => {
    assert.equal(packageLabel("doesnotexistxyz.sty", null), "doesnotexistxyz.sty");
    assert.equal(packageLabel("booktabs.sty", ""), "booktabs.sty");
  });
});

describe("groupLatexIssues", () => {
  const errors = [
    issue("error", "main.tex", 24, "Undefined control sequence: \\citep"),
    issue("error", "main.tex", 1, "! LaTeX Error: File `ctexart.cls' not found."),
  ];
  const warnings = [
    issue("warning", "main.tex", 24, "Citation 'lewis2020retrieval' on page 1 undefined"),
    issue("layout", "main.tex", 41, "Overfull \\hbox (12.4pt too wide) in paragraph"),
    issue("warning", "main.tex", 3, "File `booktabs.sty' not found."),
  ];

  test("错误 / 告警 / 版式 / 缺宏包各归各位", () => {
    const groups = groupLatexIssues(errors, warnings);
    assert.deepEqual(groups.errors.map((item) => item.message), ["Undefined control sequence: \\citep"]);
    assert.equal(groups.warnings.length, 1);
    assert.equal(groups.layout.length, 1);
    assert.deepEqual(groups.packages.map((item) => item.packageName).sort(), ["booktabs", "ctexart"]);
  });

  test("计数：错误含缺宏包，告警不含版式", () => {
    const groups = groupLatexIssues(errors, warnings);
    assert.equal(groups.errorCount, 3);
    assert.equal(groups.warningCount, 1);
  });

  test("同一个缺包出现两遍只列一次", () => {
    const groups = groupLatexIssues(
      [issue("error", "main.tex", 1, "File `ctexart.cls' not found.")],
      [issue("warning", "main.tex", 1, "File `ctexart.cls' not found.")],
    );
    assert.equal(groups.packages.length, 1);
  });

  test("空输入 = 干净（抽屉显示「无问题」）", () => {
    const groups = groupLatexIssues([], []);
    assert.deepEqual(groups, {
      errors: [],
      warnings: [],
      layout: [],
      packages: [],
      pending: [],
      errorCount: 0,
      warningCount: 0,
    });
  });

  test("MiKTeX 在等确认的行单独成组，不算告警（编译卡住 ≠ 告警）", () => {
    const groups = groupLatexIssues(
      [],
      [
        issue("warning", null, null, "miktex-makepk: The package foo wants to be installed."),
        issue("warning", "main.tex", 4, "Citation 'x' undefined"),
      ],
    );
    assert.equal(groups.pending.length, 1);
    assert.equal(groups.warnings.length, 1);
    assert.equal(groups.warningCount, 1);
  });
});

describe("展示辅助", () => {
  test("用时一位小数", () => {
    assert.equal(formatDuration(3900), "3.9 s");
    assert.equal(formatDuration(60_000), "60.0 s");
  });

  test("编译中的计时是 m:ss", () => {
    assert.equal(formatElapsed(0), "0:00");
    assert.equal(formatElapsed(3900), "0:03");
    assert.equal(formatElapsed(72_000), "1:12");
  });

  test("引擎名：契约的 pdf = pdflatex", () => {
    assert.equal(engineLabel("pdf"), "pdflatex");
    assert.equal(engineLabel("xelatex"), "xelatex");
    assert.equal(shortcutLabel("darwin"), "Cmd+B");
    assert.equal(shortcutLabel("win32"), "Ctrl+B");
  });

  test("问题定位退化：只有文件 / 只有行 / 都没有", () => {
    assert.equal(issueLocation({ file: "main.tex", line: 24 }), "main.tex:24");
    assert.equal(issueLocation({ file: "main.tex", line: null }), "main.tex");
    assert.equal(issueLocation({ file: null, line: 7 }), "7");
    assert.equal(issueLocation({ file: null, line: null }), "");
  });
});
