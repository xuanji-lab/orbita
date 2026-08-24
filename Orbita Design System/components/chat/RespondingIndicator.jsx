import React from "react";

/** Streaming status line under the last turn. */
export function RespondingIndicator({ label = "Responding", tone = "running", style }) {
  const color = tone === "error" ? "var(--color-danger)" : tone === "waiting" ? "var(--color-text-secondary)" : "var(--color-text-secondary)";
  const dot = tone === "error" ? "var(--color-danger)" : tone === "waiting" ? "var(--color-text-tertiary)" : "var(--color-warning)";
  return (
    <p
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: 0,
        padding: "8px 12px",
        minHeight: 36,
        boxSizing: "border-box",
        border: "1px solid var(--color-border-subtle)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-muted)",
        color,
        fontSize: "var(--font-size-control)",
        transition: "border-color 0.25s ease, background-color 0.25s ease, color 0.25s ease",
        ...style,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: "var(--radius-pill)", border: `2px solid color-mix(in srgb, ${dot} 30%, transparent)`, borderTopColor: dot, animation: tone === "running" ? "orbita-spin 0.7s linear infinite" : "none" }} />
      {label}
    </p>
  );
}
