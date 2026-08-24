import React from "react";
import { Icon } from "../core/Icon.jsx";

/* The leading slot carries STATUS, so it varies per row and earns its place.
   `running` still maps to the running state on its own. */
const STATUS = {
  running: { icon: "loader-circle", color: "var(--color-accent)", label: "Running", spin: true },
  done: { icon: "check", color: "var(--color-text-tertiary)", label: "Finished" },
  failed: { icon: "triangle-alert", color: "var(--color-danger)", label: "Failed" },
  idle: { icon: null, label: "Idle" },
};

/** One row in the sidebar session list: status, title, last-active time, read-only toggle on hover. */
export function SessionRow({ title, time, status, active = false, running = false, readOnly = false, onClick, onToggleReadOnly, style }) {
  const [hover, setHover] = React.useState(false);
  const state = STATUS[running ? "running" : status] || STATUS.idle;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, ...style }}>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          flex: 1,
          minWidth: 0,
          minHeight: "var(--control-height-md)",
          margin: "2px 0",
          padding: "var(--space-1) var(--space-2) var(--space-1) var(--space-1)",
          border: 0,
          borderRadius: "var(--radius-sm)",
          /* sits directly on layer 1 — hover and active are neutral, never tinted */
          background: active || hover ? "var(--color-bg-hover)" : "transparent",
          color: "var(--color-text-primary)",
          fontWeight: active ? "var(--weight-semibold)" : "var(--weight-regular)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          textAlign: "left",
          cursor: "pointer",
          transition: "var(--transition-hover)",
        }}
      >
        <span title={state.label} style={{ display: "grid", placeItems: "center", width: 13, height: 13, flex: "0 0 auto", color: state.color }}>
          {state.icon ? <Icon name={state.icon} size={13} strokeWidth={1.8} style={state.spin ? { animation: "orbita-spin 1s linear infinite" } : undefined} /> : null}
        </span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        <span style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)", fontFamily: "var(--font-family-business)", fontSize: "var(--font-size-micro)", fontVariantNumeric: "tabular-nums" }}>{time}</span>
      </button>
      <button
        type="button"
        title={readOnly ? "Read-only · click to allow writes" : "Writable · click to make read-only"}
        onClick={onToggleReadOnly}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          border: 0,
          borderRadius: "var(--radius-xs)",
          background: "transparent",
          color: readOnly ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
          cursor: "pointer",
          opacity: hover || readOnly ? 1 : 0,
          transition: "opacity var(--duration-instant) var(--ease-standard)",
        }}
      >
        <Icon name={readOnly ? "lock" : "lock-open"} size={11} strokeWidth={2} />
      </button>
    </div>
  );
}
