import { Icon } from "../../shell/Icon";

/**
 * 设置页的三种控件（2026-10-30，一体化审计「设置项」「控件台阶」两个模式）：
 * 分段、开关、下拉各只有一种长相，高度取台阶——外框 28（--control-height-sm），
 * 里面的段 24（--control-height-xs）。样式是 styles.css 的三个配方
 * （.seg-control / .switch-control / .select-control）。
 *
 * 以前一个设置页上「开 / 关」是两个芯片、「English / 中文」是两个芯片、模型下拉是一个带
 * 箭头的芯片，模型服务页的「大 / 小」又是另一种带框的分段（32 高）：选中态有的是模式色
 * （暗色主题下黄字）、有的是选中底 + 黑字，高度 24 / 26 / 32 各一种。
 */

/** 分段：几个互斥的值并排，外框一圈发丝；选中段铺选中底 + 主墨色 + 半粗（与选中行同一套） */
export function Segmented<T extends string | number | boolean>(props: {
  /** 整组的可读名 */
  label: string;
  value: T;
  options: readonly { value: T; label: React.ReactNode; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span
      className={props.className === undefined ? "seg-control" : `seg-control ${props.className}`}
      role="group"
      aria-label={props.label}
    >
      {props.options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          aria-pressed={option.value === props.value}
          title={option.title}
          disabled={props.disabled}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/**
 * 开关：只有开 / 关两档的设置。以前是「开」「关」两个芯片（设计系统那时没有 Switch）；
 * 两个芯片要读两个词才知道现在是哪档，开关一眼就是。开 = accent 底（与勾选框的
 * accent-color 同一个意思：选中），关 = 发丝描边的空槽。点击区 24 高，轨道 28 × 16。
 */
export function Switch(props: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch-control"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    />
  );
}

/** 下拉的触发键：与分段同一圈发丝、同高 28，字 sm、尾巴一个 12 的 chevron；打开时铺选中底 */
export function SelectButton(props: {
  open: boolean;
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="select-control"
      aria-expanded={props.open}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <span className="select-control-label">{props.children}</span>
      <Icon name="chevron-down" size={12} strokeWidth={2} />
    </button>
  );
}
