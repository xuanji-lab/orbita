import React from "react";

const SIZES = { sm: 32, md: 36 };

const VARIANTS = {
  ghost: { background: "transparent", border: "1px solid transparent" },
  outline: { background: "var(--color-bg-panel)", border: "1px solid var(--color-border-subtle)", boxShadow: "var(--shadow-border)" },
  soft: { background: "var(--color-bg-muted)", border: "1px solid transparent" },
};

export function IconButton({ label, variant = "ghost", buttonSize = "sm", active = false, disabled, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const box = SIZES[buttonSize] || SIZES.sm;
  const tone = VARIANTS[variant] || VARIANTS.ghost;
  return (
    <button
      type="button"
      aria-label={label}
      title={rest.title || label}
      aria-pressed={active || undefined}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        width: box,
        height: box,
        borderRadius: "var(--radius-md)",
        color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "var(--transition-hover)",
        ...tone,
        ...(active ? { background: "var(--color-bg-active)" } : null),
        ...(hover && !disabled ? { background: "var(--color-bg-hover)", color: "var(--color-text-primary)" } : null),
        ...style,
      }}
    >
      {children}
    </button>
  );
}
