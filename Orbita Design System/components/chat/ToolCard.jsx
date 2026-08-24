import React from "react";
import { Icon } from "../core/Icon.jsx";

const TONE_COLOR = { running: "var(--color-warning)", error: "var(--color-danger)", done: "var(--color-text-tertiary)" };

/** One tool call, collapsed to a single line until clicked. */
export function ToolCard({ name, subtitle, icon = "wrench", tone = "done", status, duration, detail, defaultOpen = false, style }) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [hover, setHover] = React.useState(false);
  return (
    <div style={{ width: "100%", minWidth: 0, borderRadius: "var(--radius-sm)", overflow: "hidden", ...style }}>
      <div style={{ display: "flex", alignItems: "center", minHeight: 32, background: hover ? "color-mix(in srgb, var(--color-bg-hover) 50%, transparent)" : "transparent", transition: "background-color var(--duration-instant) var(--ease-standard)" }}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flex: "1 1 auto", minWidth: 0, minHeight: 32, padding: "6px 10px", border: 0, background: "transparent", color: "var(--color-text-secondary)", fontFamily: "var(--font-family-base)", fontSize: "var(--font-size-control)", lineHeight: "var(--line-height-control)", textAlign: "left", cursor: "pointer" }}
        >
          <span style={{ display: "inline-flex", color: "var(--color-text-tertiary)" }}><Icon name={icon} size={14} strokeWidth={1.8} /></span>
          <span style={{ flex: "0 0 auto", fontWeight: "var(--weight-strong)", fontSize: "var(--font-size-body)", color: "var(--color-text-primary)", textTransform: "lowercase" }}>{name}</span>
          <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-caption)" }}>{subtitle}</span>
          {tone === "running" ? (
            <span style={{ width: 10, height: 10, flex: "0 0 auto", borderRadius: "var(--radius-pill)", border: "2px solid color-mix(in srgb, var(--color-warning) 30%, transparent)", borderTopColor: "var(--color-warning)", animation: "orbita-spin 0.7s linear infinite" }} />
          ) : null}
          {status ? (
            <span style={{ flex: "0 0 auto", color: TONE_COLOR[tone] || TONE_COLOR.done, fontSize: "var(--font-size-micro)", fontFamily: "var(--font-family-business)", fontVariantNumeric: "tabular-nums" }}>{status}</span>
          ) : null}
          {duration ? (
            <span style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)", fontVariantNumeric: "tabular-nums" }}>{duration}</span>
          ) : null}
          <span style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)", transform: open ? "rotate(180deg)" : "none", transition: "transform var(--duration-fast) var(--ease-standard)" }}>
            <Icon name="chevron-down" size={14} strokeWidth={1.8} />
          </span>
        </button>
      </div>
      {open && detail ? (
        <pre style={{ margin: 0, padding: "var(--space-2)", maxHeight: 320, overflow: "auto", borderTop: "1px solid var(--color-border-subtle)", whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-caption)", lineHeight: 1.6, color: "var(--color-text-secondary)" }}>{detail}</pre>
      ) : null}
    </div>
  );
}
