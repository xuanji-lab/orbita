/**
 * 多文件导航的账：包含图的节点 / 边 / 反向 owners、三段路径解析顺序、行号与参数列
 * （Ctrl+单击 的判定依据）、未解析的边、环与深度 / 文件数上限、以及每个文件的章节。
 *
 * 夹具都是真实论文里会出现的写法（`\input{sec/ch1}` 不带后缀、`\include`、
 * 注释掉的包含行）；上限那一组用**注入的假盘**——造 2100 个真实文件只为撞一次
 * 上限，既慢又没信息。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildLatexNav } from "./nav.ts";
import { includeRefs, type IncludeDeps } from "./includes.ts";

function withProject(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "orbita-latex-nav-"));
  build(dir);
  return dir;
}

/** 写一份文件（自动建目录） */
function write(dir: string, name: string, text: string): void {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
}

/** 注入的假盘：只认这几份文件 */
function fakeDeps(files: Map<string, string>): IncludeDeps {
  const key = (path: string): string => {
    const normalized = resolve(path);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const index = new Map<string, string>();
  for (const [path, text] of files) index.set(key(path), text);
  return {
    exists: (path) => index.has(key(path)),
    read: (path) => index.get(key(path)) ?? "",
    size: (path) => {
      const text = index.get(key(path));
      return text === undefined ? null : text.length;
    },
  };
}

const byDisplay = <T extends { display: string }>(files: readonly T[]): string[] =>
  files.map((file) => file.display).sort();

describe("includeRefs", () => {
  test("行号与参数列：Ctrl/Cmd+单击 的判定依据", () => {
    const text = ["\\documentclass{article}", "  \\input{sec/ch1}", "text"].join("\n");
    assert.deepEqual(includeRefs(text), [
      { command: "input", raw: "sec/ch1", line: 2, argFrom: 9, argTo: 16 },
    ]);
  });

  test("input / include / subfile 都认；注释掉的不算", () => {
    const text = [
      "% \\input{gone}",
      "\\include{ch1}",
      "\\subfile{parts/p}",
      "\\input{sections/ch2.tex}",
    ].join("\n");
    assert.deepEqual(
      includeRefs(text).map((ref) => `${ref.line}:${ref.command}:${ref.raw}`),
      ["2:include:ch1", "3:subfile:parts/p", "4:input:sections/ch2.tex"],
    );
  });

  test("宏体里的 \\input{#1} 是占位符：认出来但不算目标", () => {
    assert.deepEqual(includeRefs("\\newcommand{\\x}{\\input{#1}}").map((ref) => ref.raw), ["#1"]);
  });
});

describe("buildLatexNav", () => {
  test("嵌套包含：边、反向 owners、属于哪个 root、章节都上了图", () => {
    const dir = withProject((root) => {
      write(root, "main.tex", [
        "\\documentclass{article}",
        "\\begin{document}",
        "\\input{sec/abstract}",
        "\\section{Intro}",
        "\\input{sections/ch1}",
        "\\end{document}",
      ].join("\n"));
      write(root, "sec/abstract.tex", "\\section*{Abstract}\n");
      write(root, "sections/ch1.tex", "\\section{Method}\n\\input{ch1-detail}\n");
      write(root, "sections/ch1-detail.tex", "\\subsection{Detail}\n");
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "main.tex")], { file: join(dir, "sections/ch1.tex") });
      assert.equal(nav.root, "main.tex");
      assert.equal(nav.rootPath, join(dir, "main.tex"));
      assert.deepEqual(nav.focusRoots, ["main.tex"]);
      assert.deepEqual(byDisplay(nav.files), [
        "main.tex",
        "sec/abstract.tex",
        "sections/ch1-detail.tex",
        "sections/ch1.tex",
      ]);
      assert.equal(nav.truncated, false);
      assert.deepEqual(nav.limits, []);

      const main = nav.files.find((file) => file.display === "main.tex");
      assert.ok(main !== undefined);
      assert.deepEqual(
        main.includes.map((edge) => `${edge.line}:${edge.command}:${edge.raw}:${edge.target === null ? "-" : "ok"}`),
        ["3:input:sec/abstract:ok", "5:input:sections/ch1:ok"],
      );
      // 不带 .tex 也要补成 sections/ch1.tex
      assert.equal(main.includes[1]?.target, join(dir, "sections", "ch1.tex"));

      const detail = nav.files.find((file) => file.display === "sections/ch1-detail.tex");
      assert.ok(detail !== undefined);
      assert.deepEqual(detail.owners, [join(dir, "sections", "ch1.tex")]);
      assert.deepEqual(detail.roots, ["main.tex"]);

      const ch1 = nav.files.find((file) => file.display === "sections/ch1.tex");
      assert.ok(ch1 !== undefined);
      assert.deepEqual(ch1.owners, [join(dir, "main.tex")]);
      assert.deepEqual(ch1.sections, [{ command: "section", title: "Method", level: 2, line: 1 }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("路径解析三段：root 所在目录 → 包含者所在目录 → 项目目录", () => {
    const dir = withProject((root) => {
      // root 在 paper/ 里；同名文件在 root 目录与项目根各有一份 → root 目录那份赢
      write(root, "paper/main.tex", "\\input{shared/x}\n\\input{chapters/a}\n");
      write(root, "paper/shared/x.tex", "x in paper/shared\n");
      write(root, "shared/x.tex", "x in project/shared\n");
      // 只在包含者所在目录里有的文件（既不在 root 目录，也不在项目根）
      write(root, "paper/chapters/a.tex", "\\input{only-in-chapters}\n\\input{top}\n");
      write(root, "paper/chapters/only-in-chapters.tex", "a\n");
      // 只在项目根里有的文件
      write(root, "top.tex", "\\input{elsewhere}\n");
      write(root, "elsewhere.tex", "e\n");
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "paper", "main.tex")], { file: join(dir, "paper", "main.tex") });
      const target = (display: string, index: number): string | null => {
        const file = nav.files.find((candidate) => candidate.display === display);
        return file?.includes[index]?.target ?? null;
      };
      // root 目录优先于项目目录
      assert.equal(target("paper/main.tex", 0), join(dir, "paper", "shared", "x.tex"));
      assert.equal(target("paper/chapters/a.tex", 0), join(dir, "paper", "chapters", "only-in-chapters.tex"));
      // 前两段都没有 → 项目目录
      assert.equal(target("top.tex", 0), join(dir, "elsewhere.tex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("找不到就记 unresolved（target null），不瞎猜", () => {
    const dir = withProject((root) => {
      write(root, "main.tex", "\\input{nope/ghost}\n\\include{also-missing.tex}\n");
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "main.tex")]);
      const main = nav.files.find((file) => file.display === "main.tex");
      assert.ok(main !== undefined);
      assert.deepEqual(main.includes.map((edge) => edge.target), [null, null]);
      assert.deepEqual(byDisplay(nav.files), ["main.tex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("环 A→B→A：不展开第二圈，记进 limits", () => {
    const dir = withProject((root) => {
      write(root, "a.tex", "\\input{b}\n");
      write(root, "b.tex", "\\input{a}\n");
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "a.tex")]);
      assert.equal(nav.truncated, true);
      assert.deepEqual(
        nav.limits.map((limit) => `${limit.kind}:${limit.at === join(dir, "a.tex") ? "a.tex" : limit.at}`),
        ["cycle:a.tex"],
      );
      const b = nav.files.find((file) => file.display === "b.tex");
      assert.ok(b !== undefined);
      // 边指向目标（能标出类型），只是不再往下展开
      assert.equal(b.includes[0]?.target, join(dir, "a.tex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("深度上限 8 层：第 9 条边不再展开，记进 limits", () => {
    const dir = withProject((root) => {
      for (let i = 0; i < 12; i += 1) write(root, `c${i}.tex`, `\\input{c${i + 1}}\n`);
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "c0.tex")]);
      assert.equal(nav.truncated, true);
      assert.deepEqual(nav.limits.map((limit) => `${limit.kind}:${limit.at.endsWith("c9.tex") ? "c9" : limit.at}`), [
        "depth:c9",
      ]);
      // root + c1 … c9：c9 会被收进图（它的边指向它、能打开），但它自己的包含不再展开
      assert.equal(nav.files.length, 10);
      const edge = nav.files.find((file) => file.display === "c9.tex");
      assert.ok(edge !== undefined);
      assert.deepEqual(edge.includes, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("文件数上限 2000：多出来的不再进图（假盘，不造两千个真文件）", () => {
    const files = new Map<string, string>();
    const dir = resolve("/fake/project");
    const includes = Array.from({ length: 2100 }, (_, i) => `\\input{f${i}}`).join("\n");
    files.set(join(dir, "main.tex"), includes);
    for (let i = 0; i < 2100; i += 1) files.set(join(dir, `f${i}.tex`), "");
    const nav = buildLatexNav(dir, [join(dir, "main.tex")], { file: join(dir, "main.tex") }, fakeDeps(files));
    assert.equal(nav.files.length, 2000);
    assert.equal(nav.truncated, true);
    const nodeLimit = nav.limits.find((limit) => limit.kind === "nodes");
    assert.ok(nodeLimit !== undefined);
  });

  test("两个 root 都包含同一个文件：focusRoots 全列，root 取第一个", () => {
    const dir = withProject((root) => {
      write(root, "paper.tex", "\\input{shared/intro}\n");
      write(root, "appendix.tex", "\\input{shared/intro}\n");
      write(root, "shared/intro.tex", "\\section{Shared}\n");
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "paper.tex"), join(dir, "appendix.tex")], {
        file: join(dir, "shared", "intro.tex"),
      });
      assert.deepEqual(nav.focusRoots, ["paper.tex", "appendix.tex"]);
      assert.equal(nav.root, "paper.tex");
      const intro = nav.files.find((file) => file.display === "shared/intro.tex");
      assert.ok(intro !== undefined);
      assert.deepEqual(intro.owners.sort(), [join(dir, "appendix.tex"), join(dir, "paper.tex")].sort());
      assert.deepEqual(intro.roots.sort(), ["appendix.tex", "paper.tex"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("当前文件不属于任何 root：root 为 null（调用方退回单文件大纲）", () => {
    const dir = withProject((root) => {
      write(root, "main.tex", "\\input{sec/a}\n");
      write(root, "sec/a.tex", "a\n");
      write(root, "notes.tex", "scratch\n");
    });
    try {
      const nav = buildLatexNav(dir, [join(dir, "main.tex")], { file: join(dir, "notes.tex") });
      assert.equal(nav.root, null);
      assert.equal(nav.rootPath, null);
      assert.deepEqual(nav.focusRoots, []);
      assert.ok(nav.files.some((file) => file.display === "main.tex"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("没有 root（项目只有零散片段）：空图、不报错", () => {
    const dir = withProject((root) => {
      write(root, "notes.tex", "\\section{Scratch}\n");
    });
    try {
      const nav = buildLatexNav(dir, [], { file: join(dir, "notes.tex") });
      assert.deepEqual(nav.files, []);
      assert.equal(nav.root, null);
      assert.equal(nav.truncated, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
