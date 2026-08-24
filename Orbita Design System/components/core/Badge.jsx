import React from "react";

const VARIANTS = {
  secondary: { background: "var(--color-bg-muted)", color: "var(--color-text-primary)", borderColor: "transparent" },
  outline: { background: "transparent", color: "var(--color-text-primary)", borderColor: "var(--color-border-subtle)" },
  muted: { background: "var(--color-bg-muted)", color: "var(--color-text-secondary)", borderColor: "transparent" },
  accent: { background: "var(--color-bg-muted)", color: "var(--color-accent)", borderColor: "color-mix(in srgb, var(--color-accent) 24%, var(--color-border-subtle))" },
  info: { background: "color-mix(in srgb, var(--color-info) 10%, var(--color-bg-panel))", color: "var(--color-info)", borderColor: "color-mix(in srgb, var(--color-info) 20%, var(--color-border-subtle))" },
};

export function Badge({ variant = "secondary", badgeSize = "sm", mono = false, children, style, ...rest }) {
  const tone = VARIANTS[variant] || VARIANTS.secondary;
  return (
    <span
      {...rest}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        width: "fit-content",
        whiteSpace: "nowrap",
        padding: badgeSize === "md" ? "4px 10px" : "2px 8px",
        border: "1px solid",
        borderRadius: "var(--radius-md)",
        fontFamily: mono ? "var(--font-family-business)" : "var(--font-family-base)",
        fontSize: "var(--font-size-micro)",
        fontWeight: "var(--weight-semibold)",
        lineHeight: 1.4,
        ...tone,
        ...style,
      }}
    >
      {children}
    </span>
  );
}
