import type { CSSProperties } from "react";

/**
 * 用户气泡的垂直折叠（UserBubble）——样式与判定抽成纯函数，`user-bubble-clamp.test.ts`
 * 锚定几何口径。
 *
 * **为什么 clamp 不直接加在气泡上**（2026-10-08 修复「最后一行被裁一半」的根因）：
 * 旧实现把 `maxHeight: calc(1.6em * 4 + 20px)` 与 `overflow: hidden` 加在气泡本体，
 * 公式把上下 padding（18px）与边框（2px）一起算进高度——但 `overflow: hidden` 的
 * 裁剪边是 **padding box**（不含边框、含 padding），比「第 4 行底边」低出整整一条
 * bottom padding：第 5 行的行盒顶边伸进 padding 区，字符的上半截正好落在可见带里
 * （实测 24px 行高中露出 ~7.5px），底下垫着的是几乎透明的渐变遮罩顶部——肉眼看
 * 就是「最后一行只显示一半」。
 *
 * 正确结构：**裁剪发生在内容自己的 wrapper 上**（无 padding、无边框），
 * `maxHeight` 只由行高 × 行数构成，气泡的 chrome（padding / 边框 / 圆角 / 遮罩）
 * 一概不进公式——以后改 padding、改边框、换行高 token，clamp 都不会回到
 * 「差一条 padding」的老 bug 上。行高取 `--line-height-reading`（设计系统真源），
 * 不再硬编码 1.6。
 */

/** 折叠态显示的行数（约 4 行：composer 上限 12 行的 1/3，wafo 2026-09-20）。 */
export const BUBBLE_CLAMP_LINES = 4;

/** 折叠 wrapper 的样式：`calc(行高 × N × 1em)`——em 跟随气泡字号，随 UI 缩放同步。 */
export function bubbleClampStyle(expanded: boolean): CSSProperties {
  if (expanded) return {};
  return {
    maxHeight: `calc(var(--line-height-reading) * ${BUBBLE_CLAMP_LINES} * 1em)`,
    overflow: "hidden",
  };
}

/**
 * 折叠态下的溢出判定。容差 1px：亚像素舍入不该把「恰好 N 行」误判成溢出。
 * 只在折叠态量——展开后 scrollHeight == clientHeight，结论会丢，按钮就收不回了。
 */
export function isBubbleOverflowing(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight + 1;
}
