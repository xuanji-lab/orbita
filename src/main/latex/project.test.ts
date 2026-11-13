/**
 * 项目探测 / 项目描述的账：从文件往上找到最近的项目、多 .tex 时不瞎猜、写配置
 * 不抹掉用户手写的字段。夹具在临时目录里现造（真 fs，不 mock——这条路径本来就是
 * 读盘的）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      assert.deepEqual(saved, { outDir: "out", args: ["-shell-escape"], engine: "xelatex" });
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
      const saved = JSON.parse(readFileSync(join(root, ".orbita", "latex.json"), "utf8")) as Record<string, unknown>;
      assert.equal(saved["compileOnSave"], true);
      assert.equal(saved["engine"], "xelatex", "合并写，不抹掉引擎选择");
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
