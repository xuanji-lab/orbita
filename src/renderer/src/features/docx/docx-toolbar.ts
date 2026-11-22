/**
 * Word 工具条的纯逻辑：窄栏降级、段落样式清单、对齐 / 列表的激活态归一化。
 *
 * **为什么抽出来**：页面里那排按钮只有两种宽度形态（宽 / 窄），样式清单又依赖文档
 * 自己定义的样式表；这两件事都能用值算出来，不必起引擎。`DocxView.tsx` 只负责把
 * folio 的 selection snapshot 翻译成这里的入参，再把命令派发回编辑器。
 *
 * 能力边界（folio 0.62 / 0.30 的类型声明里核实，见 `docs` 的验收报告）：
 * - 段落样式：`applyStyle(styleId)` + `getDocumentStyleResolver(state).getParagraphStyles()`
 * - 对齐：`alignLeft` / `alignCenter` / `alignRight` / `getParagraphAlignment(state)`
 * - 列表：`toggleBulletList` / `toggleNumberedList` + `extractSelectionSnapshot(state).listState`
 */

/** 工具条形态。窄于 `TOOLBAR_COMPACT_BELOW` 时把三档对齐与两种列表收进两个下拉。 */
export type ToolbarDensity = "wide" | "compact";

/**
 * 面板窄到这个值以下就降级（px）。520 是右栏在「稿件布局」里常见的下限附近：
 * 再窄下去，13 个 28px 控件 + 状态 + 保存键会挤掉状态文字。
 */
export const TOOLBAR_COMPACT_BELOW = 520;

/** 一个「段落对齐」在 UI 里的三档（folio 的 start/end/both/distribute 都归到这三档之一） */
export type ToolbarAlignment = "left" | "center" | "right";

/** 工具条认的列表种类；其余（无编号 / 未定义）都算 none */
export type ToolbarList = "none" | "bullet" | "numbered";

/** 段落样式下拉的一项。`id` 是 OOXML 的 styleId，`label` 是文档自己的显示名。 */
export interface StyleChoice {
  id: string;
  label: string;
}

/** 文档里没有样式表时的唯一选项：Normal 是 OOXML 的内建样式，Word 认它。 */
export const FALLBACK_STYLE_CHOICE: StyleChoice = { id: "Normal", label: "Normal" };

/**
 * 宽 / 窄的判定。**宽度 0（还没量到）按宽处理**：首帧先画宽的那一排，量到再降级，
 * 比先画窄的再跳成宽的少一次「按钮突然冒出来」。
 */
export function toolbarDensity(widthPx: number): ToolbarDensity {
  return widthPx > 0 && widthPx < TOOLBAR_COMPACT_BELOW ? "compact" : "wide";
}

/** 窄栏只留一个对齐下拉；宽栏才铺三档按钮 */
export function showsAlignmentButtons(density: ToolbarDensity): boolean {
  return density === "wide";
}

/** 窄栏只留一个列表下拉；宽栏才铺项目符号 / 编号两个按钮 */
export function showsListButtons(density: ToolbarDensity): boolean {
  return density === "wide";
}

/**
 * folio 的段落样式表 → 工具条的下拉项。
 *
 * 只收 `type === "paragraph"` 的项（folio 的 `getParagraphStyles()` 已经过滤过一遍，
 * 这里再挡一次是为了纯函数单独可用）；隐藏样式不收。**没有样式表时只给 Normal**：
 * 给一份假的 Heading 清单会让按钮点下去什么都不变（`applyStyle` 只写 styleId，
 * 样式不存在就没有可解析的格式），那是假按钮。
 */
export function styleChoicesFrom(
  styles: readonly {
    styleId?: unknown;
    name?: unknown;
    type?: unknown;
    hidden?: unknown;
    semiHidden?: unknown;
  }[],
): StyleChoice[] {
  const choices: StyleChoice[] = [];
  const seen = new Set<string>();
  for (const style of styles) {
    if (typeof style.styleId !== "string") continue;
    const id = style.styleId.trim();
    if (id === "" || seen.has(id)) continue;
    if (style.type !== undefined && style.type !== "paragraph") continue;
    if (style.hidden === true || style.semiHidden === true) continue;
    const name = typeof style.name === "string" ? style.name.trim() : "";
    seen.add(id);
    choices.push({ id, label: name === "" ? id : name });
  }
  return choices.length === 0 ? [FALLBACK_STYLE_CHOICE] : choices;
}

/** 下拉触发器上的当前样式名；文档里没有这一项时退回 styleId 本身 */
export function styleLabel(choices: readonly StyleChoice[], styleId: string): string {
  const id = styleId.trim();
  const hit = choices.find((choice) => choice.id === id);
  if (hit !== undefined) return hit.label;
  return id === "" ? FALLBACK_STYLE_CHOICE.label : id;
}

/**
 * folio 的 `ParagraphAlignment` → 工具条三档。
 *
 * `start` / `left` / 缺席都是左对齐（folio 的默认值也是左）；`both` / `distribute`
 * 是两端对齐——这一版只做三档，两端对齐的段落按「左」显示，宁可少一个亮灯，
 * 也不假装支持一个没有按钮的档位。
 */
export function toolbarAlignment(value: unknown): ToolbarAlignment {
  if (value === "center") return "center";
  if (value === "right" || value === "end") return "right";
  return "left";
}

/** folio 的 `ListState.type`（none / bullet / numbered）→ 工具条的两档 + none */
export function toolbarList(value: unknown): ToolbarList {
  if (value === "bullet") return "bullet";
  if (value === "numbered") return "numbered";
  return "none";
}

/** 对齐下拉的图标名（窄栏触发器显示当前对齐） */
export function alignmentIcon(alignment: ToolbarAlignment): "align-left" | "align-center" | "align-right" {
  if (alignment === "center") return "align-center";
  if (alignment === "right") return "align-right";
  return "align-left";
}

/** 列表下拉的图标名（窄栏触发器显示当前列表种类） */
export function listIcon(list: ToolbarList): "list" | "list-ordered" {
  return list === "numbered" ? "list-ordered" : "list";
}
