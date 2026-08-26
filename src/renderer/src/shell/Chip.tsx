import { useState } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * 安静的行内控件：输入卡底栏的作用域/权限/模型，设置面的分段选择，都是它。
 *
 * 选中态用 `--color-mode-active-*`（明主题蓝、暗主题黄），hover 是中性抬升——
 * 这两者是设计系统里 accent 仅有的两个去处之一，别处一律中性。
 */
export function Chip(props: {
  icon?: IconName;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  /** 尾部的下拉指示。**用 lucide 的 chevron-down**——设计系统自己那个 `▾` 是 Unicode 字符，违反它自己的硬规则 */
  chevron?: boolean;
  /** 模型与思考档的标签是斜体次级灰——UI 里唯一的斜体（设计系统 *Type*） */
  italic?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={props.onClick === undefined ? undefined : active}
      disabled={disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: 260,
        padding: "3px 8px",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: active
          ? "var(--color-mode-active-bg)"
          : hover && !disabled
            ? "var(--color-bg-hover)"
            : "transparent",
        color: active
          ? "var(--color-mode-active-fg)"
          : disabled
            ? "var(--color-text-tertiary)"
            : hover
              ? "var(--color-text-primary)"
              : "var(--color-text-secondary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontStyle: props.italic === true ? "italic" : "normal",
        letterSpacing: props.italic === true ? "var(--tracking-model)" : "normal",
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : props.onClick === undefined ? "default" : "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      {props.icon !== undefined && <Icon name={props.icon} size={12} />}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {props.children}
      </span>
      {props.chevron === true && <Icon name="chevron-down" size={11} strokeWidth={2} />}
    </button>
  );
}
