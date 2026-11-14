/**
 * Office 预览的纯函数半边（可被 `node --test` 直接加载）。
 *
 * **为什么要在注入前改 HTML**：`view html` 的输出是「能自己动的网页」——内联脚本
 * （切工作表、缩放幻灯片）、`onclick=` 属性、甚至 PPT 里嵌的外部 importmap（three.js
 * 走 CDN）。在 iframe 里我们：
 *   1. 把脚本**整段删掉**（sandbox 也不给 allow-scripts，双保险）；
 *   2. 摘掉所有 `on*=` 事件属性（不许有可执行的入口）；
 *   3. 注入一条只放行内联样式与 data: 图片的 CSP（`default-src 'none'`）——
 *      断网渲染，也断掉「文件里的内容往外发请求」这条路；
 *   4. 注入自己的样式：隐藏 OfficeCLI 自带的外壳（侧栏 / 标题 / 页码），把 pptx 的
 *      幻灯片按面板宽度等比缩放（原脚本负责这件事，脚本删掉后要补回来）。
 *
 * 我们自己的交互（点单元格出标注、切工作表）**在父窗口里**对 `contentDocument`
 * 挂监听——iframe 用 `sandbox="allow-same-origin"`（不给 allow-scripts），所以里面
 * 一行脚本都跑不起来，而父窗口仍能读到 `[data-path]`。
 */
import type { OfficeFormat } from "@shared/office";

/** pptx 幻灯片的固定设计宽度：`--slide-design-w: 960pt` = 1280 CSS px（OfficeCLI 的输出常量） */
export const PPTX_DESIGN_WIDTH = 1280;

/** html 里的脚本整段删掉（含 `type="importmap"` 与模块脚本） */
export function stripScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/>/gi, "");
}

/** 摘掉所有 `on…="…"` / `on…='…'` 事件属性（`onclick` / `onkeydown` …） */
export function stripEventAttributes(html: string): string {
  return html.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");
}

/** 注入 CSP（放在 `<head>` 后；没有 head 就放最前面） */
export function withContentSecurityPolicy(html: string): string {
  const meta =
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: blob:; font-src data:;">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}\n${meta}`);
  return `${meta}\n${html}`;
}

/**
 * 我们自己的样式：隐藏 OfficeCLI 的外壳、给点击目标一个「可标注」的光标，
 * 并给 pptx 一个按面板宽度的缩放。
 *
 * `zoom` 是 Chromium 支持的非标准属性，但它**参与布局**（元素与其占位一起缩放），
 * 比 transform 更适合「整页等比缩小后滚动」——OfficeCLI 原脚本用的也是分辨率无关的
 * 缩放思路，这里只是用 CSS 补回脚本删掉的那一半。
 */
export function officeShellStyle(format: OfficeFormat, width: number, accent: string): string {
  const shell = [
    ".file-title{display:none!important}",
    ".sidebar,.sidebar-toggle,.toggle-zone,.page-counter{display:none!important}",
    ".slide-label{display:none!important}",
    "[data-path]{cursor:pointer}",
    `[data-path].office-picked{outline:2px solid ${accent};outline-offset:-2px}`,
  ];
  if (format === "pptx") {
    // 留出 .main 的左右内边距与滚动条：按整宽算会正好多出一条横向滚动条
    const factor = Math.max(0.2, Math.min(1, (width - 28) / PPTX_DESIGN_WIDTH));
    shell.push(`.main{padding:12px 8px!important;gap:16px!important}`);
    shell.push(`.slide{zoom:${factor.toFixed(4)}}`);
  }
  return `<style id="orbita-office-shell">${shell.join("\n")}</style>`;
}

/**
 * officecli 的 HTML + 我们的沙箱化改造 → 塞进 iframe 的整份文档。
 * `width` 是 iframe 的可见宽度（CSS px）；accent 取自设计系统的当前主题（不写死颜色）。
 */
export function officeDocumentHtml(input: {
  html: string;
  format: OfficeFormat;
  width: number;
  accent: string;
}): string {
  const sanitized = stripEventAttributes(stripScripts(input.html));
  const withStyle = /<\/head>/i.test(sanitized)
    ? sanitized.replace(/<\/head>/i, `${officeShellStyle(input.format, input.width, input.accent)}</head>`)
    : `${officeShellStyle(input.format, input.width, input.accent)}${sanitized}`;
  return withContentSecurityPolicy(withStyle);
}

/** 被点元素的一句值预览（chip 正文 / 引用正文）：压平空白、截到 80 字 */
export function officeValuePreview(text: string | null | undefined): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (flat === "") return "";
  return Array.from(flat).slice(0, 80).join("");
}
