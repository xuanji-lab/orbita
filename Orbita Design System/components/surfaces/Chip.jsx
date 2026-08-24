import React from "react";

/** Quiet inline control used inside the composer: label, optional icon, optional chevron. */
export function Chip({ icon, children, chevron = false, active = false, disabled = false, onClick, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: 0,
        borderRadius: "var(--radius-md)",
        padding: "3px 8px",
        background: active ? "var(--color-mode-active-bg)" : hover && !disabled ? "var(--color-bg-hover)" : "transparent",
        color: active ? "var(--color-mode-active-fg)" : disabled ? "var(--color-text-tertiary)" : hover ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
        whiteSpace: "nowrap",
        transition: "var(--transition-hover)",
        ...style,
      }}
    >
      {icon}
      {children}
      {chevron ? <span aria-hidden="true" style={{ fontSize: 9, opacity: 0.7, transform: "translateY(1px)" }}>▾</span> : null}
    </button>
  );
}
