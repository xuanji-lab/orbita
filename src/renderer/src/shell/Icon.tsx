/// <reference types="vite/client" />
import archive from "../../../../Orbita Design System/assets/icons/lucide/archive.svg?raw";
import arrowUp from "../../../../Orbita Design System/assets/icons/lucide/arrow-up.svg?raw";
import bot from "../../../../Orbita Design System/assets/icons/lucide/bot.svg?raw";
import brain from "../../../../Orbita Design System/assets/icons/lucide/brain.svg?raw";
import check from "../../../../Orbita Design System/assets/icons/lucide/check.svg?raw";
import chevronDown from "../../../../Orbita Design System/assets/icons/lucide/chevron-down.svg?raw";
import copy from "../../../../Orbita Design System/assets/icons/lucide/copy.svg?raw";
import cpu from "../../../../Orbita Design System/assets/icons/lucide/cpu.svg?raw";
import folder from "../../../../Orbita Design System/assets/icons/lucide/folder.svg?raw";
import folderPlus from "../../../../Orbita Design System/assets/icons/lucide/folder-plus.svg?raw";
import loaderCircle from "../../../../Orbita Design System/assets/icons/lucide/loader-circle.svg?raw";
import panelRight from "../../../../Orbita Design System/assets/icons/lucide/panel-right.svg?raw";
import plus from "../../../../Orbita Design System/assets/icons/lucide/plus.svg?raw";
import settings from "../../../../Orbita Design System/assets/icons/lucide/settings.svg?raw";
import square from "../../../../Orbita Design System/assets/icons/lucide/square.svg?raw";
import trash2 from "../../../../Orbita Design System/assets/icons/lucide/trash-2.svg?raw";
import shieldCheck from "../../../../Orbita Design System/assets/icons/lucide/shield-check.svg?raw";
import sliders from "../../../../Orbita Design System/assets/icons/lucide/sliders.svg?raw";
import triangleAlert from "../../../../Orbita Design System/assets/icons/lucide/triangle-alert.svg?raw";
import workflow from "../../../../Orbita Design System/assets/icons/lucide/workflow.svg?raw";
import wrench from "../../../../Orbita Design System/assets/icons/lucide/wrench.svg?raw";

/**
 * 图标只用 lucide（AGENTS.md 硬规则：禁 emoji 与 Unicode 字符当图标）。
 *
 * 设计系统的 `Icon.jsx` 是 `fetch` 拉 SVG——那是它在静态页里的做法。渲染层改走 Vite 的
 * `?raw`：构建期内联进产物，不打网络、不新增依赖（`lucide-react` 会是第 6 个 runtime 依赖）。
 * **只登记真正用到的图标**——图标表也受消费者纪律约束，不铺 46 个占位。
 */
const ICONS = {
  archive,
  "arrow-up": arrowUp,
  bot,
  brain,
  check,
  "chevron-down": chevronDown,
  copy,
  cpu,
  folder,
  "folder-plus": folderPlus,
  "loader-circle": loaderCircle,
  "panel-right": panelRight,
  plus,
  settings,
  "shield-check": shieldCheck,
  sliders,
  square,
  "trash-2": trash2,
  "triangle-alert": triangleAlert,
  workflow,
  wrench,
} as const;

export type IconName = keyof typeof ICONS;

/**
 * SVG 源文件里的换行与缩进会原样变成 DOM 文本节点，把承载图标的按钮的 `textContent`
 * 污染成 `"\n  \n  \nProviders"`——读屏与任何按文本找元素的东西都会踩到。
 * 构建期洗一次，运行时零成本。
 */
function inline(svg: string): string {
  return svg.trim().replace(/>\s+</g, "><");
}

/**
 * 尺寸与描边由外层 span 控制：`.orbita-icon svg` 用 CSS 覆盖 SVG 的呈现属性
 * （CSS 优先级高于 presentation attribute），所以不必改写 SVG 源串。
 * 图标继承 `currentColor`——颜色一律由父级的 color 决定。
 */
export function Icon(props: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  spin?: boolean;
  style?: React.CSSProperties;
}) {
  const size = props.size ?? 16;
  const style = {
    width: size,
    height: size,
    "--icon-stroke": props.strokeWidth ?? 2,
    ...(props.spin === true ? { animation: "orbita-spin 1s linear infinite" } : null),
    ...props.style,
  } as React.CSSProperties;
  return (
    <span
      className="orbita-icon"
      aria-hidden="true"
      style={style}
      dangerouslySetInnerHTML={{ __html: inline(ICONS[props.name]) }}
    />
  );
}
