import React from "react";
import { Icon } from "../core/Icon.jsx";

/** Reasoning block, collapsed to one line until clicked. `active` = this block is still streaming. */
export function ThinkingCard({ label = "thinking", subtitle, duration, hint, detail, active = false, defaultOpen = false, style }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ width: "100%", minWidth: 0, borderRadius: "var(--radius-md)", overflow: "hidden", ...style }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", width: "100%", minHeight: 32, padding: "6px 10px", border: 0, background: hover ? "color-mix(in srgb, var(--color-bg-hover) 50%, transparent)" : "transparent", color: "var(--color-text-secondary)", fontFamily: "var(--font-family-base)", fontSize: "var(--font-size-control)", lineHeight: "var(--line-height-control)", textAlign: "left", cursor: "pointer", transition: "background-color var(--duration-instant) var(--ease-standard)" }}
      >
        {/*
          The head is the state: streaming → secondary + orbita-breath (the brain keeps its
          info blue — the only blue mark in the transcript); settled → the whole row recedes
          to tertiary. The subtitle stays tertiary either way; it never breathes.
        */}
        <span className={active ? "orbita-breath" : undefined} style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2)", flex: "0 0 auto" }}>
          <span style={{ color: active ? "var(--color-info)" : "var(--color-text-tertiary)", display: "inline-flex" }}><Icon name="brain" size={14} strokeWidth={1.8} /></span>
          <span style={{ flex: "0 0 auto", fontWeight: "var(--weight-strong)", fontSize: "var(--font-size-body)", color: active ? "var(--color-text-secondary)" : "var(--color-text-tertiary)" }}>{label}</span>
        </span>
        {subtitle ? (
          <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-caption)" }}>{subtitle}</span>
        ) : null}
        {hint ? <em style={{ flex: "1 1 auto", textAlign: "right", color: "var(--color-info)", fontStyle: "normal", fontSize: "var(--font-size-caption)" }}>{hint}</em> : null}
        {duration ? <small style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)", fontVariantNumeric: "tabular-nums" }}>{duration}</small> : null}
        <span style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--duration-fast) var(--ease-standard)" }}>
          <Icon name="chevron-down" size={14} strokeWidth={1.8} />
        </span>
      </button>
      {open && detail ? (
        <div style={{ padding: "var(--space-2) var(--space-3) var(--space-3)", borderTop: "1px solid var(--color-border-subtle)", color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.6, whiteSpace: "pre-wrap", fontFamily: "var(--font-family-mono)", maxHeight: 160, overflow: "auto" }}>{detail}</div>
      ) : null}
    </div>
  );
}
