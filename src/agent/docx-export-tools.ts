/**
 * agent 的 Word 导出工具：export_docx。
 *
 * 这一层只是翻译：参数 → docxExportRequest → 等 docxExportResult → pi 工具结果。
 * pandoc 进程、模板体检、OOXML 后处理、公式守门与原子写全在主进程
 * （main/docx-export/）——agent 进程每轮都是新的，不持有「用哪个模板」「哪个
 * pandoc」这种机器级状态，也不该直接起外部进程。
 *
 * 设计语言与 compile_latex 一致：
 * - 成功只回**一行摘要 + 至多十几条告警**，不把 pandoc 的 stderr 全倒进上下文；
 * - 公式降级是**失败**，不是「带 warning 的成功」——否则模型会以为那份论文已经好了；
 * - 结果 details 带 `openPanel`：产物直接在文件面板里用 folio 编辑器打开，目录页码
 *   交给既有的自愈。
 */
import { basename } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DOCX_EXPORT_BROKER_TIMEOUT_MS, type DocxExportOutcome } from "../shared/docx-export.ts";
import type { RequestBroker } from "./request-broker.ts";

/** 本工具的名字。权限档描述与测试都认这一份 */
export const DOCX_EXPORT_TOOL_NAMES = ["export_docx"] as const;

/** 结果正文里最多列几条告警：再多就是在倒 pandoc 的日志 */
const MAX_WARNINGS_SHOWN = 8;

export interface DocxExportToolContext {
  /** 会话 cwd：相对路径的解析基准（主进程按同一基准解析并授权） */
  cwd: string;
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function humanBytes(bytes: number): string {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describeSuccess(result: Extract<DocxExportOutcome, { ok: true }>): string {
  const { stats } = result;
  const parts = [
    `Exported the Word document to ${result.path} (${humanBytes(result.bytes)}).`,
    `${stats.paragraphs} paragraphs · ${stats.headings} headings · ${stats.tables} tables · ${stats.numberedEquations} numbered equations.`,
    `Template: ${result.template.requested}${result.template.path === null ? "" : ` (${basename(result.template.path)})`}.`,
    `pandoc ${result.pandocVersion}.`,
  ];
  const lists = [result.lists.toc ? "table of contents" : null, result.lists.figures ? "list of figures" : null, result.lists.tables ? "list of tables" : null].filter(
    (value): value is string => value !== null,
  );
  if (lists.length > 0) parts.push(`Inserted ${lists.join(", ")}; page numbers refresh when the editor lays it out (or press F9 in Word).`);
  if (result.warnings.length === 0) {
    parts.push("No warnings. It is open in the docx editor now.");
  } else {
    parts.push(
      `Warnings (${result.warnings.length}):\n` +
        result.warnings.slice(0, MAX_WARNINGS_SHOWN).map((warning) => `- ${warning}`).join("\n") +
        (result.warnings.length > MAX_WARNINGS_SHOWN ? `\n- …and ${result.warnings.length - MAX_WARNINGS_SHOWN} more.` : ""),
    );
  }
  return parts.join(" ");
}

export function createDocxExportTools(
  broker: Pick<RequestBroker, "request">,
  sessionId: string,
  context: DocxExportToolContext,
): ToolDefinition[] {
  const exportDocx: ToolDefinition = {
    name: "export_docx",
    label: "export_docx",
    description:
      "Export a Markdown (.md) or LaTeX (.tex) source into a Word .docx with pandoc, then post-process it for a thesis: " +
      "three-line tables, chapter-based equation numbering, table of contents / list of figures / list of tables, and a cover section. " +
      "The result opens in the in-app docx editor; failing on a run never overwrites an existing target file. " +
      "Requires pandoc ≥ 3.10.2 on the machine (the tool reports the exact problem if it is missing or too old). " +
      "Use it when the user wants a Word version of their paper / a school-template .docx, or asks for docx export. " +
      "Formulas that pandoc cannot convert are reported as an error (not silently left as `$...$`).",
    promptSnippet:
      "Export .md / .tex to a thesis-ready .docx (pandoc + three-line tables + equation numbering + TOC); refuses on degraded formulas.",
    promptGuidelines: [
      "Pass source and out as paths; both must stay inside the session's directories. A directory source needs main.tex or exactly one .md/.tex file.",
      "Do not pass --number-sections or try to call pandoc yourself: this tool chooses the flags, applies the school template and post-processes the OOXML.",
      "If it fails with a formula error, rewrite those formulas with the supported subset ($$ display math, aligned/cases/matrix, \\text{} for Chinese) and retry — do not export again unchanged.",
      `Work in ${context.cwd} unless the user points at another file or directory.`,
    ],
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description:
            "Markdown or LaTeX source, absolute or relative to the session working directory. " +
            "It may also be a directory that contains main.tex (or exactly one .tex / .md file).",
        },
        out: {
          type: "string",
          description: "Destination .docx path (absolute or relative). The file is replaced atomically; on failure it is left untouched.",
        },
        template: {
          type: "string",
          description:
            "Optional .docx template (reference doc) for this export. Omit to use the template configured in Settings " +
            "(built-in default / template.docx next to the source / a school template).",
        },
      },
      required: ["source", "out"],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const source = text(args["source"]);
      const out = text(args["out"]);
      const template = text(args["template"]);
      if (source === undefined) throw new Error('"source" is required (a .md / .tex file or a directory).');
      if (out === undefined) throw new Error('"out" is required (a .docx path).');

      if (signal?.aborted === true) throw new Error("Stopped");
      const pending = broker.request<DocxExportOutcome>(
        {
          type: "docxExportRequest",
          sessionId,
          request: { source, out, ...(template === undefined ? {} : { template }) },
        },
        DOCX_EXPORT_BROKER_TIMEOUT_MS,
      );
      const result =
        signal === undefined
          ? await pending
          : await Promise.race([
              pending,
              new Promise<never>((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
              ),
            ]);

      if (!result.ok) {
        const prefix =
          result.code === "formula-degraded"
            ? "Formula gate: "
            : result.code === "table-degraded"
              ? "Table gate: "
              : result.code === "pandoc-too-old" || result.code === "pandoc-missing"
                ? "pandoc: "
                : "Word export failed: ";
        throw new Error(
          `${prefix}${result.error}` +
            (result.warnings.length === 0
              ? ""
              : `\n\nWarnings:\n${result.warnings.slice(0, MAX_WARNINGS_SHOWN).map((warning) => `- ${warning}`).join("\n")}`),
        );
      }

      const title = basename(result.path);
      return {
        content: [{ type: "text" as const, text: describeSuccess(result) }],
        details: {
          openPanel: { kind: "files", path: result.path, force: true },
          card: {
            kind: "export",
            path: result.path,
            title,
            subtitle: `Word · ${humanBytes(result.bytes)} · ${result.stats.numberedEquations} equations`,
          },
        },
      };
    },
  };

  return [exportDocx];
}
