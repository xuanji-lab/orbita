import type { CSSProperties } from "react";

/**
 * 折叠行下挂出的展开体——「圆角虚线框」这一个语义（2026-10-12 用户裁决）。
 *
 * 思考全文、工具结果、diff / 文件内容视图、压缩界碑摘要、运行中 shell 的活尾
 * （展开态与折叠行下的贴尾预览都算）：凡是从折叠行下面挂出来的内容都套同一种框。
 * 此前形态是「顶部细线 + 左侧导轨竖线、直角」，与活尾预览的「无框裸文本」混在一起
 * 像两套控件——统一成一个虚线框后，「点开这行 → 虚线框里是它的内容」在所有行上
 * 长一个样；运行中的活尾从第一行输出起就有框，不再像渲染错误。
 *
 * 样式抽成纯常量（沿 notice.ts 先例），`expanded-body.test.ts` 锚定几何契约，
 * ChatView 各展开体只叠加各自的排版（mono caption / .chat-md / 行号列）。
 */

/**
 * 展开体的横向缩进：与折叠行行首 icon 的**左缘相切**（x = 10px，按钮内边距）。
 * 展开体明确属于它上面那一行，不与别的行抢左缘；框右缘落在行右内边距
 * （无 marginRight），与折叠行的尾部元素同一条血线。
 */
export const RAIL_X = 10;

/**
 * 框色走 `--expanded-frame-border`（styles.css 按主题定义，2026-10-12 第二次返工）：
 * 虚线本身比同宽实线淡一截（一半长度是空的），用户要的是「一眼看出这是个框」。
 * - 深色（黛 / 玄）：border-strong（.16 白）够了；
 * - 浅色三档（浅色 / 小学作业 / 打字稿）：border-strong（#d7d7cf）在白底上几乎看不见，
 *   改用 text-tertiary 混 60% 透明——比边框档深、比正文浅，仍是「辅助线」的分量。
 * 圆角取 --radius-md：设计系统「矩形停在 radius-md，pill 只给真圆」。
 */
export const EXPANDED_FRAME: CSSProperties = {
  marginLeft: RAIL_X,
  border: "1px dashed var(--expanded-frame-border)",
  borderRadius: "var(--radius-md)",
};
