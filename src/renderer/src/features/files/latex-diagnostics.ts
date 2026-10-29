/**
 * 编译问题 → 编辑器行内标记（`@codemirror/lint` 的 Diagnostic）的**纯**映射。
 *
 * 编译结果里每条问题已经有 `file / line / kind`（主进程 `parse-log.ts`），这里只做
 * 「这一条属不属于眼前这个文件、落在第几个字符」——不重新解析日志，也不猜列号
 * （TeX 的错误行号是行级的，`-file-line-error` 不给列）。
 *
 * 三个决定：
 * - **只画 error / warning，不画 layout**：真实论文几乎每篇都有 Overfull hbox，
 *   把整篇涂满波浪线等于没有标记。版式提示仍在问题抽屉里（那一处有自己的分组）。
 * - **文件路径两侧都归一**（正斜杠 + 小写 + 去掉 `./`）：日志里的 `sections/intro.tex`
 *   与面板给的 `C:\paper\sections\intro.tex` 必须能对上——Windows 上大小写还不敏感。
 * - **一行一条**：同一条消息在日志里出现两次（LaTeX 会重复报）只画一次。
 */
import type { LatexIssue } from "../../../../shared/latex.ts";

export interface InlineDiagnostic {
  /** 文档内字符区间（CodeMirror 口径） */
  from: number;
  to: number;
  severity: "error" | "warning";
  /** 悬停时看到的一句话（日志原文，去掉换行） */
  message: string;
}

/** 统一路径形状：正斜杠、小写、去掉前导 `./` */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** 日志里的相对文件名 → 绝对路径（`file` 本身就是绝对路径时原样用） */
export function issueAbsolutePath(projectDir: string, file: string): string {
  if (/^[A-Za-z]:[\\/]/.test(file) || file.startsWith("/")) return file;
  const base = projectDir.replace(/[\\/]+$/, "");
  return `${base}/${file.replace(/^\.\//, "")}`;
}

/** 每行在文档里的起点（0 基行号 → 字符下标）；最后一项是文档长度 */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 一次编译的问题 → 眼前这个文件的行内标记 */
export function inlineDiagnostics(
  issues: readonly LatexIssue[],
  docText: string,
  filePath: string,
  projectDir: string,
): InlineDiagnostic[] {
  const target = normalizePath(filePath);
  const starts = lineStarts(docText);
  const lineCount = starts.length;
  const seen = new Set<string>();
  const out: InlineDiagnostic[] = [];

  for (const issue of issues) {
    if (issue.file === null || issue.line === null) continue;
    if (issue.kind === "layout") continue;
    if (normalizePath(issueAbsolutePath(projectDir, issue.file)) !== target) continue;
    const line = Math.trunc(issue.line);
    if (line < 1 || line > lineCount) continue;
    const from = starts[line - 1] ?? 0;
    const next = line < lineCount ? (starts[line] ?? docText.length) : docText.length;
    // 行尾的换行不属于这一行；空行没有可画的范围
    const to = Math.max(from, next - (next > from && docText[next - 1] === "\n" ? 1 : 0));
    if (to <= from) continue;
    const message = issue.message.replace(/\s*\n\s*/g, " ").trim();
    const key = `${line}\u0000${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ from, to, severity: issue.kind === "error" ? "error" : "warning", message });
  }

  return out.sort((a, b) => a.from - b.from);
}
