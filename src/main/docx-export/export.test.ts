/**
 * 导出流水线：pandoc 由假货代跑（写一份夹具 docx），验证
 * 模板选择 / 公式守门 / 失败不碰目标 / 临时文件清理 / 告警分级。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { createDocxExporter, parsePandocWarnings, isMathWarning, type DocxExportDeps, type PandocRunResult } from "./export.ts";
import type { PandocProbeResult } from "../../shared/docx-export.ts";

const VERSION = { major: 3, minor: 12, patch: 1 };

const probeOk: PandocProbeResult = {
  ok: true,
  path: "C:\\pandoc.exe",
  version: VERSION,
  versionText: "3.12.1",
  supported: true,
  minVersion: "3.10.2",
  recommendedVersion: "3.12.1",
  message: "pandoc 3.12.1",
  searched: [],
};

const BODY = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="w" xmlns:m="m"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>引言</w:t></w:r></w:p>
<w:p><m:oMathPara><m:oMath><m:r><m:t>E</m:t></m:r></m:oMath></m:oMathPara></w:p>
<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440"/></w:sectPr>
</w:body></w:document>`;

async function docxOf(documentXml: string, settingsXml = "<w:settings/>"): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<Types/>");
  zip.file("word/document.xml", documentXml);
  zip.file("word/settings.xml", settingsXml);
  return zip.generateAsync({ type: "uint8array" });
}

async function templateOf(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440"/></w:sectPr></w:body></w:document>',
  );
  zip.file("word/styles.xml", '<w:styles><w:style w:styleId="Heading1"/></w:styles>');
  zip.file("word/header1.xml", "<w:hdr/>");
  return zip.generateAsync({ type: "uint8array" });
}

interface Harness {
  deps: DocxExportDeps;
  dir: string;
  calls: { args: readonly string[]; cwd: string }[];
}

async function harness(options: {
  documentXml?: string;
  stderr?: string;
  code?: number;
  probe?: PandocProbeResult;
  printReference?: (path: string) => Promise<Uint8Array | null>;
}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "orbita-docx-export-"));
  const calls: { args: readonly string[]; cwd: string }[] = [];
  const fixture = await docxOf(options.documentXml ?? BODY);
  const deps: DocxExportDeps = {
    probe: async () => options.probe ?? probeOk,
    runPandoc: async (_pandocPath, args, runOptions): Promise<PandocRunResult> => {
      calls.push({ args, cwd: runOptions.cwd });
      const index = args.indexOf("--output");
      const target = args[index + 1] as string;
      await writeFile(target, fixture);
      return {
        code: options.code ?? 0,
        stdout: "",
        stderr: options.stderr ?? "",
        timedOut: false,
        spawnError: null,
      };
    },
    printReference: options.printReference ?? (async () => null),
    cacheDir: join(dir, "cache"),
  };
  return { deps, dir, calls };
}

const sourceText = "# 引言\n\n中文正文。\n";

describe("pandoc 告警解析", () => {
  test("多行 [WARNING] 合成一条，空行切分", () => {
    const stderr = "[WARNING] Could not convert TeX math \\foo\n  \\foo\n\n[WARNING] Other\n  detail\n";
    const warnings = parsePandocWarnings(stderr);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /Could not convert TeX math/);
    assert.match(warnings[1] ?? "", /Other/);
    assert.equal(isMathWarning(warnings[0] ?? ""), true);
    assert.equal(isMathWarning(warnings[1] ?? ""), false);
  });
});

describe("导出", () => {
  test("成功：产物落盘、模板体检、三线表 / 公式编号 / updateFields 都在；临时文件清掉", async () => {
    const h = await harness({});
    const source = join(h.dir, "paper.md");
    const template = join(h.dir, "school.docx");
    const out = join(h.dir, "paper.docx");
    await writeFile(source, sourceText);
    await writeFile(template, await templateOf());

    const exporter = createDocxExporter(h.deps);
    const result = await exporter.export({
      sourcePath: source,
      outPath: out,
      explicitTemplate: template,
      templateMode: "default",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "ok");
    assert.equal(result.template.requested, "custom");
    assert.equal(result.template.path, template);
    assert.equal(result.stats.numberedEquations, 1);
    assert.equal(result.stats.threeLineTables, 1);
    assert.equal(result.stats.coverSection, false);
    assert.equal(result.pandocVersion, "3.12.1");
    assert.equal(result.lists.toc, true);

    const produced = await readFile(out);
    assert.equal(produced.subarray(0, 2).toString(), "PK");
    const leftovers = (await readdir(h.dir)).filter((name) => name.includes(".tmp.docx"));
    assert.deepEqual(leftovers, []);
    // 工作目录是源文件目录（相对资源按它解析）
    assert.equal(h.calls[0]?.cwd, h.dir);
  });

  test("公式降级：失败、目标文件一个字节都不动、临时文件清掉", async () => {
    const h = await harness({
      documentXml: BODY.replace("<m:oMathPara>", '<w:p><w:r><w:t>$\\foo{bar}$</w:t></w:r></w:p><m:oMathPara>'),
      stderr: "[WARNING] Could not convert TeX math \\foo{bar}, rendering as TeX:\n  \\foo{bar}\n",
    });
    const source = join(h.dir, "paper.md");
    const out = join(h.dir, "paper.docx");
    await writeFile(source, sourceText);
    await writeFile(out, "OLD CONTENT");

    const result = await createDocxExporter(h.deps).export({ sourcePath: source, outPath: out, templateMode: "project" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "formula-degraded");
    assert.match(result.error, /literal TeX/);
    assert.match(result.error, /\\foo\{bar\}/);
    assert.equal(await readFile(out, "utf8"), "OLD CONTENT");
    assert.deepEqual(
      (await readdir(h.dir)).filter((name) => name.includes(".tmp.docx")),
      [],
    );
  });

  test("pandoc 非零退出：失败、目标不动、错误带最后几行", async () => {
    const h = await harness({ code: 3, stderr: "[ERROR] could not parse input\nsecond line\n" });
    const source = join(h.dir, "paper.md");
    const out = join(h.dir, "paper.docx");
    await writeFile(source, sourceText);
    await writeFile(out, "OLD");
    const result = await createDocxExporter(h.deps).export({ sourcePath: source, outPath: out, templateMode: "project" });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "pandoc-failed");
    assert.match(result.error, /code 3/);
    assert.match(result.error, /could not parse input/);
    assert.equal(await readFile(out, "utf8"), "OLD");
  });

  test("版本过低：直接拒绝，根本不跑 pandoc", async () => {
    const h = await harness({
      probe: { ...probeOk, versionText: "3.9", version: { major: 3, minor: 9, patch: 0 }, supported: false, message: "too old" },
    });
    const source = join(h.dir, "paper.md");
    await writeFile(source, sourceText);
    const result = await createDocxExporter(h.deps).export({
      sourcePath: source,
      outPath: join(h.dir, "x.docx"),
      templateMode: "project",
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "pandoc-too-old");
    assert.equal(h.calls.length, 0);
  });

  test("非公式告警：产物写成功，status:warning 并带上告警", async () => {
    const h = await harness({ stderr: "[WARNING] Citeproc: citation lewis2020 not found\n" });
    const source = join(h.dir, "paper.md");
    const out = join(h.dir, "paper.docx");
    await writeFile(source, sourceText);
    const result = await createDocxExporter(h.deps).export({ sourcePath: source, outPath: out, templateMode: "project" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "warning");
    assert.ok(result.warnings.some((warning) => /citation lewis2020/.test(warning)));
  });

  test("project 模式没有 template.docx → 回落默认，并留一条 warning", async () => {
    const h = await harness({});
    const source = join(h.dir, "paper.md");
    await writeFile(source, sourceText);
    const result = await createDocxExporter(h.deps).export({
      sourcePath: source,
      outPath: join(h.dir, "paper.docx"),
      templateMode: "project",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.template.requested, "default");
    assert.ok(result.warnings.some((warning) => /No template\.docx/.test(warning)));
    // 默认模板生成不出来时只用 pandoc 自带样式，不传 --reference-doc
    assert.equal(h.calls[0]?.args.some((arg) => arg.startsWith("--reference-doc=")), false);
  });

  test("custom 模式没有配路径 → 明确报错，不静默回落", async () => {
    const h = await harness({});
    const source = join(h.dir, "paper.md");
    await writeFile(source, sourceText);
    const result = await createDocxExporter(h.deps).export({
      sourcePath: source,
      outPath: join(h.dir, "paper.docx"),
      templateMode: "custom",
      customTemplatePath: null,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "template-invalid");
    assert.match(result.error, /No school template/);
  });

  test("模板文件不存在 → template-invalid（不猜一个默认模板顶上）", async () => {
    const h = await harness({});
    const source = join(h.dir, "paper.md");
    await writeFile(source, sourceText);
    const result = await createDocxExporter(h.deps).export({
      sourcePath: source,
      outPath: join(h.dir, "paper.docx"),
      templateMode: "custom",
      customTemplatePath: join(h.dir, "missing.docx"),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "template-invalid");
    assert.match(result.error, /not found/);
  });

  test("源文件不存在 / 扩展名不对 → 可读的失败码", async () => {
    const h = await harness({});
    const missing = await createDocxExporter(h.deps).export({
      sourcePath: join(h.dir, "nope.md"),
      outPath: join(h.dir, "x.docx"),
      templateMode: "project",
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.code, "source-missing");

    const txt = join(h.dir, "x.txt");
    await writeFile(txt, "hi");
    const wrong = await createDocxExporter(h.deps).export({
      sourcePath: txt,
      outPath: join(h.dir, "x.docx"),
      templateMode: "project",
    });
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.code, "out-of-scope");
  });
});
