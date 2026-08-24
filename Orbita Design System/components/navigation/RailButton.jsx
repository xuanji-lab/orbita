import React from "react";

/** 32px icon-only control in the collapsed 48px sidebar rail. */
export function RailButton({ children, title, active = false, disabled = false, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  const Tag = disabled ? "span" : "button";
  return (
    <Tag
      type={disabled ? undefined : "button"}
      title={title}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 32,
        height: 32,
        border: 0,
        borderRadius: "var(--radius-md)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        background: active ? "var(--color-mode-active-bg)" : hover && !disabled ? "var(--color-bg-hover)" : "transparent",
        color: active ? "var(--color-mode-active-fg)" : disabled ? "var(--color-text-tertiary)" : "var(--color-text-secondary)",
        transition: "var(--transition-hover)",
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
