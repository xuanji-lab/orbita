/**
 * docx 导出流水线：探测 pandoc → 取模板 → pandoc 粗转 → OOXML 后处理 → 公式守门
 * → 原子替换。
 *
 * **失败不碰目标文件**：pandoc 写到同目录的临时文件，后处理与守门都在临时文件上做，
 * 只有全部通过才用 `writeBytesAtomic`（临时文件 + rename）落到目标路径。中途失败时
 * 删临时文件、原目标原样留着——一份写了一半的论文比一次明确的失败糟得多。
 *
 * **公式降级不算成功**：pandoc 把不认识的 TeX 写成字面 `$...$` 只给一条 warning、
 * 退出码仍是 0。我们把它升级成失败（`formula-degraded`），并列出原文片段——模型
 * 该去改公式，而不是以为导出成功了。
 *
 * 外部进程与文件系统都可以注入：`node --test` 用假 pandoc 与临时目录跑完整链路，
 * 不依赖本机装没装 pandoc。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  DOCX_EXPORT_TIMEOUT_MS,
  formatPandocVersion,
  type DocxExportOutcome,
  type DocxTemplateMode,
  type DocxTemplateReport,
  type DocxExportStats,
} from "../../shared/docx-export.ts";
import { writeBytesAtomic } from "../atomic-write.ts";
import { buildPandocArgs, detectInputFormat, latexTableEnvironments } from "./argv.ts";
import { ensureDefaultTemplate } from "./default-template.ts";
import { postProcessDocx } from "./postprocess.ts";
import { inspectDocxTemplate } from "./template.ts";
import type { PandocProbeResult } from "../../shared/docx-export.ts";

/** pandoc 一次转换的硬上限。真实论文（几百页 + 图）实测 < 30 秒；5 分钟足够慢机器 */
export const PANDOC_TIMEOUT_MS = DOCX_EXPORT_TIMEOUT_MS;
/** stderr 只留最后这么多字符：pandoc 的告警可以堆很长，全塞进上下文没有意义 */
const STDERR_LIMIT = 64 * 1024;

export interface PandocRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export interface DocxExportDeps {
  probe: (explicit?: string) => Promise<PandocProbeResult>;
  runPandoc: (pandocPath: string, args: readonly string[], options: { cwd: string; timeoutMs: number }) => Promise<PandocRunResult>;
  /** `pandoc --print-default-data-file reference.docx` */
  printReference: (pandocPath: string) => Promise<Uint8Array | null>;
  cacheDir: string;
}

export interface DocxExportOptions {
  /** 已授权的绝对路径 */
  sourcePath: string;
  outPath: string;
  /** 设置里显式指定的 pandoc（可空） */
  pandocPath?: string;
  /** agent 本次显式给的模板（已授权的绝对路径）；null = 按设置 */
  explicitTemplate?: string | null;
  templateMode: DocxTemplateMode;
  /** 设置里的学校模板绝对路径（mode=custom 时用） */
  customTemplatePath?: string | null;
}

/** 把 pandoc 的 stderr 切成「一条 warning」——多行续行到空行为止 */
export function parsePandocWarnings(stderr: string): string[] {
  const lines = stderr.replace(/\r\n?/g, "\n").split("\n");
  const warnings: string[] = [];
  let current: string[] | null = null;
  const flush = (): void => {
    if (current === null) return;
    const text = current.join("\n").trim();
    if (text !== "") warnings.push(text);
    current = null;
  };
  for (const line of lines) {
    if (/^\[(?:WARNING|warning)\]/.test(line)) {
      flush();
      current = [line];
      continue;
    }
    if (current !== null) {
      if (line.trim() === "") flush();
      else current.push(line);
    }
  }
  flush();
  return warnings;
}

/** 这条 warning 是不是「公式没转成」——公式守门的第二道信号 */
export function isMathWarning(warning: string): boolean {
  return /could not convert tex math|texmath|failed to render equation/i.test(warning);
}

/** 把公式降级说成模型能改的话：原文片段 + 一条规则 */
function degradationMessage(snippets: readonly string[], warnings: readonly string[]): string {
  const parts = [
    "The export was stopped because some formulas would have been written as literal TeX text instead of native Word equations.",
  ];
  if (snippets.length > 0) parts.push(`Unconverted math: ${snippets.map((text) => `\`${text}\``).join(", ")}.`);
  if (warnings.length > 0) parts.push(`pandoc said: ${warnings.join(" | ")}`);
  parts.push(
    "Rewrite those formulas with the supported subset (display math `$$ ... $$`, `aligned` / `cases` / `matrix`, `\\text{}` for Chinese) and export again. Nothing was written.",
  );
  return parts.join(" ");
}

export function createDocxExporter(deps: DocxExportDeps) {
  return {
    async export(options: DocxExportOptions): Promise<DocxExportOutcome> {
      const warnings: string[] = [];
      const sourceStats = await stat(options.sourcePath).catch(() => null);
      if (sourceStats === null || !sourceStats.isFile()) {
        return {
          ok: false,
          code: "source-missing",
          error: `Source file not found: ${options.sourcePath}`,
          warnings,
        };
      }
      const format = detectInputFormat(options.sourcePath);
      if (format === null) {
        return {
          ok: false,
          code: "out-of-scope",
          error: "The source must be a .md / .markdown / .tex file (or a directory that contains one).",
          warnings,
        };
      }
      if (extname(options.outPath).toLowerCase() !== ".docx") {
        return { ok: false, code: "out-of-scope", error: "The output path must end with .docx.", warnings };
      }

      const probe = await deps.probe(options.pandocPath);
      if (!probe.ok || probe.path === null || probe.version === null) {
        return { ok: false, code: "pandoc-missing", error: probe.message, warnings: [] };
      }
      if (!probe.supported) {
        return { ok: false, code: "pandoc-too-old", error: probe.message, warnings: [] };
      }

      let text: string;
      try {
        text = await readFile(options.sourcePath, "utf8");
      } catch (cause) {
        return {
          ok: false,
          code: "source-missing",
          error: cause instanceof Error ? cause.message : String(cause),
          warnings,
        };
      }

      if (format === "latex") {
        const tables = latexTableEnvironments(text);
        if (tables.length > 0) {
          return {
            ok: false,
            code: "table-degraded",
            error:
              `The source uses LaTeX table environment(s): ${tables.map((name) => `\\begin{${name}}`).join(", ")}. ` +
              "pandoc's LaTeX reader does not parse them (3.9 and 3.12.1 both turn the rows into literal text), " +
              "so the Word file would lose the tables. Convert those tables to a Markdown pipe table in the source " +
              "(or lay them out in Word afterwards) and export again. Nothing was written.",
            warnings: [],
          };
        }
      }

      const template = await resolveTemplate(deps, options, probe, warnings);
      if (template.error !== null || template.report === null) {
        return { ok: false, code: "template-invalid", error: template.error ?? "Template could not be read.", warnings };
      }
      warnings.push(...template.warnings);

      const tempPath = temporaryOutput(options.outPath);
      const plan = buildPandocArgs({
        format,
        text,
        sourcePath: options.sourcePath,
        outPath: tempPath,
        referenceDoc: template.path,
      });
      try {
        await mkdir(dirname(options.outPath), { recursive: true });
        const run = await deps.runPandoc(probe.path, plan.args, {
          cwd: dirname(options.sourcePath),
          timeoutMs: PANDOC_TIMEOUT_MS,
        });
        const pandocWarnings = parsePandocWarnings(run.stderr);
        if (run.spawnError !== null) {
          return { ok: false, code: "pandoc-failed", error: `pandoc could not be started: ${run.spawnError}`, warnings: [] };
        }
        if (run.timedOut) {
          return {
            ok: false,
            code: "pandoc-failed",
            error: `pandoc did not finish within ${Math.round(PANDOC_TIMEOUT_MS / 1000)} seconds and was stopped.`,
            warnings: pandocWarnings,
          };
        }
        if (run.code !== 0) {
          const tail = run.stderr.trim().split("\n").slice(-12).join("\n");
          return {
            ok: false,
            code: "pandoc-failed",
            error: `pandoc exited with code ${String(run.code)}${tail === "" ? "" : `:\n${tail}`}`,
            warnings: pandocWarnings,
          };
        }

        // 关掉 Word 的「更新域」提示之外还要自己再看一眼：pandoc 的 texmath 告警与
        // 字面 `$...$` 是公式降级的两个证据，任何一条就判失败。
        const mathWarnings = pandocWarnings.filter(isMathWarning);
        const raw = await readFile(tempPath);
        const processed = await postProcessDocx(raw);
        const formulasBroken = processed.mathResidue.length > 0 || mathWarnings.length > 0;
        if (formulasBroken) {
          return {
            ok: false,
            code: "formula-degraded",
            error: degradationMessage(processed.mathResidue, mathWarnings),
            warnings: pandocWarnings,
          };
        }
        warnings.push(...pandocWarnings, ...processed.warnings);

        await writeBytesAtomic(options.outPath, processed.bytes);
        const stats: DocxExportStats = { ...processed.stats, bytes: processed.bytes.byteLength };
        return {
          ok: true,
          status: warnings.length === 0 ? "ok" : "warning",
          path: options.outPath,
          bytes: stats.bytes,
          stats,
          warnings,
          template: template.report,
          pandocPath: probe.path,
          pandocVersion: formatPandocVersion(probe.version),
          inputFormat: format,
          lists: processed.lists,
        };
      } catch (cause) {
        return {
          ok: false,
          code: "write-failed",
          error: cause instanceof Error ? cause.message : String(cause),
          warnings,
        };
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    },
  };
}

export type DocxExporter = ReturnType<typeof createDocxExporter>;

/** pandoc 的临时输出（与目标同目录，跨盘 rename 才不会退化成复制） */
function temporaryOutput(outPath: string): string {
  return join(dirname(outPath), `.${basename(outPath, extname(outPath))}.${randomBytes(4).toString("hex")}.tmp.docx`);
}

interface ResolvedTemplate {
  path: string | null;
  report: DocxTemplateReport | null;
  warnings: string[];
  error: string | null;
}

/**
 * 模板来源，优先级：本次显式给的 → 设置（custom / project / default）。
 *
 * custom 配了但文件不在时**不静默回落默认**：用户以为在用学校模板、实际没有，
 * 是最坏的一种「成功」。project 找不到 `template.docx` 才回落默认，并留一条 warning
 * （项目模板是可选的约定，不是用户显式选择）。
 */
async function resolveTemplate(
  deps: DocxExportDeps,
  options: DocxExportOptions,
  probe: PandocProbeResult,
  warnings: string[],
): Promise<ResolvedTemplate> {
  if (options.explicitTemplate !== undefined && options.explicitTemplate !== null) {
    return inspectPath(options.explicitTemplate, "custom");
  }
  if (options.templateMode === "custom") {
    const custom = options.customTemplatePath?.trim() ?? "";
    if (custom === "") {
      return {
        path: null,
        report: null,
        warnings,
        error: "No school template is selected: open Settings › General › Word export and choose a .docx template, or pass a template path.",
      };
    }
    return inspectPath(custom, "custom");
  }
  if (options.templateMode === "project") {
    const project = join(dirname(options.sourcePath), "template.docx");
    const exists = await stat(project).then((value) => value.isFile()).catch(() => false);
    if (exists) return inspectPath(project, "project");
    warnings.push(`No template.docx next to the source file; used the built-in default template instead.`);
  }

  // 默认模板：pandoc 自带的 reference.docx（我们补了中文字体），缓存到 userData
  if (probe.path === null || probe.version === null) {
    return { path: null, report: null, warnings, error: "pandoc is not available for the built-in template." };
  }
  const made = await ensureDefaultTemplate({
    cacheDir: deps.cacheDir,
    pandocPath: probe.path,
    version: probe.version,
    printReference: deps.printReference,
  });
  if (made.path === null) {
    warnings.push(`Could not prepare the built-in template (${made.error ?? "unknown error"}); pandoc's own default styles are used.`);
    return {
      path: null,
      report: {
        requested: "default",
        path: null,
        ok: true,
        verdict: "warning",
        summary: `Built-in default template unavailable (${made.error ?? "unknown error"}); using pandoc's default styles.`,
        findings: [{ level: "warn", label: "Built-in template unavailable", ...(made.error === null ? {} : { detail: made.error }) }],
      },
      warnings,
      error: null,
    };
  }
  return inspectPath(made.path, "default");
}

async function inspectPath(path: string, requested: DocxTemplateMode): Promise<ResolvedTemplate> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (cause) {
    return {
      path: null,
      report: null,
      warnings: [],
      error: `Template not found or unreadable: ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  const report = await inspectDocxTemplate(bytes, { requested, path });
  if (!report.ok) {
    return { path: null, report, warnings: [], error: `The template cannot be used: ${report.summary}` };
  }
  return { path, report, warnings: [], error: null };
}

/** 生产环境的 pandoc 执行（spawn + 超时杀进程树 + stderr 截断） */
export function spawnPandoc(
  pandocPath: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<PandocRunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(pandocPath, [...args], { cwd: options.cwd, windowsHide: true });
    } catch (error) {
      resolve({
        code: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: PandocRunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr, timedOut: true, spawnError: null });
    }, options.timeoutMs);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < STDERR_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > STDERR_LIMIT) stderr = stderr.slice(-STDERR_LIMIT);
    });
    child.on("error", (error) => finish({ code: null, stdout, stderr, timedOut: false, spawnError: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false, spawnError: null }));
  });
}

/** Windows 上杀整棵进程树（pandoc 可能起 lua 过滤器子进程），其它平台先 TERM 再 KILL */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 1500).unref();
}

/** 生产环境的 `--print-default-data-file`（stdout 是二进制，单独收） */
export function printReferenceDoc(pandocPath: string): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const child = spawn(pandocPath, ["--print-default-data-file", "reference.docx"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      killTree(child);
      resolve(null);
    }, 30_000);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // reference.docx 约 11 KB；超过 8 MB 说明这个 pandoc 行为不对，不值得继续收
      if (size > 8 * 1024 * 1024) {
        killTree(child);
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && size > 1024 ? new Uint8Array(Buffer.concat(chunks)) : null);
    });
  });
}
