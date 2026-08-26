import type { CSSProperties } from "react";

/**
 * **选择态：一条规则，一处定义。**
 *
 * 「未选中 / hover / 选中」这三个状态在侧栏会话行、设置 tab、菜单项里是同一件事，
 * 之前各写各的——结果 hover 对上了、选中没对上：侧栏的选中是 accent 淡底，
 * 菜单里的选中只有一个 check 图标，没有底。
 *
 * | 状态 | 底 | 文字 | 字重 |
 * |---|---|---|---|
 * | 未选中 | 透明 | primary | regular |
 * | hover | `--option-hover-bg` | primary | regular |
 * | 选中 | `--option-active-bg` | primary | **semibold** |
 * | 选中 + hover | 同「选中」 | primary | semibold |
 * | 禁用 | 透明 | **tertiary（实色）** | regular |
 *
 * 两条取舍：
 * - **选中盖过 hover。** 选中是持久事实，hover 是临时的；让临时状态盖掉持久状态，
 *   会让人以为自己把选中弄丢了。
 * - **禁用用实色 tertiary 而不是 opacity。** 玻璃上调暗的字既不是墨也不是壁纸
 *   （设计系统 *Hover, press, disabled*）。
 *
 * 两个**不**走这条规则的地方，都是设计系统点名的：
 * - 侧栏的 Agent / Orchestrate 芯片——readme 明写「the selected mode reads blue on
 *   the light theme and yellow on the dark」，它的选中是 accent **文字**。
 * - 输入卡底栏的芯片——它的 `active` 指「菜单正开着」，是临时状态，不是选中。
 */
export function selectionStyle(state: {
  selected?: boolean;
  hover?: boolean;
  disabled?: boolean;
}): Pick<CSSProperties, "background" | "color" | "fontWeight" | "transition"> {
  const disabled = state.disabled === true;
  const selected = state.selected === true && !disabled;
  const hover = state.hover === true && !disabled;
  return {
    background: selected ? "var(--option-active-bg)" : hover ? "var(--option-hover-bg)" : "transparent",
    color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
    fontWeight: selected ? "var(--weight-semibold)" : "var(--weight-regular)",
    transition: "var(--transition-hover)",
  };
}
