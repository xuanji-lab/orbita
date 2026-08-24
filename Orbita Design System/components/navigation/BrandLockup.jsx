import React from "react";

/** Sidebar wordmark. No logo mark exists yet — the name is set in the brand serif. */
export function BrandLockup({ size = 22, style }) {
  return (
    <div aria-label="orbita" style={{ display: "inline-flex", alignItems: "center", gap: 10, height: 34, minWidth: 0, lineHeight: 0, color: "var(--color-text-primary)", ...style }}>
      <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", height: 34, fontFamily: "var(--font-family-brand)", fontSize: size, lineHeight: 1, fontWeight: 500, letterSpacing: "0.01em" }}>
        orbita
      </span>
    </div>
  );
}
