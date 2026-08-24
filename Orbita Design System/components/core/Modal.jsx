import React from "react";
import { IconButton } from "./IconButton.jsx";
import { Icon } from "./Icon.jsx";

const WIDTH = { full: "min(1300px, calc(100% - 48px))", medium: "min(800px, calc(100% - 48px))", small: "min(480px, calc(100% - 48px))" };

export function Modal({ open, onClose, title, size = "medium", children, style }) {
  if (!open) return null;
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "grid", placeItems: "center", background: "var(--overlay-backdrop)" }} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: WIDTH[size] || WIDTH.medium,
          maxHeight: size === "full" ? "min(850px, calc(100% - 48px))" : "calc(100% - 48px)",
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-4)",
          padding: "var(--space-6)",
          border: "1px solid var(--color-border-subtle)",
          borderRadius: "var(--radius-lg)",
          background: "var(--color-bg-panel)",
          boxShadow: "var(--shadow-modal)",
          ...style,
        }}
      >
        {title ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-4)" }}>
            <h2 style={{ margin: 0, fontFamily: "var(--font-family-base)", fontSize: "var(--font-size-title)", fontWeight: "var(--weight-semibold)", color: "var(--color-text-primary)" }}>{title}</h2>
            <IconButton label="Close" buttonSize="md" onClick={onClose}>
              <Icon name="x" size={18} strokeWidth={2.2} />
            </IconButton>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
