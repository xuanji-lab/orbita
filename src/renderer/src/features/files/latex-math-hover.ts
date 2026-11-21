/**
 * 公式悬浮预览的 CodeMirror 接线：鼠标停在 `$…$` / `$$…$$` / `\(…\)` / `\[…\]` 上，
 * 用 KaTeX（对话区同一个库，见 MarkdownBlock.tsx）在浮层里排出来。
 *
 * 五个决定：
 * - **安静失败**：KaTeX 抛错（公式没写完 / 用了本文档自定义的宏）就**不弹**，
 *   不显示红字——写 `$\frac{a}` 的半秒里弹一个错误浮层比没有浮层更烦。
 * - **注释 / verbatim 不弹**：扫描在 latex-math.ts（纯逻辑、有测试）。
 * - **只锚在公式的区间上**（`pos` … `end`）：指针离开这段、或文档一变就消失
 *   （`hideOnChange`）——不抢输入焦点，不进撤销历史。
 * - **上下自动翻**：CodeMirror 的 hoverTooltip 默认落在下方，视口不够时自己翻到上方。
 * - **渲染结果按公式体缓存**：来回扫同一篇文档的同一行公式不该反复排版。
 *
 * 深色 / 浅色 / 纸面主题都只走 CSS 变量（styles.css 的 `.tex-math-hover`）。
 */
import katex from "katex";
// 与对话区同一份 KaTeX 样式（Vite 会去重）；不引这一行，浮层里的分式 / 根号会散架
import "katex/dist/katex.min.css";
import type { Extension, Text } from "@codemirror/state";
import { hoverTooltip } from "@codemirror/view";
import { findTexMath, type TexMathRange } from "./latex-math.ts";

/** 浮层出现的等待：比默认 300ms 略短，扫公式本身是毫秒级的 */
const HOVER_DELAY_MS = 250;

/** 渲染缓存（公式体 + display）；上限很小，写论文时同一屏也就几段公式 */
const CACHE_LIMIT = 40;
const rendered = new Map<string, string>();

/** 文档字符串的缓存：鼠标在文档上移动时同一份 Text 会被问很多次 */
let lastDoc: Text | null = null;
let lastText = "";

function docText(doc: Text): string {
  if (lastDoc !== doc) {
    lastDoc = doc;
    lastText = doc.toString();
  }
  return lastText;
}

/** KaTeX 渲染；公式不合法时 null（调用方安静地不弹） */
export function renderTexMath(range: TexMathRange): string | null {
  const key = `${range.display ? "d" : "i"}\u0000${range.body}`;
  const cached = rendered.get(key);
  if (cached !== undefined) return cached;
  let html: string;
  try {
    html = katex.renderToString(range.body, {
      displayMode: range.display,
      throwOnError: true,
      strict: false,
      // \href / \url / \includegraphics 一律不执行：公式来自文档，不是可信输入
      trust: false,
    });
  } catch {
    return null;
  }
  if (rendered.size >= CACHE_LIMIT) rendered.clear();
  rendered.set(key, html);
  return html;
}

/** 编辑器扩展：像素指针所在位置的公式浮层 */
export function latexMathHover(): Extension {
  return hoverTooltip(
    (view, pos) => {
      const range = findTexMath(docText(view.state.doc), pos);
      if (range === null) return null;
      const html = renderTexMath(range);
      if (html === null) return null;
      return {
        pos: range.from,
        end: range.to,
        // 默认落在公式下方；视口不够时 CodeMirror 自己翻到上方
        above: false,
        arrow: true,
        create: () => {
          const dom = document.createElement("div");
          dom.className = "tex-math-hover";
          // KaTeX 的输出是它自己生成的标记（trust:false 已挡住任意 URL）
          dom.innerHTML = html;
          return { dom };
        },
      };
    },
    { hoverTime: HOVER_DELAY_MS, hideOnChange: true },
  );
}
