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
import type {
  DocxTemplateFinding,
  DocxTemplateMode,
  DocxTemplateProblem,
  DocxTemplateReport,
} from "../../shared/docx-export.ts";

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

  const unusable = (problem: DocxTemplateProblem): DocxTemplateReport => ({
    requested,
    path,
    ok: false,
    verdict: "unusable",
    problem,
    summary: null,
    note: null,
    findings: [...findings, { level: "warn", kind: "problem", problem }],
  });

  if (bytes.byteLength === 0) return unusable({ kind: "empty" });
  if (bytes.byteLength > DOCX_TEMPLATE_MAX_BYTES) {
    return unusable({ kind: "too-large", mb: Math.round(DOCX_TEMPLATE_MAX_BYTES / 1024 / 1024) });
  }
  if (isOle2(bytes)) return unusable({ kind: "encrypted" });
  if (!isZip(bytes)) return unusable({ kind: "not-zip" });

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (cause) {
    return unusable({ kind: "corrupt", detail: cause instanceof Error ? cause.message : String(cause) });
  }

  const documentXml = await readText(zip, "word/document.xml");
  if (documentXml === null) return unusable({ kind: "no-document" });
  const stylesXml = await readText(zip, "word/styles.xml");
  const settingsXml = await readText(zip, "word/settings.xml");
  const numberingXml = await readText(zip, "word/numbering.xml");
  const contentTypes = await readText(zip, "[Content_Types].xml");
  const macro = zip.file("word/vbaProject.bin") !== null;

  // ── 结构：pandoc 只读 styles / 页面设置 / 页眉页脚，缺了照样能转，但要说明白 ──
  if (contentTypes === null) {
    findings.push({ level: "warn", kind: "content-types-missing" });
  }

  if (stylesXml === null) {
    findings.push({ level: "warn", kind: "styles-missing" });
  } else {
    const styles = countMatches(stylesXml, /<w:style\b/g);
    const headings = countMatches(stylesXml, HEADING_STYLE);
    findings.push({ level: "ok", kind: "styles", styles, headings });
    if (headings === 0) {
      findings.push({ level: "warn", kind: "headings-missing" });
    }
    const eastAsia = /w:eastAsia="([^"]+)"/.exec(stylesXml)?.[1];
    if (eastAsia !== undefined && eastAsia !== "") {
      findings.push({ level: "info", kind: "east-asian", language: decodeXml(eastAsia) });
    }
  }

  const sectionProps = countMatches(documentXml, /<w:sectPr\b/g);
  const bodySection = /<w:body>[\s\S]*<w:sectPr\b/.test(documentXml);
  if (sectionProps === 0) {
    findings.push({ level: "warn", kind: "page-setup-missing" });
  } else {
    const size = /<w:pgSz\b[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/.exec(documentXml);
    findings.push({
      level: "ok",
      kind: "sections",
      count: sectionProps,
      body: bodySection,
      width: size === null ? null : Number(size[1]),
      height: size === null ? null : Number(size[2]),
    });
  }

  if (numberingXml === null) {
    findings.push({ level: "info", kind: "numbering-missing" });
  } else {
    findings.push({ level: "ok", kind: "numbering", count: countMatches(numberingXml, /<w:abstractNum\b/g) });
  }

  const headers = zip.file(/^word\/header\d*\.xml$/);
  const footers = zip.file(/^word\/footer\d*\.xml$/);
  if (headers.length === 0 && footers.length === 0) {
    findings.push({ level: "warn", kind: "header-footer-missing" });
  } else {
    findings.push({ level: "ok", kind: "header-footer", headers: headers.length, footers: footers.length });
  }

  const instr = fieldInstructions(documentXml);
  if (instr.length > 0) {
    findings.push({ level: "info", kind: "fields", count: countMatches(documentXml, /<w:fldChar\b/g), instructions: instr });
  }

  const hasToc = instr.some((text) => /^\s*TOC\b/i.test(text));
  findings.push({ level: hasToc ? "ok" : "info", kind: "toc", present: hasToc });

  // 封面：首节在正文第一段就结束（有 pPr/sectPr）或存在 Title 样式段落
  const hasTitle = /<w:pStyle w:val="Title"\s*\/>/.test(documentXml);
  const earlySection = /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*?<w:sectPr\b/.test(documentXml);
  findings.push({ level: hasTitle || earlySection ? "ok" : "info", kind: "cover", present: hasTitle || earlySection });

  findings.push({ level: macro ? "warn" : "ok", kind: "macros", present: macro });

  const trackChanges = settingsXml !== null && /<w:trackRevisions\b/.test(settingsXml);
  if (trackChanges) {
    findings.push({ level: "info", kind: "track-changes" });
  }

  const warnings = findings.filter((finding) => finding.level === "warn").length;
  return {
    requested,
    path,
    ok: true,
    verdict: warnings === 0 ? "ok" : "warning",
    problem: null,
    summary: {
      styles: stylesXml === null ? null : countMatches(stylesXml, /<w:style\b/g),
      headerFooter: headers.length + footers.length,
      macros: macro,
      warnings,
    },
    note: null,
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
