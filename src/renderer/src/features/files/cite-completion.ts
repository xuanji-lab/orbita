/**
 * `\cite{…}` 的 CodeMirror 6 补全 —— 只做接线：识别与过滤在 cite-suggest.ts（有测试）。
 *
 * 三个决定：
 * - **用官方的 `autocompletion()`，不自写弹层**：键盘（Enter / 上下键 / Esc）、滚动、
 *   无障碍都已经是它的责任，我们只产候选。
 * - **`filter: false`**：候选由我们自己过滤（key / 标题 / 作者三处命中），让官方按
 *   `label`（= key）再筛一遍会把「按标题命中」的候选筛掉。代价是每次按键重跑一次
 *   本地数组过滤——几百条文献的量级可以忽略。
 * - **文献库用取值函数而不是快照**：编辑器挂载时库可能还没到（IPC 在飞），而重挂编辑器
 *   会丢光标与撤销历史。来源每次被问时现读，库到了下一次按键就能用。
 */
import {
  autocompletion,
  insertCompletionText,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import type { CiteEntry } from "../../../../shared/cite.ts";
import { citeArgumentBefore, citeDetail, citeInfo, citeInsertion, suggestCites } from "./cite-suggest.ts";

/**
 * 往回看多远找 `\cite{`：一行长的引用列表（几十个 key）也在这个窗口里。
 * 上限而不是全文 `toString()`：每次按键拷一份整篇论文的字符串没有必要。
 */
const LOOKBEHIND = 2000;

export function citeCompletion(entries: () => readonly CiteEntry[]): Extension {
  const source: CompletionSource = (context) => complete(entries(), context);
  return autocompletion({
    override: [source],
    // 图标用的是默认的彩色字母块，与设计系统「颜色各有职责」冲突；key 本身就是标识
    icons: false,
    // 弹层里同时渲染的行数：滚太长的列表不如多打两个字
    maxRenderedOptions: 24,
  });
}

/** 光标在现场就给候选，否则交回 null（CodeMirror 据此不弹层） */
function complete(library: readonly CiteEntry[], context: CompletionContext): CompletionResult | null {
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
