/**
 * 模板体检 —— 拿一份 .docx 当 `pandoc --reference-doc` 之前，先把它读一遍，
 * 告诉用户「里面有什么、少了什么、会不会出问题」。
 *
 * **不硬失败**：宏、缺页眉、没有 numbering 都只出 warning——它们不影响 pandoc 把
 * 正文转出来，只是产物会缺那部分样式。只有「根本不是一个能读的 docx」（OLE2 加密包 /
 * 非 zip / 缺 word/document.xml）才判 unusable；那时给出的是人话结论，不是异常。
 *
 * 纯模块（jszip + 字符串），不 import electron：设置页的模板卡片与导出工具共用
 * 同一份报告，测试直接拿手工 zip 当夹具。
 */
import JSZip from "jszip";
import type { DocxTemplateFinding, DocxTemplateMode, DocxTemplateReport } from "../../shared/docx-export.ts";

/** 模板体积上限（80 MB）。再大就不是模板，是论文本体——读进内存做正则会拖住主进程 */
export const DOCX_TEMPLATE_MAX_BYTES = 80 * 1024 * 1024;

/** Word 加密保存的整包是 OLE2 容器（D0 CF 11 E0），与老 .doc 同魔数 */
function isOle2(bytes: Uint8Array): boolean {
  return bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

/** `w:instrText` 里的域指令（前几条：目录 / 图表目录 / 页码 / 公式编号） */
function fieldInstructions(documentXml: string, limit = 6): string[] {
  const out: string[] = [];
  const pattern = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(documentXml)) !== null && out.length < limit) {
    const text = decodeXml(match[1] ?? "").trim();
    if (text !== "") out.push(text);
  }
  return out;
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

const HEADING_STYLE = /<w:style\b[^>]*w:styleId="(?:Heading[1-6]|heading [1-6])"/g;

export interface TemplateInspectOptions {
  requested?: DocxTemplateMode;
  /** 报告里回显的绝对路径（默认 null：内置模板） */
  path?: string | null;
}

/**
 * 体检一份模板字节。`requested` 只用于报告回显（default / project / custom）。
 * 报告里的 path 是调用方给的真实路径——这里不做任何路径解析（那是 ipc 层的事）。
 */
export async function inspectDocxTemplate(
  bytes: Uint8Array,
  options: TemplateInspectOptions = {},
): Promise<DocxTemplateReport> {
  const requested = options.requested ?? "custom";
  const path = options.path ?? null;
  const findings: DocxTemplateFinding[] = [];

  const unusable = (summary: string, detail?: string): DocxTemplateReport => ({
    requested,
    path,
    ok: false,
    verdict: "unusable",
    summary,
    findings: [...findings, { level: "warn", label: summary, ...(detail === undefined ? {} : { detail }) }],
  });

  if (bytes.byteLength === 0) return unusable("The file is empty.");
  if (bytes.byteLength > DOCX_TEMPLATE_MAX_BYTES) {
    return unusable(
      `The template is larger than ${Math.round(DOCX_TEMPLATE_MAX_BYTES / 1024 / 1024)} MB — that is not a template.`,
    );
  }
  if (isOle2(bytes)) {
    return unusable(
      "This is a password-protected Word file (OLE2 container), not a readable .docx.",
      "Open it in Word, remove the password, save as .docx and choose it again.",
    );
  }
  if (!isZip(bytes)) {
    return unusable("This is not a .docx package (it is not a ZIP container).", "Pick a .docx file saved by Word / WPS.");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (cause) {
    return unusable(
      "The .docx package cannot be opened (the ZIP is corrupt or truncated).",
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  const documentXml = await readText(zip, "word/document.xml");
  if (documentXml === null) {
    return unusable("The package has no word/document.xml — it is not a Word document.");
  }
  const stylesXml = await readText(zip, "word/styles.xml");
  const settingsXml = await readText(zip, "word/settings.xml");
  const numberingXml = await readText(zip, "word/numbering.xml");
  const contentTypes = await readText(zip, "[Content_Types].xml");
  const macro = zip.file("word/vbaProject.bin") !== null;

  // ── 结构：pandoc 只读 styles / 页面设置 / 页眉页脚，缺了照样能转，但要说明白 ──
  if (contentTypes === null) {
    findings.push({ level: "warn", label: "Missing [Content_Types].xml", detail: "Word may refuse to open the output; re-save the template from Word." });
  }

  if (stylesXml === null) {
    findings.push({
      level: "warn",
      label: "No word/styles.xml",
      detail: "pandoc falls back to its own reference styles, so the school formatting will not be applied.",
    });
  } else {
    const styles = countMatches(stylesXml, /<w:style\b/g);
    const headings = countMatches(stylesXml, HEADING_STYLE);
    findings.push({
      level: "ok",
      label: `${styles} paragraph / character styles`,
      detail: headings === 0 ? "No Heading 1–6 styles: pandoc will use its own headings." : `${headings} heading levels defined.`,
    });
    if (headings === 0) {
      findings.push({
        level: "warn",
        label: "No built-in heading styles",
        detail: "Table of contents and equation numbering rely on Heading 1; add them in Word for chapter-based numbering.",
      });
    }
    const eastAsia = /w:eastAsia="([^"]+)"/.exec(stylesXml)?.[1];
    if (eastAsia !== undefined && eastAsia !== "") {
      findings.push({ level: "info", label: `East-Asian language: ${decodeXml(eastAsia)}` });
    }
  }

  const sectionProps = countMatches(documentXml, /<w:sectPr\b/g);
  const bodySection = /<w:body>[\s\S]*<w:sectPr\b/.test(documentXml);
  if (sectionProps === 0) {
    findings.push({
      level: "warn",
      label: "No page setup (w:sectPr)",
      detail: "pandoc will use its default page size and margins.",
    });
  } else {
    const size = /<w:pgSz\b[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/.exec(documentXml);
    const sizeText = size === null ? "" : ` · ${size[1]}×${size[2]} twips`;
    findings.push({
      level: "ok",
      label: `${sectionProps} section(s)${bodySection ? "" : " (no body sectPr)"}${sizeText}`,
    });
  }

  if (numberingXml === null) {
    findings.push({
      level: "info",
      label: "No numbering.xml",
      detail: "Numbered / bulleted lists will use pandoc's default list formatting.",
    });
  } else {
    const abstract = countMatches(numberingXml, /<w:abstractNum\b/g);
    findings.push({ level: "ok", label: `${abstract} numbering definitions` });
  }

  const headers = zip.file(/^word\/header\d*\.xml$/);
  const footers = zip.file(/^word\/footer\d*\.xml$/);
  if (headers.length === 0 && footers.length === 0) {
    findings.push({
      level: "warn",
      label: "No headers or footers",
      detail: "Page numbers and the school running head will be missing from the output.",
    });
  } else {
    findings.push({ level: "ok", label: `${headers.length} header(s), ${footers.length} footer(s)` });
  }

  const instr = fieldInstructions(documentXml);
  if (instr.length > 0) {
    findings.push({ level: "info", label: `${countMatches(documentXml, /<w:fldChar\b/g)} field markers`, detail: instr.join(" · ") });
  }

  const hasToc = instr.some((text) => /^\s*TOC\b/i.test(text));
  findings.push({
    level: hasToc ? "ok" : "info",
    label: hasToc ? "Existing table of contents" : "No existing table of contents",
    ...(hasToc ? {} : { detail: "The export adds one automatically when the source has headings." }),
  });

  // 封面：首节在正文第一段就结束（有 pPr/sectPr）或存在 Title 样式段落
  const hasTitle = /<w:pStyle w:val="Title"\s*\/>/.test(documentXml);
  const earlySection = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<w:sectPr\b/.test(documentXml);
  findings.push({
    level: hasTitle || earlySection ? "ok" : "info",
    label: hasTitle || earlySection ? "Cover-like first page detected" : "No cover page detected",
  });

  findings.push({
    level: macro ? "warn" : "ok",
    label: macro ? "Contains VBA macros (word/vbaProject.bin)" : "No VBA macros",
    ...(macro
      ? { detail: "Macros are never executed; pandoc only reads styles, page setup and headers/footers, so they do not reach the output." }
      : {}),
  });

  const trackChanges = settingsXml !== null && /<w:trackRevisions\b/.test(settingsXml);
  if (trackChanges) {
    findings.push({ level: "info", label: "Track changes is on in the template", detail: "New edits may open as revisions." });
  }

  const warnings = findings.filter((finding) => finding.level === "warn").length;
  const verdict = warnings === 0 ? "ok" : "warning";
  const summaryParts = [
    stylesXml === null ? "no styles" : `${countMatches(stylesXml, /<w:style\b/g)} styles`,
    `${headers.length + footers.length} header/footer`,
    macro ? "macros" : "no macros",
  ];
  return {
    requested,
    path,
    ok: true,
    verdict,
    summary:
      verdict === "warning"
        ? `${summaryParts.join(" · ")} — ${warnings} warning${warnings === 1 ? "" : "s"} (export still works)`
        : `${summaryParts.join(" · ")} — ready`,
    findings,
  };
}

/** 读一个条目；不存在 / 读失败回 null（体检不因为单个条目失败而中断） */
async function readText(zip: JSZip, name: string): Promise<string | null> {
  const entry = zip.file(name);
  if (entry === null) return null;
  try {
    return await entry.async("string");
  } catch {
    return null;
  }
}
