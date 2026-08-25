import { useState } from "react";

/**
 * 纯图标控件（设计系统 `components/core/IconButton.jsx` 的移植）。
 *
 * 两条硬规则落在这里：
 *  - **hover 是中性抬升**：填 `--color-bg-hover`、文字从 secondary 升到 primary，不染 accent、不位移
 *  - **玻璃上禁用不用 opacity**：调暗的字在半透明面上既不是墨也不是壁纸，改用实色 tertiary
 */
export function IconButton(props: {
  label: string;
  onClick?: () => void;
  size?: number;
  /** soft = 一层极轻的面（设计系统模板里右图标条用的就是它）；默认 ghost 完全透明 */
  variant?: "ghost" | "soft";
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  const [hover, setHover] = useState(false);
  const box = props.size ?? 32;
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.title ?? props.label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        width: box,
        height: box,
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-md)",
        background: active
          ? "var(--color-mode-active-bg)"
          : hover && !disabled
            ? "var(--color-bg-hover)"
            : props.variant === "soft"
              ? "var(--color-bg-muted)"
              : "transparent",
        color: disabled
          ? "var(--color-text-tertiary)"
          : active
            ? "var(--color-mode-active-fg)"
            : hover
              ? "var(--color-text-primary)"
              : "var(--color-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "var(--transition-hover)",
        ...props.style,
      }}
    >
      {props.children}
    </button>
  );
}
