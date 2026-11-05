/**
 * mermaid 代码块的纯逻辑（pele 渲染选项、主题变量映射、闭合判定、SVG 复核、失败原因）。
 *
 * 纯模块：不 import React / CSS，`node --test` 直接加载。组件在 MermaidBlock.tsx。
 *
 * 信任模型：mermaid 文本来自模型输出与用户文件，一律当不可信输入。三道闸：
 * 1. pele 自己转义文字、过滤链接 / 样式、限制输入与输出大小（pele.run/security）；
 * 2. 我们只用固定的 {@link MERMAID_OPTIONS}，**绝不**把图里的内容当 options / config 传进去
 *    （pele 文档明令：不要让图作者提供 options.config）；链接与图片整体关掉——
 *    聊天里一张图不该有可点的外链，远程图更是隐私洞（同 MarkdownBlock 的 ImagePlaceholder）；
 * 3. SVG 插入 DOM 前再过一遍 {@link svgViolation}：pele 若有疏漏，退回代码块而不是插进去。
 */
import type { RenderOptions } from "pele/core";

/** 固定的渲染选项（见顶部信任模型）：关链接与图片、收紧大小上限。 */
export const MERMAID_OPTIONS: RenderOptions = {
  links: false,
  images: false,
  // 聊天 / 笔记里的图远小于 pele 默认的 5 万字符；放宽只会放大拒绝服务面
  limit: 20_000,
  outputLimit: 1_000_000,
  maxEdges: 500,
};

/**
 * pele 的 CSS 变量 → 设计系统 token。内联在图容器上：换主题时 token 值变、图不用重画。
 * 值只能由 `var(--…)`（及其 color-mix）组成，不许裸色值（mermaid-render.test.ts 把关）。
 * 系列色（饼图 / git 分支）取 accent 与状态色轮转，暗主题随 token 翻亮；排序让「亮档 accent≈info、
 * 暗档 accent≈warning」这两对近色隔开，相邻切片分得开。
 */
export const PELE_THEME_VARS: Readonly<Record<string, string>> = {
  "--pele-bg": "var(--color-bg-panel)",
  "--pele-fg": "var(--color-text-primary)",
  "--pele-fg-on-light": "var(--color-text-primary)",
  "--pele-fg-on-dark": "var(--color-text-on-dark)",
  "--pele-muted": "var(--color-text-secondary)",
  "--pele-line": "var(--color-text-secondary)",
  "--pele-surface": "var(--color-chat-muted-bg)",
  "--pele-surface-alt": "var(--color-bg-muted)",
  "--pele-border": "var(--color-border-strong)",
  "--pele-accent": "var(--color-accent)",
  "--pele-critical": "var(--color-danger)",
  "--pele-error": "var(--color-danger)",
  "--pele-font": "var(--font-family-base)",
  "--pele-font-mono": "var(--font-family-mono)",
  "--pele-radius": "var(--radius-md)",
  "--pele-series-1": "var(--color-accent)",
  "--pele-series-2": "var(--color-success)",
  "--pele-series-3": "var(--color-danger)",
  "--pele-series-4": "var(--color-info)",
  "--pele-series-5": "var(--color-warning)",
  "--pele-series-6": "color-mix(in srgb, var(--color-danger) 50%, var(--color-info))",
  "--pele-series-7": "var(--color-text-secondary)",
  "--pele-series-8": "var(--color-text-tertiary)",
};

/** 围栏语言是不是 mermaid（大小写不敏感，只认整词） */
export function isMermaidLang(lang: string | undefined): boolean {
  return lang !== undefined && lang.toLowerCase() === "mermaid";
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * 这段 markdown 结束时是不是还停在没闭合的围栏里。流式中的尾块若是，说明 mermaid
 * 还没写完——此时画必然是半截语法、每个 token 重画一次又全是报错，先按普通代码显示，
 * 围栏闭合那一帧（或落定后）才真去画。
 */
export function endsInsideFence(text: string): boolean {
  let fence: { char: string; size: number } | null = null;
  for (const line of text.split("\n")) {
    if (fence === null) {
      const open = FENCE_OPEN_RE.exec(line);
      // 反引号围栏的 info 串里不许再出现反引号（否则是行内 code，不是围栏）
      if (open !== null && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        fence = { char: open[1]![0]!, size: open[1]!.length };
      }
      continue;
    }
    const close = FENCE_CLOSE_RE.exec(line);
    if (close !== null && close[1]![0] === fence.char && close[1]!.length >= fence.size) {
      fence = null;
    }
  }
  return fence !== null;
}

/**
 * SVG 插入 DOM 前的复核：返回违规描述，干净返回 null。
 * 正常的 pele 输出不含这些东西；命中任一条就退回代码块。宁可错杀（黑名单宽一点），
 * 因为退回的代价只是「看源码」。
 */
export function svgViolation(svg: string): string | null {
  if (!/^\s*<svg[\s>]/i.test(svg)) return "输出不是 SVG";
  // 只查标签（含属性）：pele 把文字里的 < > 转义成实体，图里的文字写着 `onload=` 之类
  // 不算违规，不该为此退回代码。标签正则要认引号——属性值里的 `>` 不能让标签提前结束，
  // 否则 `<rect title=">" onload=x()>` 的后半截会被当成文字漏检。
  const tags = svg.match(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g) ?? [];
  const markup = tags.join("\n");
  if (/<\s*(script|foreignObject|iframe|object|embed|style|image|use|animate|set)\b/i.test(markup)) {
    return "含有不允许的元素";
  }
  if (/\son[a-z]+\s*=/i.test(markup)) return "含有事件属性";
  if (/(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i.test(markup)) return "含有脚本协议";
  // 链接与图片已整体关掉，任何 href / src 都不该出现
  if (/\s(?:xlink:)?href\s*=|\ssrc\s*=/i.test(markup)) return "含有链接或外部资源";
  // url() 只许引用本图内的片段（渐变 / 箭头）
  for (const m of markup.matchAll(/url\(\s*([^)]*)\)/gi)) {
    if (!/^["']?#/.test(m[1]!.trim())) return "含有外部 url()";
  }
  if (/@import|expression\s*\(/i.test(markup)) return "含有样式注入";
  return null;
}

/**
 * 失败原因：pele 的报错形如「Parse error on line 3:\n  <源码行>\n----^\nExpecting 'X', got 'Y'」，
 * 中间是带源码的 snippet（不可信、太长），只取首行（位置）与末行（期望什么），拼成一行并截断。
 */
export function failureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const first = lines[0] ?? "";
  const last = lines.length > 1 ? lines[lines.length - 1]! : "";
  const joined = last !== "" && /^(expecting|unexpected|expected)/i.test(last) ? `${first} ${last}` : first;
  const clipped = joined.length > 120 ? `${joined.slice(0, 120)}…` : joined;
  return clipped === "" ? "未知错误" : clipped;
}
