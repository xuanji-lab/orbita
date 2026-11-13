/**
 * 演示文稿的**内容色板**：文字 / 形状 / 背景可选的颜色。这是文稿里的颜色数据（会写进 .slides.json、
 * 会导出进 pptx），不是应用界面的颜色，所以不走设计系统 token——文稿不该随应用的深浅色变。
 * 放 shared 是因为渲染层 .ts/.tsx 里禁裸 hex（design-tokens.test.ts），而这里是数据。
 */
export const SLIDE_PALETTE: readonly string[] = [
  "#1f2328",
  "#6b7280",
  "#ffffff",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#14372e",
];

export const SLIDE_BACKGROUNDS: readonly string[] = ["#ffffff", "#f5f1ea", "#e8efe9", "#fde68a", "#dbeafe", "#14372e", "#1f2328", "#c2410c"];

/** 新建元素的默认外观（插入文字 / 形状时用） */
export const DEFAULT_SHAPE_FILL = "#e5e7eb";
export const DEFAULT_SHAPE_STROKE = "#6b7280";

/** 取色器初始值 / 页面白 / 默认文字色等内容常量（渲染层 tsx 禁裸 hex，数据放这里） */
export const SLIDE_DEFAULT_TEXT = "#1f2328";
export const SLIDE_PAGE_WHITE = "#ffffff";
export const SLIDE_PICKER_FALLBACK = "#000000";
export const SLIDE_TABLE_HEADER_FILL = "#1f2937";
export const SLIDE_TABLE_BORDER = "#d0d7de";
