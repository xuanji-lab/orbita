/**
 * 项目探测 / 项目描述的账：从文件往上找到最近的项目、多 .tex 时不瞎猜、写配置
 * 不抹掉用户手写的字段。夹具在临时目录里现造（真 fs，不 mock——这条路径本来就是
 * 读盘的）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeLatexProject, findLatexProjectDir, writeLatexProjectConfig } from "./project.ts";

function withProject(build: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "orbita-latex-project-"));
  build(dir);
  return dir;
}

describe("findLatexProjectDir", () => {
  test("从子目录里的 .tex 往上找到带 \\documentclass 的顶层", () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, "sections"));
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}x\\end{document}\n");
      writeFileSync(join(dir, "sections", "intro.tex"), "intro\n");
    });
    try {
      assert.equal(findLatexProjectDir(join(root, "sections", "intro.tex"), root), root);
      assert.equal(findLatexProjectDir(join(root, "main.tex"), root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("只有零散 .tex（没有 \\documentclass、没有配置）不算项目", () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "notes.tex"), "some notes, no document class\n");
    });
    try {
      assert.equal(findLatexProjectDir(join(root, "notes.tex"), root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test(".orbita/latex.json 就是项目（用户显式指定过）", () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, ".orbita"));
      writeFileSync(join(dir, ".orbita", "latex.json"), "{}\n");
      writeFileSync(join(dir, "paper.txt"), "x\n");
    });
    try {
      assert.equal(findLatexProjectDir(join(root, "paper.txt"), root), root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("不越出白名单根：项目在上层，根以内的文件找不到项目", () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
      mkdirSync(join(dir, "scoped"));
      writeFileSync(join(dir, "scoped", "note.txt"), "x\n");
    });
    try {
      const scoped = join(root, "scoped");
      assert.equal(findLatexProjectDir(join(scoped, "note.txt"), scoped), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("describeLatexProject", () => {
  test("main.tex + 中文文档类 → xelatex（自动），PDF 与源码 mtime 都报出来", () => {
    const root = withProject((dir) => {
      writeFileSync(
        join(dir, "main.tex"),
        "\\documentclass{ctexart}\n\\begin{document}你好\\end{document}\n",
      );
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "main.pdf"), "%PDF-1.4\n");
    });
    try {
      const project = describeLatexProject(root);
      assert.equal(project.dir, root);
      assert.equal(project.main, "main.tex");
      assert.equal(project.engine, "xelatex");
      assert.equal(project.engineSource, "auto");
      assert.equal(project.pdf?.path, join(root, "build", "main.pdf"));
      assert.ok(project.pdf !== null && project.pdf.modifiedAt > 0);
      assert.ok(project.sourceModifiedAt !== null);
      assert.equal(project.detail, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("多个 .tex 且没有 main.tex：不猜主文件，列出候选并给原因", () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "intro.tex"), "\\documentclass{article}\n");
      writeFileSync(join(dir, "method.tex"), "\\documentclass{article}\n");
    });
    try {
      const project = describeLatexProject(root);
      assert.equal(project.main, null);
      assert.deepEqual(project.mains, ["intro.tex", "method.tex"]);
      assert.ok(project.detail !== null && project.detail.includes("main.tex"));
      assert.equal(project.pdf, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("配置里的引擎优先于自动判断，并标成 config", () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, ".orbita"));
      writeFileSync(join(dir, ".orbita", "latex.json"), JSON.stringify({ engine: "lualatex" }));
      writeFileSync(join(dir, "main.tex"), "\\documentclass{ctexart}\n");
    });
    try {
      const project = describeLatexProject(root);
      assert.equal(project.engine, "lualatex");
      assert.equal(project.engineSource, "config");
      assert.equal(project.configured.engine, "lualatex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("writeLatexProjectConfig", () => {
  test("合并写入：用户手写的 outDir / args 不被 chip 点击抹掉", async () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, ".orbita"));
      writeFileSync(
        join(dir, ".orbita", "latex.json"),
        JSON.stringify({ outDir: "out", args: ["-shell-escape"] }),
      );
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
    });
    try {
      await writeLatexProjectConfig(root, { engine: "xelatex" });
      const saved = JSON.parse(readFileSync(join(root, ".orbita", "latex.json"), "utf8")) as Record<string, unknown>;
      // v1 的项目级 outDir / args 迁到 roots[0]；写回只产出 v2（不再有顶层 main / outDir）
      assert.deepEqual(saved, {
        version: 2,
        activeRoot: "main.tex",
        roots: [{ path: "main.tex", outDir: "out", args: ["-shell-escape"], engine: "xelatex" }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("选配方：写进当前 root 的 recipeId，并清掉同 root 的自定义 recipe", async () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, ".orbita"));
      writeFileSync(
        join(dir, ".orbita", "latex.json"),
        JSON.stringify({
          roots: [{ path: "main.tex", recipe: ["latexmk", "-xelatex"] }],
          activeRoot: "main.tex",
        }),
      );
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
    });
    try {
      await writeLatexProjectConfig(root, {
        activate: "main.tex",
        root: { path: "main.tex", recipeId: "latexmk-makeindex" },
      });
      const saved = JSON.parse(readFileSync(join(root, ".orbita", "latex.json"), "utf8")) as {
        roots: { path: string; recipeId?: string; recipe?: string[] }[];
      };
      // 两条配方同时留在文件里，下次读的人无法判断哪条生效——预设赢，自定义被清掉
      assert.deepEqual(saved.roots, [{ path: "main.tex", recipeId: "latexmk-makeindex" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("未知的配方 id 拒绝写入（拼错的 id 只会在编译时静默退回默认链）", async () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
    });
    try {
      await assert.rejects(
        writeLatexProjectConfig(root, { root: { path: "main.tex", recipeId: "nope" } }),
        /Unknown recipe preset/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("拒绝绝对路径 / 带 .. / 非 .tex 的主文件", async () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
    });
    try {
      await assert.rejects(() => writeLatexProjectConfig(root, { main: "/etc/passwd" }));
      await assert.rejects(() => writeLatexProjectConfig(root, { main: "../x.tex" }));
      await assert.rejects(() => writeLatexProjectConfig(root, { main: "notes.md" }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("保存即编译：写进 compileOnSave，项目描述读回同一个值，别的键不动", async () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, ".orbita"));
      writeFileSync(join(dir, ".orbita", "latex.json"), JSON.stringify({ engine: "xelatex" }));
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
    });
    try {
      assert.equal(describeLatexProject(root).compileOnSave, false, "缺省关");
      await writeLatexProjectConfig(root, { compileOnSave: true });
      const saved = JSON.parse(readFileSync(join(root, ".orbita", "latex.json"), "utf8")) as {
        compileOnSave?: boolean;
        engine?: unknown;
        roots: { path: string; engine?: string }[];
      };
      assert.equal(saved.compileOnSave, true);
      assert.equal(saved.engine, undefined, "v2 不再产出顶层 engine");
      assert.equal(saved.roots[0]?.engine, "xelatex", "合并写，不抹掉引擎选择（迁到 roots[0]）");
      assert.equal(describeLatexProject(root).compileOnSave, true);
      await writeLatexProjectConfig(root, { compileOnSave: false });
      assert.equal(describeLatexProject(root).compileOnSave, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("多个 .tex 时选根：写入后项目描述就用它", async () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "intro.tex"), "\\documentclass{article}\n");
      writeFileSync(join(dir, "method.tex"), "\\documentclass{article}\n");
    });
    try {
      assert.equal(describeLatexProject(root).main, null);
      await writeLatexProjectConfig(root, { main: "method.tex" });
      const project = describeLatexProject(root);
      assert.equal(project.main, "method.tex");
      assert.equal(project.detail, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("describeLatexProject —— 多 root", () => {
  const OLD_TIME = new Date(2020, 0, 1);
  const NEW_TIME = new Date(2021, 0, 1);

  test("脏判定按 root 的 include 闭包：改附录不让正文变脏", () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, "sections"));
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\input{sections/a}\n");
      writeFileSync(join(dir, "sections", "a.tex"), "正文的一节\n");
      writeFileSync(join(dir, "appendix.tex"), "\\documentclass{article}\n\\input{sections/b}\n");
      writeFileSync(join(dir, "sections", "b.tex"), "附录的一节\n");
    });
    try {
      utimesSync(join(root, "main.tex"), OLD_TIME, OLD_TIME);
      utimesSync(join(root, "sections", "a.tex"), OLD_TIME, OLD_TIME);
      utimesSync(join(root, "appendix.tex"), NEW_TIME, NEW_TIME);
      utimesSync(join(root, "sections", "b.tex"), NEW_TIME, NEW_TIME);

      const project = describeLatexProject(root);
      assert.equal(project.activeRoot, "main.tex");
      // 项目级最新源码是附录那份（2021）；正文的闭包里没有它 → 不该被它带脏
      assert.ok(project.sourceModifiedAt !== null);
      assert.ok(
        project.sourceModifiedAt < NEW_TIME.getTime(),
        `正文的 sourceModifiedAt 被附录带脏了：${String(project.sourceModifiedAt)}`,
      );

      // 反过来：改正文自己包含的那一节，正文就该变脏
      utimesSync(join(root, "sections", "a.tex"), NEW_TIME, NEW_TIME);
      const after = describeLatexProject(root);
      assert.ok(
        (after.sourceModifiedAt ?? 0) >= NEW_TIME.getTime(),
        "改 sections/a.tex 之后正文没有变脏",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("focusedRoot：当前文件落在 main.tex 的闭包里", () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, "sections"));
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n\\input{sections/ch1}\n");
      writeFileSync(join(dir, "sections", "ch1.tex"), "Chapter one\n");
    });
    try {
      const project = describeLatexProject(root, { file: join(root, "sections", "ch1.tex") });
      assert.equal(project.activeRoot, "main.tex");
      assert.equal(project.focusedRoot, "main.tex");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("roots[] 带每个 root 的产物目录与产物；jobname 编出的 PDF 也找得到", () => {
    const root = withProject((dir) => {
      mkdirSync(join(dir, ".orbita"));
      writeFileSync(
        join(dir, ".orbita", "latex.json"),
        JSON.stringify({
          version: 2,
          activeRoot: "main.tex",
          roots: [
            { path: "main.tex", jobname: "review" },
            { path: "appendix.tex", outDir: "out-appendix" },
          ],
        }),
      );
      writeFileSync(join(dir, "main.tex"), "\\documentclass{article}\n");
      writeFileSync(join(dir, "appendix.tex"), "\\documentclass{article}\n");
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, "build", "review.pdf"), "%PDF-1.4\n");
    });
    try {
      const project = describeLatexProject(root);
      assert.equal(project.roots.length, 2);
      assert.equal(project.activeRoot, "main.tex");
      assert.equal(project.configured.activeRoot, "main.tex");
      // 面板的 PDF 事实不再拼 <main>.pdf：认 jobname
      assert.equal(project.pdf?.path, join(root, "build", "review.pdf"));
      const appendix = project.roots.find((item) => item.path === "appendix.tex");
      assert.equal(appendix?.outDirRelative, "out-appendix");
      assert.equal(appendix?.pdf, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("configure 写 per-root 的 engine / outDir，读回来在对应的 root 上", async () => {
    const root = withProject((dir) => {
      writeFileSync(join(dir, "intro.tex"), "\\documentclass{article}\n");
      writeFileSync(join(dir, "method.tex"), "\\documentclass{article}\n");
    });
    try {
      await writeLatexProjectConfig(root, { root: { path: "intro.tex", engine: "lualatex", outDir: "out" } });
      await writeLatexProjectConfig(root, { activate: "method.tex" });

      const saved = JSON.parse(readFileSync(join(root, ".orbita", "latex.json"), "utf8")) as {
        version?: number;
        activeRoot?: string;
        roots: { path: string; engine?: string; outDir?: string }[];
      };
      assert.equal(saved.version, 2);
      assert.equal(saved.activeRoot, "method.tex");
      assert.deepEqual(saved.roots, [
        { path: "intro.tex", engine: "lualatex", outDir: "out" },
        { path: "method.tex" },
      ]);

      const project = describeLatexProject(root);
      assert.equal(project.activeRoot, "method.tex");
      const intro = project.roots.find((item) => item.path === "intro.tex");
      assert.equal(intro?.engine, "lualatex");
      assert.equal(intro?.outDirRelative, "out");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
