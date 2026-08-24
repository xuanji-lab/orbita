import React from "react";

/** Mode selector in the expanded sidebar: Agent (current) / Orchestrate. */
export function ModeChip({ icon, children, active = false, disabled = false, onClick, style }) {
  const [hover, setHover] = React.useState(false);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        flex: 1,
        border: 0,
        borderRadius: "var(--radius-md)",
        padding: "4px 8px",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontWeight: "var(--weight-medium)",
        cursor: disabled ? "default" : "pointer",

        background: active ? "var(--color-mode-active-bg)" : hover && !disabled ? "var(--color-bg-hover)" : "transparent",
        /* layer-1 text stays at full strength — a dimmed tertiary over glass
           reads as neither the theme's ink nor the wallpaper behind it */
        color: active ? "var(--color-mode-active-fg)" : "var(--color-text-primary)",
        opacity: 1,
        transition: "var(--transition-hover)",
        ...style,
      }}
    >
      {icon}
      {children}
    </button>
  );
}
