/**
 * 模板体检的**句子**（2026-11-15 验收 P1-3）。
 *
 * 主进程只回结构化事实（`DocxTemplateReport`：kind + 数字 / 枚举），句子一律在这里
 * 按当前语言拼。原先 `main/docx-export/template.ts` 直接拼英文字面量，等于把
 * 「文案只在 messages-zh/en 两张表里」这条约定拆掉——中文界面里整块体检结论是英文。
 *
 * 纯函数：不读全局语言，`t` 由调用方给（与 features 里其它 *_text 同一纪律）。
 */
import type { Messages } from "../../messages-en.ts";
import type {
  DocxTemplateFinding,
  DocxTemplateProblem,
  DocxTemplateReport,
} from "../../../../shared/docx-export.ts";

export interface FindingLine {
  level: DocxTemplateFinding["level"];
  /** 一行结论（图标 + 这句） */
  label: string;
  /** 第二行解释（可无） */
  detail: string | null;
}

/** 不可用原因的人话 */
export function problemText(problem: DocxTemplateProblem, t: Messages): string {
  const copy = t.settings.docxTemplateReport.problem;
  switch (problem.kind) {
    case "none-selected":
      return copy.noneSelected;
    case "not-found":
      return copy.notFound(problem.path, problem.detail);
    case "pandoc-missing":
      return copy.pandocMissing(problem.message);
    case "builtin-unavailable":
      return copy.builtinUnavailable(problem.detail);
    case "empty":
      return copy.empty;
    case "too-large":
      return copy.tooLarge(problem.mb);
    case "encrypted":
      return copy.encrypted;
    case "not-zip":
      return copy.notZip;
    case "corrupt":
      return copy.corrupt(problem.detail);
    case "no-document":
      return copy.noDocument;
  }
}

/** 一条体检结论的两行文案 */
export function findingLine(finding: DocxTemplateFinding, t: Messages): FindingLine {
  const copy = t.settings.docxTemplateReport.finding;
  switch (finding.kind) {
    case "content-types-missing":
      return { level: finding.level, label: copy.contentTypesMissing, detail: copy.contentTypesMissingDetail };
    case "styles-missing":
      return { level: finding.level, label: copy.stylesMissing, detail: copy.stylesMissingDetail };
    case "styles":
      return { level: finding.level, label: copy.styles(finding.styles, finding.headings), detail: null };
    case "headings-missing":
      return { level: finding.level, label: copy.headingsMissing, detail: copy.headingsMissingDetail };
    case "east-asian":
      return { level: finding.level, label: copy.eastAsian(finding.language), detail: null };
    case "page-setup-missing":
      return { level: finding.level, label: copy.pageSetupMissing, detail: copy.pageSetupMissingDetail };
    case "sections":
      return {
        level: finding.level,
        label: copy.sections(finding.count, finding.body, finding.width, finding.height),
        detail: null,
      };
    case "numbering-missing":
      return { level: finding.level, label: copy.numberingMissing, detail: copy.numberingMissingDetail };
    case "numbering":
      return { level: finding.level, label: copy.numbering(finding.count), detail: null };
    case "header-footer-missing":
      return { level: finding.level, label: copy.headerFooterMissing, detail: copy.headerFooterMissingDetail };
    case "header-footer":
      return { level: finding.level, label: copy.headerFooter(finding.headers, finding.footers), detail: null };
    case "fields":
      return { level: finding.level, label: copy.fields(finding.count, finding.instructions.join(" · ")), detail: null };
    case "toc":
      return finding.present
        ? { level: finding.level, label: copy.toc, detail: null }
        : { level: finding.level, label: copy.tocMissing, detail: copy.tocMissingDetail };
    case "cover":
      return finding.present
        ? { level: finding.level, label: copy.cover, detail: null }
        : { level: finding.level, label: copy.coverMissing, detail: null };
    case "macros":
      return finding.present
        ? { level: finding.level, label: copy.macrosPresent, detail: copy.macrosPresentDetail }
        : { level: finding.level, label: copy.macros, detail: null };
    case "track-changes":
      return { level: finding.level, label: copy.trackChanges, detail: copy.trackChangesDetail };
    case "builtin-unavailable":
      return { level: finding.level, label: copy.builtinUnavailable, detail: finding.detail };
    case "problem":
      return { level: finding.level, label: problemText(finding.problem, t), detail: null };
  }
}

/**
 * 摘要那一行（设置页模板一行的 note）。
 * `project` = 用源文件旁边那份 template.docx，没有实体能体检。
 */
export function reportText(report: DocxTemplateReport, t: Messages): string {
  if (report.note === "project") return t.settings.docxTemplateProjectHint;
  if (!report.ok || report.summary === null) {
    return report.problem === null ? t.settings.docxTemplateInvalid : problemText(report.problem, t);
  }
  const { styles, headerFooter, macros, warnings } = report.summary;
  return t.settings.docxTemplateReport.summary(styles, headerFooter, macros, warnings);
}

/** 展开列表用的结论（去掉与摘要重复的那条 problem） */
export function reportFindings(report: DocxTemplateReport, t: Messages): FindingLine[] {
  return report.findings
    .filter((finding) => finding.kind !== "problem")
    .map((finding) => findingLine(finding, t));
}
