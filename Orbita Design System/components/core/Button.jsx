import React from "react";

const SIZES = { sm: { height: 32, padding: "0 12px", gap: 6 }, md: { height: 36, padding: "8px 16px", gap: 8 } };

const VARIANTS = {
  primary: { background: "var(--color-text-primary)", color: "var(--color-text-inverse)", border: "1px solid transparent" },
  secondary: { background: "var(--color-bg-muted)", color: "var(--color-text-primary)", border: "1px solid var(--color-border-subtle)" },
  danger: { background: "var(--color-danger)", color: "#fff", border: "1px solid transparent" },
  ghost: { background: "transparent", color: "var(--color-text-primary)", border: "1px solid transparent" },
  accent: { background: "var(--color-accent)", color: "var(--color-accent-fg)", border: "1px solid transparent" },
};

const HOVER = {
  primary: "color-mix(in srgb, var(--color-text-primary) 90%, transparent)",
  secondary: "var(--color-bg-hover)",
  danger: "color-mix(in srgb, var(--color-danger) 90%, transparent)",
  ghost: "var(--color-bg-hover)",
  accent: "var(--color-accent-strong)",
};

export function Button({ variant = "secondary", buttonSize = "md", loading = false, disabled, children, style, ...rest }) {
  const [hover, setHover] = React.useState(false);
  const size = SIZES[buttonSize] || SIZES.md;
  const tone = VARIANTS[variant] || VARIANTS.secondary;
  const off = disabled || loading;
  return (
    <button
      type="button"
      disabled={off}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        whiteSpace: "nowrap",
        gap: size.gap,
        height: size.height,
        padding: size.padding,
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-body)",
        fontWeight: "var(--weight-medium)",
        cursor: off ? "not-allowed" : "pointer",
        opacity: off ? 0.5 : 1,
        transition: "var(--transition-hover)",
        ...tone,
        ...(hover && !off ? { background: HOVER[variant] } : null),
        ...style,
      }}
    >
      {loading && (
        <span
          style={{
            width: 14,
            height: 14,
            borderRadius: "var(--radius-pill)",
            border: "2px solid currentColor",
            borderTopColor: "transparent",
            animation: "orbita-spin 0.7s linear infinite",
          }}
        />
      )}
      {children}
    </button>
  );
}
