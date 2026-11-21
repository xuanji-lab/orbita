/**
 * agent 的 LaTeX 工具：compile_latex（PR1）+ latex_packages。
 *
 * 形态与 terminal-tools.ts / browser-tools.ts 完全同构：这一层**只是翻译**——
 * 参数 → latexRequest → 等 latexResult → pi 工具结果。latexmk、.log 解析、
 * 并发与项目目录的授权全在主进程（main/latex/）。agent 进程不碰 fs 策略，
 * 也不持有「哪个项目在编」的状态。
 *
 * 为什么它值得一个专门的工具而不是让模型拼 `latexmk` 走 bash：
 *   1. 结果要结构化——状态、页数、`file:line` 的错与告警。让模型从 latexmk 的
 *      stdout 里自己擤出「第几行」既不可靠也贵。
 *   2. 成功判据不能是退出码（见 run.ts 的文件头），这条判断只有一处实现才正确。
 *   3. 并发互斥：同一个项目两次 latexmk 会互相写坏 .aux，这个状态需要一个
 *      活着的宿主来记——agent 进程每轮都是新的。
 *
 * 输出纪律（回执 v2）：一次编译要能让模型**自己修**——改哪个文件哪一行、原文是什么、
 * 根因在哪份证据里（.log / .blg）、日志在哪、跑了什么命令、哪一步失败。正文总长
 * 封顶 LATEX_REPLY_MAX_CHARS，砍的顺序固定：日志尾巴 → raw → layout → 产物；
 * 状态行 / Command / Log / 第一条 error 永不砍。
 */
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  LATEX_IDLE_TIMEOUT_MS,
  LATEX_REPLY_MAX_CHARS,
  LATEX_TOTAL_TIMEOUT_MS,
  isLatexEngine,
  type LatexBuildStep,
  type LatexEngine,
  type LatexEngineSource,
  type LatexIssue,
  type LatexLogRef,
  type LatexPackageOutcome,
  type LatexResolvedPackage,
  type LatexResult,
  type LatexRootRef,
  type LatexRunOutcome,
} from "../shared/latex.ts";
import { writeTextAtomic } from "../main/atomic-write.ts";
import { alignBib, sortBib, type BibSortBy } from "../main/cite/bib-edit.ts";
import { isInside, realpathInside } from "../main/path-boundary.ts";
import { resolveToolPath } from "./file-tracker.ts";
import type { RequestBroker } from "./request-broker.ts";

/** 本工具组的名字。权限档描述（describePermissionMode）与测试都认这一份 */
export const LATEX_TOOL_NAMES = ["compile_latex", "latex_packages", "edit_bib"] as const;

/** 回执正文里最多列几条：错列到 20（修完重编即可），内容告警只列头部——它们是次要信号 */
const MAX_ERRORS_SHOWN = 20;
const MAX_WARNINGS_SHOWN = 10;
const MAX_LAYOUT_SHOWN = 3;
const MAX_OUTPUTS_SHOWN = 10;

/** 单条 message 的展示上限（解析器已做一次，这里兜住合成诊断里 2 KB 的 stderr 尾巴） */
const MAX_MESSAGE_CHARS = 240;

/**
 * 工具等回执的上限。**必须比编译本身的硬上限长**：RequestBroker 默认 30 秒，
 * 而一次真实编译可以跑满 LATEX_TOTAL_TIMEOUT_MS（10 分钟）——用默认值的话，第 31 秒
 * 工具就拿到「主进程没回执」，可 latexmk 还在跑，模型会以为编译失败了。
 */
const BROKER_TIMEOUT_MS = LATEX_TOTAL_TIMEOUT_MS + 30_000;

/**
 * 缺包反查的回执上限。反查本身按 3 并发、每条最多 20 秒（packages.ts），
 * 20 个名字最坏约 140 秒——比编译短，但远超默认 30 秒。
 */
const PACKAGE_BROKER_TIMEOUT_MS = 150_000;

export interface LatexToolContext {
  /** 会话 cwd：dir 相对路径的解析基准（主进程按同一基准解析并做授权） */
  cwd: string;
  /** edit_bib 的可写根（工作区 + 附加目录）；缺席时只认 cwd */
  writeRoots?: readonly string[];
}

/** 只要 broker 的 request——测试可以直接嗂一个固定回执的假货 */
export type LatexToolBroker = Pick<RequestBroker, "request">;

export function createLatexTools(
  broker: LatexToolBroker,
  sessionId: string,
  context: LatexToolContext,
): ToolDefinition[] {
  /** 发请求并等回执；这一轮被停掉（abort）就立刻放手（terminal-tools.ts 同款） */
  const call = async (
    request: { dir?: string; main?: string; file?: string; engine?: LatexEngine },
    signal: AbortSignal | undefined,
  ) => {
    if (signal?.aborted === true) throw new Error("Stopped");
    const pending = broker.request<LatexRunOutcome>(
      { type: "latexRequest", sessionId, request },
      BROKER_TIMEOUT_MS,
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
      // 并发被拒是「稍后重试」，参数 / 授权失败是「改请求」——模型的两条路完全不同。
      // reason 由 shared 的 LatexRejectReason 给出，文案保持英文（与其它工具一致）。
      const prefix =
        result.reason === undefined
          ? "LaTeX request rejected (fix the arguments or the directory and retry): "
          : "LaTeX is busy (a build is already running — wait for it to finish, do not queue): ";
      throw new Error(`${prefix}${result.error}`);
    }
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
      "Compile a LaTeX project with latexmk and return a structured result: status, which root was built, the exact " +
      "command it ran, the step timeline, errors with file:line and the raw offending line, warnings, the log path " +
      "and size, and (for bibtex/biber failures) the diagnostics from the .blg file. Products land in each root's " +
      "own output directory (build/ by default) — the outputs in the result are authoritative, do not assume " +
      "<main>.pdf. Use it whenever the user wants their paper compiled, or after you edited .tex sources and need " +
      "to know whether it still builds. dir defaults to the session working directory; main picks a specific root; " +
      "file is the .tex you just edited, so its \"% !TEX root\" line decides which document gets built. " +
      "Engine is detected from the document (CJK → xelatex) unless you pass one.",
    promptSnippet:
      "Compile a LaTeX project with latexmk; returns status, pages, errors with file:line and raw lines, the log path, and the command that ran.",
    promptGuidelines: [
      "Read errors top-down and fix the first one before recompiling: later errors are usually consequences of it.",
      "Each error carries `raw` (the `l.N …` line TeX printed) — use it instead of guessing which token failed.",
      "Diagnostics tagged source blg come from bibtex/biber; fix those in the .bib file, not in the .tex.",
      "The full log is on disk at the path in the `Log:` line — read it with offset when the tail is not enough.",
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
            "Root .tex file to build, relative to dir. Overrides everything else; use it when the directory has " +
            "several roots and no main.tex, or to build a root other than the one the current file belongs to.",
        },
        file: {
          type: "string",
          description:
            "The .tex you just edited, relative to dir. Its leading \"% !TEX root = ...\" line is followed " +
            "(max 2 hops) to find the document that includes it. Use it instead of guessing main for chapter files.",
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
      const file = text(args["file"]);
      const engine = text(args["engine"]);
      if (engine !== undefined && !isLatexEngine(engine)) {
        throw new Error(`engine must be one of "pdf", "xelatex", "lualatex" (got "${engine}").`);
      }
      // 校验之后才拿得到 LatexEngine 类型：收窄与请求类型同源，不靠 as
      const picked: LatexEngine | undefined = engine !== undefined && isLatexEngine(engine) ? engine : undefined;
      return call(
        {
          ...(dir === undefined ? {} : { dir }),
          ...(main === undefined ? {} : { main }),
          ...(file === undefined ? {} : { file }),
          ...(picked === undefined ? {} : { engine: picked }),
        },
        signal,
      );
    },
  };

  const packages: ToolDefinition = {
    name: "latex_packages",
    label: "latex_packages",
    description:
      "Look up which TeX distribution package provides a file the build log said was not found (e.g. ctexart.cls -> " +
      "ctex) and the install command for this machine's distribution. Starts kpsewhich/tlmgr/mpm, so it takes a few " +
      "seconds: call it only when a compile error names a missing .sty/.cls file, not on every build. Never guess a " +
      "package name — if the lookup says `not-found`, ask the user instead of running tlmgr.",
    promptSnippet:
      "Map missing .sty/.cls files from the build log to their TeX Live / MiKTeX package and install command.",
    promptGuidelines: [
      "Call this only after compile_latex reported a file that was not found; it starts external tools and is slow.",
      "A `not-found` answer means the distribution has no package for that file — do not invent a `tlmgr install`.",
    ],
    parameters: {
      type: "object",
      properties: {
        missing: {
          type: "array",
          items: { type: "string" },
          description: 'File names as they appear in the log, e.g. ["ctexart.cls", "algorithm2e.sty"] (at most 20).',
        },
      },
      required: ["missing"],
    } as never,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted === true) throw new Error("Stopped");
      const args = (params ?? {}) as Record<string, unknown>;
      const raw = args["missing"];
      const missing = (Array.isArray(raw) ? raw : []).filter(
        (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
      );
      if (missing.length === 0) {
        throw new Error('missing is required — pass the file names the build log said were not found (e.g. ["ctexart.cls"]).');
      }
      const pending = broker.request<LatexPackageOutcome>(
        { type: "latexPackageRequest", sessionId, missing },
        PACKAGE_BROKER_TIMEOUT_MS,
      );
      const outcome =
        signal === undefined
          ? await pending
          : await Promise.race([
              pending,
              new Promise<never>((_resolve, reject) =>
                signal.addEventListener("abort", () => reject(new Error("Stopped")), { once: true }),
              ),
            ]);
      return { content: [{ type: "text" as const, text: describePackages(outcome) }], details: undefined };
    },
  };

  /**
   * .bib 的「排序 / 等号对齐」。**只给 agent**：没有工具条按钮（用户已拍）。
   *
   * 写盘走 writeTextAtomic（agent 的 doc 工具同一套），并且工具名在
   * TurnFileTracker 的跟踪名单里——轮尾改动卡、审查 diff、单轮撤销因此都看得见，
   * 不另造一套变更记录。没有可改的内容时**一个字都不写**（不回一张空 diff 卡）。
   */
  const editBib: ToolDefinition = {
    name: "edit_bib",
    label: "edit_bib",
    description:
      "Tidy a BibTeX file without touching its content: action \"sort\" reorders entries (by key by default, or " +
      "year then author then key with by:\"year\") and action \"align\" lines up the `=` of every field inside each " +
      "entry. Header comments and @string / @comment blocks stay where they are. The file is written through the " +
      "normal edit path, so the change appears in the turn's file card and can be undone. Both actions are " +
      "idempotent: if nothing would change, nothing is written. Use it when the user asks to sort their .bib or " +
      "make the fields line up; do not use it to add, remove or rewrite entries.",
    promptSnippet:
      "Sort or align a .bib file by key/year; writes through the normal edit path (undoable, no-op when already tidy).",
    promptGuidelines: [
      "Pass path: the .bib file you mean (absolute, or relative to the session working directory).",
      "sort is stable; by:\"year\" orders by year, then author, then key. align only pads spaces before `=`.",
      "It never deletes unused entries — do not claim it did; ask the user before removing anything.",
      "A result saying \"nothing written\" means the file was already in that shape; do not retry.",
    ],
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: 'What to do: "sort" (reorder entries) or "align" (line up the `=` signs inside each entry).',
        },
        path: {
          type: "string",
          description: "The .bib file, absolute or relative to the session working directory.",
        },
        by: {
          type: "string",
          description: 'For action "sort": "key" (default) or "year" (year, then author, then key).',
        },
      },
      required: ["action", "path"],
    } as never,
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted === true) throw new Error("Stopped");
      const args = (params ?? {}) as Record<string, unknown>;
      const action = text(args["action"]);
      if (action !== "sort" && action !== "align") {
        throw new Error('action must be "sort" or "align".');
      }
      const byRaw = text(args["by"]);
      if (byRaw !== undefined && byRaw !== "key" && byRaw !== "year") {
        throw new Error('by must be "key" or "year".');
      }
      const rawPath = text(args["path"]);
      if (rawPath === undefined) throw new Error("path is required — the .bib file to edit.");

      const absolute = resolveToolPath(rawPath, context.cwd);
      if (!/\.bib$/i.test(absolute)) throw new Error(`Not a .bib file: ${rawPath}`);
      const roots = context.writeRoots !== undefined && context.writeRoots.length > 0 ? context.writeRoots : [context.cwd];
      if (!roots.some((root) => isInside(root, absolute))) {
        throw new Error(`That .bib file is outside the session's directories: ${rawPath}`);
      }
      // 存在性 + symlink 越界一起判（与 doc 工具同一道 realpathInside）。读写都用
      // 解析后的真实路径：往 lexical 路径 rename 会把 symlink 换成一个普通文件。
      const real = await realpathInside(absolute, roots);
      if (real === null) {
        throw new Error(`BibTeX file not found (or outside the session's directories): ${rawPath}`);
      }

      const source = await readFile(real, "utf8");
      const by: BibSortBy = byRaw === "year" ? "year" : "key";
      const result = action === "sort" ? sortBib(source, by) : alignBib(source);
      const label = displayPath(context.cwd, absolute);
      if (!result.changed) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                action === "sort"
                  ? `${label} is already sorted by ${by}; nothing written.`
                  : `${label} is already aligned; nothing written.`,
            },
          ],
          details: undefined,
        };
      }
      await writeTextAtomic(real, result.source);
      const preview =
        action === "sort"
          ? `\nBefore: ${result.before.join(", ")}\nAfter:  ${result.after.join(", ")}`
          : "";
      const summary =
        action === "sort"
          ? `Sorted ${label} by ${by}: ${result.entries} entries, ${result.moved} moved.${preview}`
          : `Aligned ${label}: ${result.entries} entries, ${result.moved} changed (equal signs line up inside each entry).`;
      return { content: [{ type: "text" as const, text: summary }], details: undefined };
    },
  };

  return [compile, packages, editBib];
}

/** 正文的可裁剪部分。砍的顺序固定（见文件头），状态行 / Command / Log / 首条 error 不在其中 */
interface ReplyBudget {
  tail: boolean;
  raw: boolean;
  layout: boolean;
  outputs: boolean;
  warningDetails: boolean;
}

/**
 * 回执正文。先按完整形态渲染，再按固定顺序砍到 LATEX_REPLY_MAX_CHARS 以内。
 * **不做「截一半」**：每一段要么完整在、要么整段不列（并留下计数）。
 */
function describe(result: LatexResult): string {
  const state: ReplyBudget = { tail: true, raw: true, layout: true, outputs: true, warningDetails: true };
  const drops: ((next: ReplyBudget) => void)[] = [
    (next) => {
      next.tail = false;
    },
    (next) => {
      next.raw = false;
    },
    (next) => {
      next.layout = false;
    },
    (next) => {
      next.outputs = false;
    },
    (next) => {
      next.warningDetails = false;
    },
  ];
  let text = render(result, state);
  for (const drop of drops) {
    if (text.length <= LATEX_REPLY_MAX_CHARS) break;
    drop(state);
    text = render(result, state);
  }
  return text;
}

function render(result: LatexResult, budget: ReplyBudget): string {
  const lines: string[] = [statusLine(result)];

  // 命令：模型要能「照着改配方」，就必须看见现在这条
  if (result.command !== null) {
    const recipe = result.command.source === "config" ? "config recipe" : "default recipe";
    lines.push(
      `Command: ${result.command.executable} ${result.command.args.join(" ")}  [${recipe}] (cwd ${result.command.cwd})`,
    );
  }
  const steps = stepsLine(result.steps);
  if (steps !== null) lines.push(steps);
  if (result.log !== null) lines.push(...logLines(result.log));

  if (result.status === "no-main-file" && result.candidates.length > 0) {
    lines.push(`Candidates (${result.candidates.length}):`);
    for (const candidate of result.candidates.slice(0, MAX_ERRORS_SHOWN)) lines.push(`- ${candidate}`);
  }

  // 失败分支也要给产物：模型下一步常常要 read_pdf 那份（可能是上一版的）PDF
  if (budget.outputs) lines.push(...outputLines(result));

  // 失败时的 PDF 要说清楚它是「本次写出的」还是「上一版的」：两者下一步完全不同
  if (result.status === "compile-error" && result.pdf !== null) {
    lines.push(
      result.pdfFresh
        ? `A PDF from this run exists at ${result.pdf}, but the build reported errors.`
        : `A PDF from an earlier build is still on disk at ${result.pdf}; it may not reflect the current sources.`,
    );
  }

  // 本次没写日志：错误来自上一轮 / 或只是无事可做，必须让模型知道证据来源
  if (result.log !== null && !result.log.fresh) {
    const hasIssues = result.diagnostics.length > 0;
    lines.push(
      "",
      hasIssues
        ? "Note: this run did not write a new .log — the errors and warnings below are from the previous " +
            "build in this directory (its page count is not reused)."
        : "Note: this run did not write a new .log — latexmk reported success without rebuilding, so the " +
            "PDF on disk was already up to date and no page count is reported.",
    );
  }

  const diagnostics = result.diagnostics;
  const errors = diagnostics.filter((issue) => issue.kind === "error");
  const warnings = diagnostics.filter((issue) => issue.kind === "warning");
  const layouts = diagnostics.filter((issue) => issue.kind === "layout");

  // not-installed 的那条「errors」就是上面同一句安装建议，不重复列（评审 A8）
  if (result.status !== "not-installed" && errors.length > 0) {
    const omitted = result.omitted.errors;
    lines.push("", `Errors (${errors.length}${omitted > 0 ? `, ${omitted} more not shown` : ""}):`);
    errors.slice(0, MAX_ERRORS_SHOWN).forEach((issue, index) => {
      lines.push(...entryLines(issue, index + 1, budget.raw));
    });
    if (errors.length > MAX_ERRORS_SHOWN || omitted > 0) {
      lines.push(`- …fix the first ones and recompile; the rest are usually consequences.`);
    }
  }

  if (warnings.length > 0 && result.status !== "not-installed") {
    const omitted = result.omitted.warnings;
    lines.push(
      "",
      `Warnings (${warnings.length}${omitted > 0 ? `, ${omitted} more not shown` : ""}):`,
    );
    if (budget.warningDetails) {
      warnings.slice(0, MAX_WARNINGS_SHOWN).forEach((issue, index) => {
        lines.push(...entryLines(issue, index + 1, false));
      });
    }
    if (warnings.length > MAX_WARNINGS_SHOWN || omitted > 0) {
      lines.push(`- …${warnings.length + omitted - Math.min(warnings.length, MAX_WARNINGS_SHOWN)} more warnings not listed.`);
    }
  }

  const layoutTotal = layouts.length + result.omitted.layout;
  if (layoutTotal > 0) {
    // 版式与内容告警**分开计数**：一篇有 200 个 Overfull 的论文不该把「引用未定义」挤掉
    lines.push(
      "",
      budget.layout
        ? `Layout (${layoutTotal}; showing the first ${Math.min(layouts.length, MAX_LAYOUT_SHOWN)}):`
        : `Layout: ${layoutTotal} Overfull/Underfull warnings (not shown — they do not fail the build).`,
    );
    if (budget.layout) {
      for (const issue of layouts.slice(0, MAX_LAYOUT_SHOWN)) {
        const where = issue.file === null ? "" : issue.line === null ? `${issue.file} ` : `${issue.file}:${issue.line} `;
        lines.push(`- ${where}${clip(issue.message.replace(/\s+/g, " "), MAX_MESSAGE_CHARS)}`);
      }
    }
  }

  // 日志尾巴：只在编译失败时主进程才给
  if (budget.tail && result.logTail !== null) {
    lines.push(
      "",
      result.logTail.truncated
        ? `Log tail (lines ${result.logTail.fromLine}… of the parsed log):`
        : "Log tail (the whole parsed log):",
      "---",
      result.logTail.text,
    );
  }
  return lines.join("\n");
}

/** 第一行是**状态 + 根 + 引擎 + 时长**；它永不砍 */
function statusLine(result: LatexResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const root = result.root === null ? null : rootSummary(result.root);
  const engine = `engine ${result.engine} (${engineSourceWord(result.engineSource)})`;
  const at = `${root === null ? "" : `, root ${root}`}, ${engine}`;
  if (result.status === "ok" || result.status === "warning-only") {
    const pages = result.pages === null ? "page count unknown" : `${result.pages} pages`;
    return `LaTeX build succeeded: status "${result.status}"${at}, ${pages} in ${seconds}s.`;
  }
  if (result.status === "not-installed") {
    return (
      "LaTeX could not run: latexmk is not installed on this machine. " +
      "Tell the user to install TeX Live (or MiKTeX on Windows / MacTeX on macOS) and retry."
    );
  }
  if (result.status === "no-main-file") {
    return (
      `LaTeX could not start: no root was chosen (${engine}). ` +
      "Pass main (which root to build) or file (the .tex you edited, whose \"% !TEX root\" names its document)."
    );
  }
  if (result.status === "root-outside-workspace") {
    return (
      "LaTeX could not start: the \"% !TEX root\" line points outside the authorized workspace, so it was " +
      "refused (the build directory would have landed outside too). Ask the user before touching files " +
      "outside the session's directories."
    );
  }
  if (result.status === "timeout") {
    // 静默与总时长封顶的下一步不同：前者要先判断是不是真的卡住，后者可以拆文档/等机器空闲。
    // 不写“死循环”：日志按 4 KiB 块落盘，合法但耗时的编译也会长时间没有新输出（见 shared 常量注释）。
    const totalMinutes = String(LATEX_TOTAL_TIMEOUT_MS / 60_000);
    return result.timeoutKind === "total"
      ? `LaTeX build hit the total time limit (${totalMinutes} minutes) and was killed after ${seconds}s (${engine}). ` +
          "The document did not finish in time — split it into smaller parts or retry when the machine is free."
      : `LaTeX build produced no new log output for ${String(LATEX_IDLE_TIMEOUT_MS / 1000)} seconds ` +
          `and was killed after ${seconds}s (${engine}). A silent build can be a long computation, a package ` +
          "waiting for input, or an infinite loop — check the partial errors below before assuming the source is broken.";
  }
  if (result.status === "cancelled") {
    return `LaTeX build was cancelled after ${seconds}s (the app is shutting down or the build was stopped).`;
  }
  return `LaTeX build failed: status "compile-error"${at} in ${seconds}s.`;
}

/** 引擎怎么定下来的（正文要说「为什么是 xelatex」） */
function engineSourceWord(source: LatexEngineSource): string {
  switch (source) {
    case "request":
      return "requested";
    case "magic":
      return "from the magic comment";
    case "config":
      return "from .orbita/latex.json";
    default:
      return "auto-detected";
  }
}

/**
 * 步骤时序：`pdflatex 0.8s -> bibtex 0.3s -> pdflatex 1.1s (last)`。
 * 没有进度行（自定义 recipe 不打印）时整行不出现——不编造步骤。
 */
function stepsLine(steps: readonly LatexBuildStep[]): string | null {
  if (steps.length === 0) return null;
  const parts = steps.map((step, index) => {
    const duration = step.durationMs === null ? "" : ` ${(step.durationMs / 1000).toFixed(1)}s`;
    const last = index === steps.length - 1 ? " (last)" : "";
    return `${step.rule}${duration}${last}`;
  });
  return `Steps: ${parts.join(" -> ")}`;
}

/**
 * 日志一行（路径 / 大小 / 行数 / 新旧 / 时刻）+ 一句「完整日志怎么读」。
 * **路径必须打印**：今天界面能开日志、模型却拿不到路径，只能猜 build/<main>.log。
 */
function logLines(log: LatexLogRef): string[] {
  const size = formatBytes(log.bytes);
  const when = log.modifiedAt === null ? "" : ` (${new Date(log.modifiedAt).toISOString().slice(11, 19)} UTC)`;
  const freshness = log.fresh ? "written by this run" : "from an earlier build";
  const lines = [`Log: ${log.path} — ${size}, ${log.lines} lines, ${freshness}${when}.`];
  lines.push("     The full log is on disk: read it with offset if the text below is not enough.");
  if (log.parseTruncated) {
    lines.push(
      "     Note: the log is larger than the reader's limit, so only its last part was parsed — " +
        "earlier diagnostics may be missing.",
    );
  }
  return lines;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 一条诊断：`1. file:line  [code, source/step]` + 缩进的消息 + 可选的 raw */
function entryLines(issue: LatexIssue, index: number, withRaw: boolean): string[] {
  const where = issue.file === null ? "" : issue.line === null ? `${issue.file} ` : `${issue.file}:${issue.line} `;
  const tags: string[] = [];
  if (issue.code !== undefined) tags.push(issue.code);
  if (issue.source !== undefined) {
    tags.push(issue.step === null || issue.step === undefined ? issue.source : `${issue.source}/${issue.step}`);
  }
  const tag = tags.length === 0 ? "" : ` [${tags.join(", ")}]`;
  const message = clip(issue.message.replace(/\s+/g, " "), MAX_MESSAGE_CHARS);
  const lines = [`${index}. ${where}${tag}`, `   ${message}`];
  if (withRaw && issue.raw !== null && issue.raw !== undefined && issue.raw !== "") {
    lines.push(`   raw: ${issue.raw.split("\n").join("\n        ")}`);
  }
  return lines;
}

/**
 * 产物清单。**primary 排第一、标出来**：模型下一步常常要读 / 引用这份 PDF，
 * 而一次构建可能写出好几份（正文 + 附录 + standalone 图）。上限在共享契约里
 * （LATEX_MAX_OUTPUTS），截断时明说，不让模型以为只写了这几份。
 */
function outputLines(result: LatexResult): string[] {
  if (result.outputs.length === 0) return [];
  const lines = [`Outputs (${result.outputs.length}${result.outputsTruncated ? ", truncated" : ""}, primary first):`];
  for (const output of result.outputs.slice(0, MAX_OUTPUTS_SHOWN)) {
    const pages = output.pages === null ? "" : `, ${String(output.pages)} pages`;
    const fresh = output.fresh ? "" : ", from an earlier build";
    lines.push(`- ${output.path}${output.primary ? " — primary" : ""}${pages}${fresh}`);
  }
  if (result.outputs.length > MAX_OUTPUTS_SHOWN) {
    lines.push(`- …and ${String(result.outputs.length - MAX_OUTPUTS_SHOWN)} more (see the build directory).`);
  }
  return lines;
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** `main.tex (from config)` / `sections/ch1.tex (from "% !TEX root" in main.tex:1)` */
function rootSummary(root: LatexRootRef): string {
  return `${root.path} (${rootSourceWord(root)})`;
}

function rootSourceWord(root: LatexRootRef): string {
  if (root.source === "magic") {
    const where =
      root.declaredBy === null ? "a % !TEX root line" : `"% !TEX root" in ${root.declaredBy.file}:${String(root.declaredBy.line)}`;
    return `from ${where}`;
  }
  switch (root.source) {
    case "request":
      return "requested";
    case "active":
      return "from config (activeRoot)";
    case "config":
      return "from config (main)";
    case "convention":
      return "from main.tex in the project";
    case "unique":
      return "the only .tex in the project";
    case "focus":
      return "the file you passed";
    default:
      return "the only document found in the project";
  }
}

/** 缺包反查的正文：一行一个文件，「能不能装、怎么装、下一步是什么」都要能单独成句 */
function describePackages(outcome: LatexPackageOutcome): string {
  if (!outcome.ok) {
    return `Package lookup failed: ${outcome.error}`;
  }
  const lines = outcome.resolved.map(packageLine);
  if (outcome.resolved.some((entry) => entry.packageName === null)) {
    lines.push(
      "",
      "Do not guess a package name for an entry that says `not-found` or `invalid-name` — ask the user which " +
        "distribution package they installed, or how that file was supposed to be provided.",
    );
  }
  return lines.join("\n");
}

function packageLine(entry: LatexResolvedPackage): string {
  const distro = entry.distro ?? "unknown distribution";
  if (entry.packageName === null) {
    return `${entry.missing} -> unknown (${distro}, ${entry.reason ?? "not-found"}) — no package name to install.`;
  }
  const state = entry.installed ? "already installed" : "not installed";
  const head = `${entry.missing} -> ${entry.packageName} (${distro}, ${state})`;
  if (entry.command === null) {
    return entry.installed
      ? `${head} — nothing to install: kpsewhich already finds this file (the log may be from another TeX tree).`
      : `${head} — no install command available; ask the user to install ${entry.packageName}.`;
  }
  const sudo = entry.sudo ? " (needs sudo)" : "";
  return `${head} — run: ${entry.command}${sudo}`;
}

/** 给模型看的路径：在工作区里就写相对路径（正斜杠），否则写绝对路径 */
function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  if (rel === "" || rel.startsWith("..")) return absolute.split("\\").join("/");
  return rel.split("\\").join("/");
}
