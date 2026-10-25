/**
 * 论文工作台 · 编译条的**纯视图逻辑**（状态推导 / PDF 过期判定 / 问题分组）。
 *
 * 独立成模块的理由同 tree-view.ts / preview-view.ts：LatexBuildBar.tsx 连着 React
 * 与 IPC，`node --test` 加载不了；这里全是输入 → 输出，直接可测。事实（项目目录、
 * PDF mtime、日志条目）由主进程给，这里只决定「按钮该是什么样」。
 */
import type { LatexIssue, LatexResolvedPackage, LatexStatus } from "@shared/latex";
// 值导入走相对路径（带 .ts）：`node --test` 不认 vite / tsconfig 的 @shared 别名，
// 类型导入会被剥掉所以无所谓，函数导入会在加载时就找不到模块。
import { miktexPendingOf } from "../../../../shared/latex.ts";

/**
 * 编译条的显示态（原型场景 1 / 3）：
 * - idle：安静（PDF 已是最新，或这轮还没编过）
 * - dirty：源码比 PDF 新 → 编译按钮是**唯一的 accent 主操作**
 * - running：编译中，按钮换成取消
 * - success：这一轮编成功且 PDF 仍是最新的
 * - error：这一轮失败（PDF 保留上一版，状态行写明它是旧的）
 */
export type LatexBarState = "idle" | "dirty" | "running" | "success" | "error";

/** 编译结局里算「失败」的那几档。cancelled 不算失败（状态行另有说法） */
export function isFailedStatus(status: LatexStatus): boolean {
  return status === "compile-error" || status === "timeout" || status === "not-installed" || status === "no-main-file";
}

export function latexBarState(input: {
  running: boolean;
  /** 本面板里的上一次编译结局；null = 还没编过 */
  lastStatus: LatexStatus | null;
  /** PDF 不存在，或源码比它新（见 pdfStale） */
  stale: boolean;
  hasPdf: boolean;
}): LatexBarState {
  if (input.running) return "running";
  if (input.lastStatus !== null && isFailedStatus(input.lastStatus)) return "error";
  if (input.stale) return "dirty";
  if (input.hasPdf && (input.lastStatus === "ok" || input.lastStatus === "warning-only")) return "success";
  return "idle";
}

/**
 * PDF 是否过期：源码（主文件 / .tex / .bib / .cls / .sty）比 PDF 新，或压根没有 PDF。
 *
 * 比较的是 **mtime**，不是「这次编译写没写」——latexmk 在源码没改时说 "Nothing to
 * do"，PDF 不动，仍然是「PDF 是最新的」。反过来，agent 改完源码还没编，mtime 就
 * 已经越过 PDF，按钮该变主操作。没有源码事实（sourceModifiedAt = null，项目解析
 * 不到主文件）时不说它过期——宁可安静，也不假报一个「有改动」。
 */
export function pdfStale(pdfModifiedAt: number | null, sourceModifiedAt: number | null): boolean {
  if (sourceModifiedAt === null) return false;
  if (pdfModifiedAt === null) return true;
  return sourceModifiedAt > pdfModifiedAt;
}

/** 缺宏包：从 `File \`x.sty' not found` 里认出来的那一类问题 */
export interface MissingPackage {
  file: string | null;
  line: number | null;
  message: string;
  /** 缺的文件本身（ctexart.cls / booktabs.sty） */
  missing: string;
  /** tlmgr 的包名（去掉扩展名；tlmgr install 用的就是这个） */
  packageName: string;
}

export interface LatexIssueGroups {
  /** 真错（不含缺宏包） */
  errors: LatexIssue[];
  /** 告警（不含版式提示） */
  warnings: LatexIssue[];
  /** Overfull / Underfull：默认折在最后，不算「有问题」 */
  layout: LatexIssue[];
  /** 缺宏包单列：它有自己的动作（在终端安装） */
  packages: MissingPackage[];
  /** MiKTeX 在等用户确认安装（编译看起来卡住了）；与缺宏包分开说 */
  pending: LatexIssue[];
  /** 计数：错误含缺宏包，告警不含版式；pending 两边都不算 */
  errorCount: number;
  warningCount: number;
}

/**
 * 日志里的缺包行。TeX 的两种写法都认：
 *   `! LaTeX Error: File \`ctexart.cls' not found.`
 *   `File 'booktabs.sty' not found.`
 * 只认 .sty / .cls：缺字体（Font ... not found）不是 tlmgr 能装的东西，留在 warnings。
 */
const MISSING_PACKAGE = /File\s+[`'‘‚"]?([^`'‘’‚"\s]+\.(?:sty|cls))['’‘‚"]?\s+not found/i;

export function missingPackageOf(message: string): { missing: string; packageName: string } | null {
  const match = MISSING_PACKAGE.exec(message);
  if (match === null) return null;
  const missing = match[1] ?? "";
  if (missing === "") return null;
  return { missing, packageName: missing.replace(/\.(?:sty|cls)$/i, "") };
}

function issueKey(issue: LatexIssue): string {
  return `${issue.file ?? ""}:${issue.line ?? 0}:${issue.message}`;
}

/** 去重（日志会被解析器按 file:line:message 去过一次；陈旧日志也可能重复） */
function dedupe(issues: readonly LatexIssue[]): LatexIssue[] {
  const seen = new Set<string>();
  const out: LatexIssue[] = [];
  for (const issue of issues) {
    const key = issueKey(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/**
 * 把一次编译的 errors / warnings 分成界面上的四类。缺宏包从两边都可以认出来
 * （它可能被解析器归进 errors，也可能只在 warnings 里）——按消息判类，不按数组判。
 */
export function groupLatexIssues(
  errors: readonly LatexIssue[],
  warnings: readonly LatexIssue[],
): LatexIssueGroups {
  const groups: LatexIssueGroups = {
    errors: [],
    warnings: [],
    layout: [],
    packages: [],
    pending: [],
    errorCount: 0,
    warningCount: 0,
  };
  const seenPackages = new Set<string>();
  const take = (issue: LatexIssue): void => {
    // 「引擎在等你确认」先认领：这类行的原文常常也带着别的关键词，混进告警里
    // 就失去了「卡住不是崩了」那层意思
    if (miktexPendingOf(issue.message)) {
      groups.pending.push(issue);
      return;
    }
    const missing = missingPackageOf(issue.message);
    if (missing !== null) {
      if (seenPackages.has(missing.packageName)) return;
      seenPackages.add(missing.packageName);
      groups.packages.push({ file: issue.file, line: issue.line, message: issue.message, ...missing });
      return;
    }
    if (issue.kind === "layout") {
      groups.layout.push(issue);
      return;
    }
    if (issue.kind === "warning") {
      groups.warnings.push(issue);
      return;
    }
    groups.errors.push(issue);
  };
  dedupe(errors).forEach(take);
  dedupe(warnings).forEach(take);
  groups.errors = dedupe(groups.errors);
  groups.warnings = dedupe(groups.warnings);
  groups.layout = dedupe(groups.layout);
  groups.pending = dedupe(groups.pending);
  groups.errorCount = groups.errors.length + groups.packages.length;
  groups.warningCount = groups.warnings.length;
  return groups;
}

/** `3.9 s`：一位小数，与原型一致 */
export function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 编译中的计时：`0:03` / `1:12`（分钟不进位成小时——一次编译封顶十分钟） */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * 引擎的界面名。契约里的 "pdf" 就是 latexmk 的 `-pdf` 车道（pdflatex），
 * 对写论文的人说「自动 / pdflatex / xelatex / lualatex」比说 "pdf" 准确。
 */
export function engineLabel(engine: string): string {
  return engine === "pdf" ? "pdflatex" : engine;
}

/** 编译快捷键的显示写法：mac 用 Cmd，其余 Ctrl（实际判定在 FilesPanel 的 keydown） */
export function shortcutLabel(platform: string): string {
  return platform === "darwin" ? "Cmd+B" : "Ctrl+B";
}

/** 问题行上的定位：`main.tex:24`；只有文件 / 只有行 / 都没有时如实退化 */
export function issueLocation(issue: { file: string | null; line: number | null }): string {
  if (issue.file === null) return issue.line === null ? "" : String(issue.line);
  return issue.line === null ? issue.file : `${issue.file}:${issue.line}`;
}

/**
 * 缺包的显示名：反查命中了就用包名，没命中就**如实显示文件名**。
 * 界面的「未知包」文案单独说，不在这里把文件名冒充成包名。
 */
export function packageLabel(missing: string, packageName: string | null): string {
  if (packageName !== null && packageName !== "") return packageName;
  return missing;
}

/**
 * 缺包行第二行该说哪一句。**这里是「原因 → 文案」的唯一裁决点**，界面只做查表：
 * 把「文件名不合法」「没有 tlmgr / mpm」「命令出错」「真·未知包」「这次没查」混成
 * 一句「没找到 tlmgr」，会让一台装着 TeX Live 的机器被劝去装一个不存在的工具
 * （评审抓到的就是这一条）。
 */
export type PackageNoteKind =
  | "looking-up"
  | "installed"
  | "none"
  | "invalid-name"
  | "no-tools"
  | "tool-error"
  | "not-looked-up"
  | "unknown";

export function packageNoteKind(resolution: LatexResolvedPackage | undefined): PackageNoteKind {
  if (resolution === undefined) return "looking-up";
  if (resolution.installed) return "installed";
  if (resolution.packageName !== null) return "none";
  switch (resolution.reason) {
    case "invalid-name":
      return "invalid-name";
    case "no-tools":
      return "no-tools";
    case "tool-error":
      return "tool-error";
    case "not-looked-up":
      return "not-looked-up";
    default:
      return "unknown";
  }
}
