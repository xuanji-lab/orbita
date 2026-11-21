/**
 * agent 请求的授权层：源 / 输出 / 显式模板必须落在会话授权目录内；
 * 设置里的学校模板是用户显式选的机器级文件，不受 roots 限制；
 * 输出可以还不存在（取最近已存在祖先的 realpath 判越界）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDocxExportRequest, type DocxExportSettings } from "./agent-requests.ts";
import type { DocxExportOptions, DocxExporter } from "./export.ts";
import type { DocxExportOutcome } from "../../shared/docx-export.ts";

function fakeExporter(): { exporter: Pick<DocxExporter, "export">; calls: DocxExportOptions[] } {
  const calls: DocxExportOptions[] = [];
  return {
    calls,
    exporter: {
      async export(options: DocxExportOptions): Promise<DocxExportOutcome> {
        calls.push(options);
        return {
          ok: true,
          status: "ok",
          path: options.outPath,
          bytes: 1,
          stats: {
            paragraphs: 1,
            headings: 0,
            tables: 0,
            numberedEquations: 0,
            threeLineTables: 0,
            fields: 0,
            coverSection: false,
            bytes: 1,
          },
          warnings: [],
          template: {
            requested: "default",
            path: null,
            ok: true,
            verdict: "ok",
            problem: null,
            summary: { styles: 1, headerFooter: 0, macros: false, warnings: 0 },
            note: null,
            findings: [],
          },
          pandocPath: "pandoc",
          pandocVersion: "3.12.1",
          inputFormat: "markdown",
          lists: { toc: false, figures: false, tables: false },
        };
      },
    },
  };
}

const settings = (overrides: Partial<DocxExportSettings> = {}) => async (): Promise<DocxExportSettings> => ({
  pandocPath: null,
  templateMode: "default",
  customTemplatePath: null,
  ...overrides,
});

async function roots(): Promise<{ root: string; other: string; cleanup: () => Promise<void> }> {
  // macOS 的 tmpdir 是 /var/... 符号链接（真实路径 /private/var/...）：被测代码按设计传 realpath 给导出器，
  // 夹具也得从 realpath 起，否则断言在 macOS 上全红（与实现无关）
  const base = await realpath(await mkdtemp(join(tmpdir(), "orbita-docx-auth-")));
  const root = join(base, "work");
  const other = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(other, { recursive: true });
  return { root, other, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const sessions = (cwd: string) => ({ readMeta: async () => ({ cwd, workspaceId: "w" }) });
const workspaces = { attachedDirsOf: async () => [] };

describe("导出请求授权", () => {
  test("相对路径按会话 cwd 解析；源与输出都传真实路径给导出器", async () => {
    const { root, cleanup } = await roots();
    try {
      await writeFile(join(root, "paper.md"), "# hi");
      await mkdir(join(root, "out"));
      const { exporter, calls } = fakeExporter();
      const outcome = await applyDocxExportRequest(
        exporter,
        sessions(root),
        workspaces,
        settings(),
        { sessionId: "s", request: { source: "paper.md", out: "out/paper.docx" } },
      );
      assert.equal(outcome.ok, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.sourcePath, join(root, "paper.md"));
      assert.equal(calls[0]?.outPath, join(root, "out", "paper.docx"));
    } finally {
      await cleanup();
    }
  });

  test("目录源：优先 main.tex", async () => {
    const { root, cleanup } = await roots();
    try {
      await writeFile(join(root, "main.tex"), "\\section{x}");
      await writeFile(join(root, "other.tex"), "\\section{y}");
      const { exporter, calls } = fakeExporter();
      await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: ".", out: "x.docx" },
      });
      assert.equal(calls[0]?.sourcePath, join(root, "main.tex"));
    } finally {
      await cleanup();
    }
  });

  test("目录里有多个 .tex 且没有 main.tex → 明确说让调用方点名文件", async () => {
    const { root, cleanup } = await roots();
    try {
      await writeFile(join(root, "a.tex"), "");
      await writeFile(join(root, "b.tex"), "");
      const { exporter } = fakeExporter();
      const outcome = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: ".", out: "x.docx" },
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.match(outcome.error, /Cannot tell which file/);
    } finally {
      await cleanup();
    }
  });

  test("源在授权目录外 → 拒绝（symlink realpath 之后判）", async () => {
    const { root, other, cleanup } = await roots();
    try {
      await writeFile(join(other, "secret.md"), "secret");
      const { exporter, calls } = fakeExporter();
      const outcome = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: join(other, "secret.md"), out: join(root, "x.docx") },
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.code, "source-missing");
      assert.match(outcome.error, /outside this session/);
      assert.equal(calls.length, 0);
    } finally {
      await cleanup();
    }
  });

  test("输出在授权目录外 → 拒绝；还不存在的目录也能判", async () => {
    const { root, other, cleanup } = await roots();
    try {
      await writeFile(join(root, "paper.md"), "# hi");
      const { exporter } = fakeExporter();
      const outcome = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: "paper.md", out: join(other, "deep", "x.docx") },
      });
      assert.equal(outcome.ok, false);
      if (outcome.ok) return;
      assert.equal(outcome.code, "out-of-scope");
      assert.match(outcome.error, /outside this session/);
    } finally {
      await cleanup();
    }
  });

  test("输出扩展名不是 .docx → 拒绝", async () => {
    const { root, cleanup } = await roots();
    try {
      await writeFile(join(root, "paper.md"), "# hi");
      const { exporter } = fakeExporter();
      const outcome = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: "paper.md", out: "paper.pdf" },
      });
      assert.equal(outcome.ok, false);
      if (!outcome.ok) assert.match(outcome.error, /end with \.docx/);
    } finally {
      await cleanup();
    }
  });

  test("显式模板必须落在授权目录内；设置里的学校模板不受限（用户自己选的）", async () => {
    const { root, other, cleanup } = await roots();
    try {
      await writeFile(join(root, "paper.md"), "# hi");
      await writeFile(join(root, "school.docx"), "PK");
      await writeFile(join(other, "school.docx"), "PK");
      const { exporter, calls } = fakeExporter();
      const bad = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: "paper.md", out: "x.docx", template: join(other, "school.docx") },
      });
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.equal(bad.code, "out-of-scope");

      const good = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: "paper.md", out: "x.docx", template: "school.docx" },
      });
      assert.equal(good.ok, true);
      assert.equal(calls[0]?.explicitTemplate, join(root, "school.docx"));

      await applyDocxExportRequest(
        exporter,
        sessions(root),
        workspaces,
        settings({ templateMode: "custom", customTemplatePath: join(other, "school.docx") }),
        { sessionId: "s", request: { source: "paper.md", out: "x.docx" } },
      );
      assert.equal(calls[1]?.templateMode, "custom");
      assert.equal(calls[1]?.customTemplatePath, join(other, "school.docx"));
    } finally {
      await cleanup();
    }
  });

  test("显式模板不是 .docx → template-invalid", async () => {
    const { root, cleanup } = await roots();
    try {
      await writeFile(join(root, "paper.md"), "# hi");
      await writeFile(join(root, "x.docx"), "PK");
      const { exporter } = fakeExporter();
      const outcome = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: "paper.md", out: "out.docx", template: "x.txt" },
      });
      // 文件不存在 → 授权层先报找不到（可读）；先造一个 .txt 再断言扩展名
      assert.equal(outcome.ok, false);
      await writeFile(join(root, "t.txt"), "x");
      const second = await applyDocxExportRequest(exporter, sessions(root), workspaces, settings(), {
        sessionId: "s",
        request: { source: "paper.md", out: "out.docx", template: "t.txt" },
      });
      assert.equal(second.ok, false);
      if (!second.ok) assert.equal(second.code, "template-invalid");
    } finally {
      await cleanup();
    }
  });
});
