/**
 * 编译结局的**会话级寄存**：按项目目录存，活过标签切换与面板卸载（2026-11-15 验收 P0-4）。
 *
 * 为什么不在 hook 的 state 里：`latexContext` 跟着激活标签走，切到 pptx / docx 时它变
 * null，hook 按 key 重置——一次「失败 · 3 个错误」就在一次无意的标签切换后自己消失了，
 * 问题抽屉（这套工作台里唯一的错误入口）退回「无问题」。用户会以为编译成功了。
 *
 * 只在内存里：它描述的是**这一轮应用运行里编过什么**，不是磁盘事实（磁盘事实是
 * LatexProjectInfo 的 PDF / 源码 mtime，每次都会重新问主进程）。
 *
 * 纯 Map + 两个函数，`node --test` 直接可用（hook 里连着 React，测不了）。
 */
import type { LatexIssue, LatexStatus } from "@shared/latex";

/** 一次编译的摘要（界面只需要这些；错误全文在日志里） */
export interface LatexBuildSummary {
  status: LatexStatus;
  pages: number | null;
  durationMs: number;
  errors: LatexIssue[];
  warnings: LatexIssue[];
  /** 本次结果里的 PDF 绝对路径（失败时可能是上一版的） */
  pdfPath: string | null;
  finishedAt: number;
}

/** 一个项目目录 → 最近一次编译的摘要 */
const builds = new Map<string, LatexBuildSummary>();

/** 记下这一轮的结局（同一个项目的新一轮覆盖旧的） */
export function rememberBuild(dir: string, summary: LatexBuildSummary): void {
  builds.set(dir, summary);
}

/** 取回那个项目最近一次的结局；没编过 = null（界面据此显示「还没编译」而不是假报错） */
export function recallBuild(dir: string): LatexBuildSummary | null {
  return builds.get(dir) ?? null;
}

/** 清空（测试用） */
export function clearBuildStore(): void {
  builds.clear();
}
