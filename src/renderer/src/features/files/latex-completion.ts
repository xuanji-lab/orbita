/**
 * LaTeX 补全的 CodeMirror 接线 —— 只做「纯逻辑的结论 → Completion 对象」。
 *
 * 三个决定（与 cite-completion 同一套，现在合成一个 `autocompletion()`）：
 * - **只注册一次 `autocompletion()`**：它是个单例式扩展，调两次会争同一个弹层；补全
 *   现场（`\cite` / 命令 / 环境 / `\ref` / 路径 / snippet）由多个 source 共同回答，
 *   每个 source 只在自己的现场返回结果，互不重叠。
 * - **`filter: false`**：候选由 latex-suggest.ts 自己筛（含按路径 / 标题命中），
 *   让 CodeMirror 再按 label 筛一遍会把「`fig/pl` 命中 `figures/plot.pdf`」筛掉。
 * - **索引与文献库用取值函数而不是快照**：IPC 在飞、换项目后重扫，都不必重建编辑器
 *   （重建会丢光标、撤销历史与滚动位置）。
 */
import {
  autocompletion,
  insertCompletionText,
  snippet,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { CiteEntry } from "../../../../shared/cite.ts";
import type { LatexProjectIndex } from "../../../../shared/latex.ts";
import { citeArgumentBefore, citeDetail, citeInfo, citeInsertion, suggestCites } from "./cite-suggest.ts";
import { latexContextBefore, suggestLatex, type LatexSuggestion } from "./latex-suggest.ts";

/**
 * 往回看多远找现场：一行长的引用列表（几十个 key）也在这个窗口里。
 * 上限而不是全文 `toString()`：每次按键拷一份整篇论文的字符串没有必要。
 */
const LOOKBEHIND = 2000;

export interface LatexCompletionInput {
  /** 项目文献库（`\cite{` 的候选）；空数组 / 缺席时那条 source 不弹 */
  cite: () => readonly CiteEntry[];
  /** 项目符号索引（`\ref` / 自定义命令 / 路径）；null = 不在 LaTeX 项目里 */
  index: () => LatexProjectIndex | null;
}

export function latexCompletion(input: LatexCompletionInput): Extension {
  return autocompletion({
    override: [latexSource(input.index), citeSource(input.cite)],
    // 图标用的是默认的彩色字母块，与设计系统「颜色各有职责」冲突；名字本身就是标识
    icons: false,
    // 弹层里同时渲染的行数：滚太长的列表不如多打两个字
    maxRenderedOptions: 24,
  });
}

/** 命令 / 环境 / 引用 / 路径 / snippet 五个现场 */
function latexSource(index: () => LatexProjectIndex | null): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const start = Math.max(0, context.pos - LOOKBEHIND);
    const text = context.state.doc.sliceString(start, context.pos);
    const live = latexContextBefore(text);
    if (live === null) return null;
    const options: Completion[] = suggestLatex(live, index()).map(toCompletion);
    if (options.length === 0) return null;
    return { from: start + live.from, options, filter: false };
  };
}

function toCompletion(suggestion: LatexSuggestion): Completion {
  const option: Completion = {
    label: suggestion.label,
    ...(suggestion.detail === null ? {} : { detail: suggestion.detail }),
    ...(suggestion.info === null ? {} : { info: suggestion.info }),
    apply:
      suggestion.insert === "snippet"
        ? snippet(suggestion.text)
        : (view, _completion, from, to) => {
            view.dispatch({
              ...insertCompletionText(view.state, suggestion.text, from, to),
              userEvent: "input.complete",
            });
          },
  };
  return option;
}

/** `\cite{` 的现场：识别与过滤在 cite-suggest.ts（有测试） */
function citeSource(entries: () => readonly CiteEntry[]): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => completeCite(entries(), context);
}

/** 光标在现场就给候选，否则交回 null（CodeMirror 据此不弹层） */
function completeCite(library: readonly CiteEntry[], context: CompletionContext): CompletionResult | null {
  if (library.length === 0) return null;
  const start = Math.max(0, context.pos - LOOKBEHIND);
  const text = context.state.doc.sliceString(start, context.pos);
  const arg = citeArgumentBefore(text);
  if (arg === null) return null;

  const options: Completion[] = suggestCites(library, arg.query).map((entry) => ({
    // label 就是插入的文本：选中的是 key，不是「标题」
    label: entry.key,
    // 「key — 标题 (年)」：破折号写在 detail 里（CodeMirror 只给我们 label + detail 两格）
    detail: `— ${citeDetail(entry)}`,
    ...(citeInfo(entry) === "" ? {} : { info: citeInfo(entry) }),
    // 接受时把 `}` 补上（除非光标后已经有一个）：编辑器没有 closeBrackets，
    // 不补的话每选一次候选都要自己再敲右括号
    apply: (view, _completion, from, to) => {
      const next = view.state.sliceDoc(to, to + 1);
      view.dispatch({
        ...insertCompletionText(view.state, citeInsertion(entry.key, next === "" ? undefined : next), from, to),
        userEvent: "input.complete",
      });
    },
  }));
  if (options.length === 0) return null;
  return { from: start + arg.from, options, filter: false };
}
