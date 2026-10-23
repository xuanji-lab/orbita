/**
 * agent 的 LaTeX 工具：compile_latex（PR1）与 new_paper（PR2）。
 *
 * 形态与 terminal-tools.ts / browser-tools.ts 完全同构：这一层**只是翻译**——
 * 参数 → latexRequest / newPaperRequest → 等回执 → pi 工具结果。latexmk、.log 解析、
 * 并发、项目目录的授权与模板写盘全在主进程（main/latex/）。agent 进程不碰 fs 策略，
 * 也不持有「哪个项目在编」的状态。
 *
 * 为什么它值得一个专门的工具而不是让模型拼 `latexmk` 走 bash：
 *   1. 结果要结构化——状态、页数、`file:line` 的错与告警。让模型从 latexmk 的
 *      stdout 里自己擤出「第几行」既不可靠也贵。
 *   2. 成功判据不能是退出码（见 run.ts 的文件头），这条判断只有一处实现才正确。
 *   3. 并发互斥：同一个项目两次 latexmk 会互相写坏 .aux，这个状态需要一个
 *      活着的宿主来记——agent 进程每轮都是新的。
 *
 * 输出纪律：**成功时只给一行摘要 + 至多十几个告警**。latexmk 的日志动辄上千行，
 * 全塞进上下文的结果是模型对着 Overfull hbox 修排版而不是回答用户；真正的
 * 日志尾巴只在 compile-error 时带（≤ 8 KB，由主进程截好）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  LATEX_TIMEOUT_MS,
  isLatexEngine,
  type LatexEngine,
  type LatexIssue,
  type LatexResult,
  type LatexRunOutcome,
  type NewPaperOutcome,
  type NewPaperRequest,
  type NewPaperResult,
} from "../shared/latex.ts";
import type { RequestBroker } from "./request-broker.ts";

/** 本工具集的名字。权限档描述（describePermissionMode）与测试都认这一份 */
export const LATEX_TOOL_NAMES = ["compile_latex", "new_paper"] as const;

/** 结果正文里最多列几条：错全列（修完重编即可），告警只列头部——它们是次要信号 */
const MAX_ERRORS_SHOWN = 20;
const MAX_WARNINGS_SHOWN = 10;

/**
 * 工具等回执的上限。**必须比编译本身的硬上限长**：RequestBroker 默认 30 秒，
 * 而一次真实编译可以跑满 LATEX_TIMEOUT_MS（120 秒）——用默认值的话，第 31 秒
 * 工具就拿到「主进程没回执」，可 latexmk 还在跑，模型会以为编译失败了。
 */
const BROKER_TIMEOUT_MS = LATEX_TIMEOUT_MS + 30_000;

/**
 * 建模板的回执上限。写三份小文件是毫秒级，不需要编译那个长超时；
 * 留 30 秒只是「主进程失联」的兜底（RequestBroker 的默认值）
 */
const NEW_PAPER_TIMEOUT_MS = 30_000;

export interface LatexToolContext {
  /** 会话 cwd：dir 相对路径的解析基准（主进程按同一基准解析并做授权） */
  cwd: string;
}

/** 只要 broker 的 request——测试可以直接嗂一个固定回执的假货 */
export type LatexToolBroker = Pick<RequestBroker, "request">;

export function createLatexTools(
  broker: LatexToolBroker,
  sessionId: string,
  context: LatexToolContext,
): ToolDefinition[] {
  /**
   * 发请求并等回执；这一轮被停掉（abort）就立刻放手（terminal-tools.ts 同款）。
   * 两种请求（编译 / 建模板）只差事件名与超时，配对与中止逻辑共用一份。
   */
  const requestReply = async <T extends { ok: boolean }>(
    event: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<T> => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<T>(event, timeoutMs);
    return signal === undefined
      ? await pending
      : await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
          ),
        ]);
  };

  const compileWith = async (
    compileRequest: { dir?: string; main?: string; engine?: LatexEngine },
    signal: AbortSignal | undefined,
  ) => {
    const result = await requestReply<LatexRunOutcome>(
      { type: "latexRequest", sessionId, request: compileRequest },
      BROKER_TIMEOUT_MS,
      signal,
    );
    if (!result.ok) throw new Error(result.error);
    return { content: [{ type: "text" as const, text: describe(result.result) }], details: undefined };
  };

  /** 非空字符串才算给了（模型常传 "" 表示「没有」） */
  const text = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };

  const compile: ToolDefinition = {
    name: "compile_latex",
    label: "compile_latex",
    description:
      "Compile a LaTeX project with latexmk and return a structured result: status, engine, page count, " +
      "errors with file:line, and warnings. The PDF lands in <dir>/build/. Use it whenever the user wants " +
      "their paper compiled, or after you edited .tex sources and need to know whether it still builds. " +
      "dir defaults to the session working directory; main is only needed when the directory has several " +
      ".tex files and no main.tex. Engine is detected from the document (CJK → xelatex) unless you pass one.",
    promptSnippet:
      "Compile a LaTeX project with latexmk; returns status, pages, and errors with file:line (never raw logs on success).",
    promptGuidelines: [
      "Read errors top-down and fix the first one before recompiling: later errors are usually consequences of it.",
      "Do not start a second compile while one is running — the same project is mutex-guarded and the call is refused.",
      "Layout warnings (Overfull/Underfull hbox) do not mean the build failed; leave them alone unless the user asks.",
      `Work in ${context.cwd} unless the user points at another directory.`,
    ],
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description:
            "Directory that holds the .tex file, absolute or relative to the session working directory. " +
            "It must resolve inside the session's authorized directories. Omit to compile the session working directory.",
        },
        main: {
          type: "string",
          description:
            "Main .tex file, relative to dir. Only needed when the directory has no main.tex and more than one .tex file.",
        },
        engine: {
          type: "string",
          description: 'Optional engine override: "pdf" (pdflatex), "xelatex" or "lualatex". Detected automatically otherwise.',
        },
      },
      required: [],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const dir = text(args["dir"]);
      const main = text(args["main"]);
      const engine = text(args["engine"]);
      if (engine !== undefined && !isLatexEngine(engine)) {
        throw new Error(`engine must be one of "pdf", "xelatex", "lualatex" (got "${engine}").`);
      }
      // 校验之后才拿得到 LatexEngine 类型：收窄与请求类型同源，不靠 as
      const picked: LatexEngine | undefined = engine !== undefined && isLatexEngine(engine) ? engine : undefined;
      return compileWith(
        {
          ...(dir === undefined ? {} : { dir }),
          ...(main === undefined ? {} : { main }),
          ...(picked === undefined ? {} : { engine: picked }),
        },
        signal,
      );
    },
  };

  /**
   * new_paper：写一份可编译的最小论文骨架。模板内容与授权都在主进程（目的一是
   * 「agent 不碰 fs 策略」，二是模板只有一份真源、agent 版本不随轮次漂移）。
   * 目标目录必须不存在或为空——这个工具不覆盖任何已有文件。
   */
  const newPaper: ToolDefinition = {
    name: "new_paper",
    label: "new_paper",
    description:
      "Create a new LaTeX paper project from the built-in minimal template: main.tex (article class, one figure, " +
      "one table, one equation), refs.bib with three real citations, and figures/example.png. The target " +
      "directory must be missing or empty — existing files are never overwritten. Returns the file list; " +
      "build it afterwards with compile_latex. Use this instead of hand-writing a skeleton when the user asks " +
      "for a new paper or report to start from.",
    promptSnippet:
      "Scaffold a paper project (main.tex + refs.bib + placeholder figure) in a missing or empty directory, then compile it.",
    promptGuidelines: [
      "Give new_paper a new directory (for example the paper's short title, relative to the session working directory): a non-empty directory is refused rather than overwritten.",
      "After it succeeds, call compile_latex with the same dir — the tool already reports the exact next step.",
      "The template text is a placeholder: replace title/sections/abstract per the user's request instead of shipping the sample prose.",
    ],
    parameters: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description:
            "Directory for the new project: absolute or relative to the session working directory. It must be " +
            "missing or empty, and must resolve inside the session's authorized directories. Omit to use the " +
            "session working directory (only works when that directory is empty).",
        },
        title: {
          type: "string",
          description:
            "Optional paper title written into \\title{}. LaTeX special characters are escaped. " +
            "Defaults to a neutral placeholder title.",
        },
      },
      required: [],
    } as never,
    async execute(_toolCallId, params, signal) {
      const args = (params ?? {}) as Record<string, unknown>;
      const dir = text(args["dir"]);
      const title = text(args["title"]);
      const request: NewPaperRequest = {
        ...(dir === undefined ? {} : { dir }),
        ...(title === undefined ? {} : { title }),
      };
      const result = await requestReply<NewPaperOutcome>(
        { type: "newPaperRequest", sessionId, request },
        NEW_PAPER_TIMEOUT_MS,
        signal,
      );
      if (!result.ok) throw new Error(result.error);
      return { content: [{ type: "text" as const, text: describeNewPaper(result.result) }], details: undefined };
    },
  };

  return [compile, newPaper];
}

/** 结果 → 给模型的正文。每段都要回答「下一步干什么」，不是状态回显 */
function describe(result: LatexResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const lines: string[] = [];
  if (result.status === "ok" || result.status === "warning-only") {
    lines.push(
      `LaTeX build succeeded: status "${result.status}", engine ${result.engine}, ` +
        `${result.pages === null ? "page count unknown" : `${result.pages} pages`} in ${seconds}s.`,
    );
    if (result.main !== "") lines.push(`Main: ${result.main}`);
    if (result.pdf !== null) lines.push(`PDF: ${result.pdf}`);
  } else if (result.status === "not-installed") {
    lines.push(
      "LaTeX could not run: latexmk is not installed on this machine. " +
        "Tell the user to install TeX Live (or MiKTeX on Windows / MacTeX on macOS) and retry.",
    );
  } else if (result.status === "no-main-file") {
    lines.push(`LaTeX could not start: no main file was chosen (engine ${result.engine}).`);
  } else if (result.status === "timeout") {
    lines.push(
      `LaTeX build timed out after ${seconds}s and was killed (engine ${result.engine}` +
        `${result.main === "" ? "" : `, main ${result.main}`}). ` +
        "A document that needs longer than this usually has an infinite loop (a runaway \\loop, a missing \\end) " +
        "or macro package trouble — inspect the partial errors below.",
    );
  } else if (result.status === "cancelled") {
    lines.push(`LaTeX build was cancelled after ${seconds}s (the app is shutting down or the build was stopped).`);
  } else {
    lines.push(
      `LaTeX build failed: status "compile-error", engine ${result.engine}` +
        `${result.main === "" ? "" : `, main ${result.main}`} in ${seconds}s.`,
    );
    if (result.pdf !== null) {
      lines.push(
        result.pdfFresh
          ? `A PDF from this run exists at ${result.pdf}, but the build reported errors.`
          : `A PDF from an earlier build is still on disk at ${result.pdf}; it may not reflect the current sources.`,
      );
    }
  }

  // 本次没写日志：错误来自上一轮 / 或只是无事可做，必须让模型知道证据来源
  if (result.logStale) {
    lines.push(
      "",
      result.errors.length > 0 || result.warnings.length > 0
        ? "Note: this run did not write a new .log — the errors and warnings below are from the previous " +
            "build in this directory (its page count is not reused)."
        : "Note: this run did not write a new .log — latexmk reported success without rebuilding, so the " +
            "PDF on disk was already up to date and no page count is reported.",
    );
  }

  // not-installed 的那条「errors」就是上面同一句安装建议，不重复列（评审 A8）
  if (result.status !== "not-installed" && result.errors.length > 0) {
    lines.push("", `Errors (${result.errors.length}):`);
    for (const issue of result.errors.slice(0, MAX_ERRORS_SHOWN)) lines.push(`- ${formatIssue(issue)}`);
    if (result.errors.length > MAX_ERRORS_SHOWN) {
      lines.push(`- …and ${result.errors.length - MAX_ERRORS_SHOWN} more errors (fix the first ones and recompile).`);
    }
  }

  const warnings = result.warnings;
  if (warnings.length > 0) {
    const layout = warnings.filter((issue) => issue.kind === "layout").length;
    lines.push("", `Warnings (${warnings.length}${layout > 0 ? `, ${layout} layout` : ""}):`);
    for (const issue of warnings.slice(0, MAX_WARNINGS_SHOWN)) lines.push(`- ${formatIssue(issue)}`);
    if (warnings.length > MAX_WARNINGS_SHOWN) {
      lines.push(`- …and ${warnings.length - MAX_WARNINGS_SHOWN} more warnings.`);
    }
  }

  if (result.logTail !== null) {
    lines.push(
      "",
      "Log tail (last bytes of the .log — use it to find the context the error lines came from):",
      "---",
      result.logTail,
    );
  }
  return lines.join("\n");
}

/** `main.tex:4 — message`；缺文件/行时退化成只有消息 */
function formatIssue(issue: LatexIssue): string {
  const where =
    issue.file === null ? "" : issue.line === null ? `${issue.file} — ` : `${issue.file}:${issue.line} — `;
  return `${where}${issue.message}`;
}

/**
 * 建模板成功 → 给模型的正文：文件清单 + **下一步的命令**。
 * 不给「已创建、一切正常」这种回显：模板里的正文全是占位符，模型下一句必须
 * 去编译并换成用户真正要写的内容。
 */
function describeNewPaper(result: NewPaperResult): string {
  const lines = [`Created a paper project in ${result.dir}:`];
  for (const file of result.files) lines.push(`- ${file}`);
  lines.push(
    "",
    `Next: run compile_latex with dir "${result.dir}" — the PDF lands in build/main.pdf.`,
    "Then replace the template prose, the table numbers and the placeholder figure with the user's actual content.",
  );
  return lines.join("\n");
}
