import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * The input box. One treatment everywhere: a layer-3 glass card. It carries the
 * home screen, then glides to the bottom of the chat page — the width, surface
 * and radius never change, only the vertical position.
 *
 * Radius follows the surface: as a glass card it takes --radius-xl (10px), the
 * same as every other glass surface in the system.
 */
export function Composer({
  value = "",
  onChange,
  onSubmit,
  placeholder = "Ask anything, or start a task",
  topSlot,
  bottomSlot,
  rows = 2,
  disabled = false,
  running = false,
  style,
}) {
  const [hover, setHover] = React.useState(false);
  const send = () => {
    if (!disabled && value.trim() && onSubmit) onSubmit(value.trim());
  };
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 8px",
        borderRadius: "var(--radius-xl)",
        background: "var(--glass-bg)",
        border: "1px solid var(--glass-border)",
        boxShadow: "var(--shadow-composer)",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        backdropFilter: "blur(var(--glass-blur))",
        ...style,
      }}
    >
      {topSlot ? <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>{topSlot}</div> : null}
      <textarea
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange && onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        style={{
          width: "100%",
          border: 0,
          background: "transparent",
          resize: "none",
          outline: "none",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-input)",
          lineHeight: "var(--line-height-input)",
          color: "var(--color-text-primary)",
          padding: "2px 4px",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {bottomSlot}
        <button
          type="button"
          aria-label={running ? "Stop" : "Send"}
          title={running ? "Stop" : "Send"}
          onClick={send}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            border: 0,
            borderRadius: "var(--radius-pill)",
            background: running ? "color-mix(in srgb, var(--color-danger) 8%, transparent)" : hover ? "var(--color-accent-strong)" : "var(--color-accent)",
            color: running ? "var(--color-danger)" : "var(--color-accent-fg)",
            cursor: "pointer",
            transition: "var(--transition-hover)",
          }}
        >
          <Icon name={running ? "square" : "arrow-up"} size={16} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
